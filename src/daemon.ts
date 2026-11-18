import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { GitHub, repositoryGit, signed, type Repository } from './github.ts';
import { dockerVerify, replay, runFix, validateConfig } from './lab.ts';
import { modelProvider } from './model.ts';

type Settings = { repositories: Repository[]; since: string; pollSeconds?: number; port?: number };
type Job = { id: string; repo: number; issue: number; event: number; stage: string; attempts: number; evidence?: string;
  ticketHash?: string; base?: string; commitSha?: string; branch?: string; started: string; due: number; result?: string };
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function checkSettings(settings: Settings) {
  if (!settings || !Number.isFinite(Date.parse(settings.since)) || !Array.isArray(settings.repositories) || !settings.repositories.length
      || (settings.pollSeconds !== undefined && (!positive(settings.pollSeconds) || settings.pollSeconds < 60))
      || (settings.port !== undefined && (!positive(settings.port) || settings.port > 65535))) throw new Error('Invalid daemon settings.');
  const ids = new Set<number>();
  for (const repository of settings.repositories) {
    if (!repository || !positive(repository.id) || ids.has(repository.id) || !positive(repository.installation)
        || typeof repository.name !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository.name)
        || ['.', '..'].includes(repository.name.split('/')[1])
        || typeof repository.label !== 'string' || !repository.label.trim() || repository.label.includes(',')
        || !Array.isArray(repository.approvers) || !repository.approvers.length || !repository.approvers.every(positive)
        || !['patch', 'draft-pr'].includes(repository.delivery)) throw new Error('Invalid repository settings.');
    ids.add(repository.id);
    validateConfig(repository.checks);
  }
}

export class Queue {
  db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deliveries (digest TEXT PRIMARY KEY, repo INTEGER, issue INTEGER, due INTEGER, failures INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, repo INTEGER NOT NULL, issue INTEGER NOT NULL, event INTEGER NOT NULL,
        stage TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, evidence TEXT,
        ticketHash TEXT, base TEXT, commitSha TEXT, branch TEXT, result TEXT,
        started TEXT NOT NULL, due INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
  receive(digest: string, repo: number, issue: number) {
    this.db.prepare('INSERT OR IGNORE INTO deliveries(digest,repo,issue,due) VALUES (?,?,?,0)').run(digest, repo, issue);
  }
  dispatch(repo: number, issue: number, event: number) {
    const id = [repo, issue, event].join('-');
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,repo,issue,event,stage,started) VALUES (?,?,?,?,'queued',?)")
      .run(id, repo, issue, event, new Date().toISOString());
    return id;
  }
  next() {
    return this.db.prepare("SELECT * FROM jobs WHERE stage IN ('queued','verified','branch','creating') AND due <= ? ORDER BY rowid LIMIT 1")
      .get(Date.now()) as Job | undefined;
  }
  finish(id: string, stage: string, result: string) {
    this.db.prepare('UPDATE jobs SET stage=?,result=? WHERE id=?').run(stage, result, id);
  }
  defer(job: Job) {
    if (job.attempts >= 4) {
      this.finish(job.id, job.stage === 'creating' || job.stage === 'branch' ? 'needs-review' : 'blocked', 'Retry budget exhausted.');
    } else {
      this.db.prepare('UPDATE jobs SET attempts=attempts+1,due=? WHERE id=?')
        .run(Date.now() + 30_000 * 2 ** job.attempts, job.id);
    }
  }
}

async function webhook(request: IncomingMessage, settings: Settings, queue: Queue, secret: string) {
  if (request.method !== 'POST' || request.url !== '/github/webhook') return 404;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512_000) return 413;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const signature = request.headers['x-hub-signature-256'];
  if (typeof signature !== 'string' || !signed(body, signature, secret)) return 401;
  if (request.headers['x-github-event'] !== 'issues') return 204;
  let event;
  try { event = JSON.parse(body.toString()); } catch { return 400; }
  const repository = settings.repositories.find(repo => repo.id === event?.repository?.id && repo.installation === event?.installation?.id);
  if (repository && event.action === 'labeled' && event.label?.name === repository.label
      && repository.approvers.includes(event.sender?.id) && positive(event.issue?.number)) {
    queue.receive(hash(body), repository.id, event.issue.number);
  }
  return 204;
}

export function webhookServer(settings: Settings, queue: Queue, secret: string) {
  return createServer(async (request, response) => {
    try { response.writeHead(await webhook(request, settings, queue, secret)).end(); }
    catch { response.writeHead(500).end(); }
  });
}

function status(queue: Queue, id: string) {
  return queue.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Job;
}
const issueText = (ticket: { title: string; body: string | null }) => ticket.title + '\n\n' + (ticket.body ?? '');

export async function processJob(queue: Queue, job: Job, repository: Repository, github: GitHub, cutoff: number,
  root: string, propose: ReturnType<typeof modelProvider>,
  services = { git: repositoryGit, verify: dockerVerify }) {
  const prefix = '/repos/' + repository.name;
  const read = await github.token(repository);
  if (job.stage === 'creating') {
    // An earlier request may have succeeded even if its response was lost.
    const existing = await github.findPull(repository, job.branch!, job.base!, read, job.commitSha!, job.id);
    if (existing) queue.finish(job.id, 'delivered', existing);
    else queue.defer(job);
    return;
  }
  const approved = await github.approval(repository, job.issue, read, cutoff);
  if (!approved || approved.event !== job.event) return queue.finish(job.id, 'ineligible', 'Issue authorization changed.');
  const text = issueText(approved.ticket);
  const metadata = await github.request(prefix, read);
  if (metadata.id !== repository.id || metadata.archived || metadata.disabled) {
    return queue.finish(job.id, 'ineligible', 'Repository unavailable.');
  }
  const base: string = metadata.default_branch;
  if (typeof base !== 'string' || !base) throw new Error('Repository has no default branch.');
  const url = 'https://github.com/' + repository.name + '.git';
  const scratch = mkdtempSync(join(tmpdir(), 'bugfix-github-'));
  const checkout = join(scratch, 'repo');
  try {
    if (job.stage === 'queued') {
      await services.git(scratch, ['clone', '--quiet', '--no-tags', '--single-branch', '--branch=' + base, '--', url, checkout], { token: read });
      const result = await runFix({ repository: checkout, issue: text, config: repository.checks, output: join(root, 'runs') },
        { verify: services.verify, propose });
      if (result.status !== 'verified' || repository.delivery !== 'draft-pr') {
        queue.finish(job.id, result.status, result.directory);
        return;
      }
      queue.db.prepare("UPDATE jobs SET stage='verified',evidence=?,ticketHash=?,base=?,attempts=0,due=0 WHERE id=?")
        .run(result.directory, hash(text), base, job.id);
      job = status(queue, job.id);
    }

    if (repository.delivery !== 'draft-pr' || job.ticketHash !== hash(text) || job.base !== base) {
      return queue.finish(job.id, 'ineligible', 'Delivery mode, issue text, or default branch changed.');
    }
    const seal = replay(job.evidence!);
    if (!seal.complete || seal.result.status !== 'verified') throw new Error('Candidate evidence is incomplete.');
    const frozen = JSON.parse(readFileSync(join(job.evidence!, 'snapshot-1.json'), 'utf8'));
    if (JSON.stringify(frozen.config) !== JSON.stringify(repository.checks)) {
      return queue.finish(job.id, 'ineligible', 'Verification policy changed.');
    }
    const ref = await github.request(prefix + '/git/ref/heads/' + encodeURIComponent(base), read);
    if (ref.object?.sha !== seal.result.base) return queue.finish(job.id, 'ineligible', 'Verified base advanced.');
    const branch = 'bugfix-lab/' + job.id;
    const branchPath = prefix + '/git/ref/heads/bugfix-lab/' + job.id;
    const remote = await github.request(branchPath, read, undefined, true);
    if (remote && remote.object?.sha !== job.commitSha) {
      return queue.finish(job.id, 'needs-review', 'Delivery branch already points to an unexpected commit.');
    }
    if (!remote) {
      if (job.stage !== 'verified') return queue.finish(job.id, 'needs-review', 'Push outcome is unknown. Check the branch before retrying.');
      if (!job.evidence) throw new Error('Missing verified evidence path.');
      const publishPath = join(scratch, 'publish');
      await services.git(scratch, ['clone', '--quiet', '--no-tags', '--single-branch', '--branch=' + base, '--', url, publishPath], { token: read });
      if (await services.git(publishPath, ['rev-parse', 'HEAD']) !== seal.result.base) {
        return queue.finish(job.id, 'ineligible', 'Verified base advanced.');
      }
      const patch = join(job.evidence, 'verified.patch');
      await services.git(publishPath, ['apply', '--index', '--binary', '--', patch]);
      const actual = await services.git(publishPath, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', seal.result.base, '--'], { raw: true });
      if (hash(actual) !== seal.result.candidate) throw new Error('Staged candidate identity mismatch.');
      const tree = await services.git(publishPath, ['write-tree']);
      const commit = await services.git(publishPath, ['commit-tree', tree, '-p', seal.result.base, '-m', 'Fix functional issue #' + job.issue],
        { timestamp: job.started });
      const approval = await github.approval(repository, job.issue, read, cutoff);
      if (approval?.event !== job.event || hash(issueText(approval.ticket)) !== job.ticketHash) {
        return queue.finish(job.id, 'ineligible', 'Issue authorization changed before push.');
      }
      const write = await github.token(repository, true);
      queue.db.prepare("UPDATE jobs SET stage='branch',commitSha=?,branch=?,attempts=0,due=0 WHERE id=?").run(commit, branch, job.id);
      await services.git(publishPath, ['push', '--force-with-lease=refs/heads/' + branch + ':', '--', url, commit + ':refs/heads/' + branch], { token: write });
      job = status(queue, job.id);
    }

    const current = await github.approval(repository, job.issue, read, cutoff);
    const head = await github.request(branchPath, read);
    const latestBase = await github.request(prefix + '/git/ref/heads/' + encodeURIComponent(base), read);
    if (current?.event !== job.event || hash(issueText(current.ticket)) !== job.ticketHash
        || latestBase.object?.sha !== seal.result.base || head.object?.sha !== job.commitSha) {
      return queue.finish(job.id, 'needs-review', 'Authorization or candidate identity changed after push.');
    }
    const existing = await github.findPull(repository, branch, base, read, job.commitSha!, job.id);
    if (existing) return queue.finish(job.id, 'delivered', existing);
    const write = await github.token(repository, true);
    queue.finish(job.id, 'creating', 'Draft PR request prepared.');
    await github.request(prefix + '/pulls', write, {
      head: branch, base, draft: true, title: 'Fix functional issue #' + job.issue,
      body: 'Proposed fix for #' + job.issue + '.\n\nThe configured regression reproduced on the baseline and all required checks passed for this candidate. Review the patch before merging.\n\n<!-- bugfix-lab:' + job.id + ' -->',
    });
    const created = await github.findPull(repository, branch, base, read, job.commitSha!, job.id);
    if (created) queue.finish(job.id, 'delivered', created);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const [file, directory] = process.argv.slice(2);
  if (!file || !directory) throw new Error('Usage: node src/daemon.ts DEPLOYMENT.json STATE_DIR');
  process.umask(0o077);
  const settings: Settings = JSON.parse(readFileSync(file, 'utf8'));
  checkSettings(settings);
  const secret = process.env.BUGFIX_WEBHOOK_SECRET;
  const app = process.env.BUGFIX_GITHUB_APP_ID;
  const key = process.env.BUGFIX_GITHUB_KEY_FILE;
  if (!secret || !app || !key) throw new Error('Set BUGFIX_WEBHOOK_SECRET, BUGFIX_GITHUB_APP_ID, and BUGFIX_GITHUB_KEY_FILE.');
  const propose = modelProvider();
  const github = new GitHub(app, readFileSync(key, 'utf8'));
  github.jwt();
  const cutoff = Date.parse(settings.since);
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // A separate write lock preserves one worker across restarts and is released by the OS.
  const lock = new DatabaseSync(join(root, 'worker-lock.sqlite'));
  lock.exec('BEGIN EXCLUSIVE');
  const queue = new Queue(join(root, 'queue.sqlite'));
  const server = webhookServer(settings, queue, secret);
  await new Promise<void>((bound, rejected) => {
    server.once('error', rejected);
    server.listen(settings.port ?? 4318, '127.0.0.1', bound);
  });
  let pollAt = 0;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    stopping = true;
    server.close();
  });
  try {
    while (!stopping) {
      const delivery = queue.db.prepare('SELECT * FROM deliveries WHERE due <= ? ORDER BY rowid LIMIT 1').get(Date.now());
      if (delivery) {
        const repo = settings.repositories.find(item => item.id === delivery.repo);
        try {
          if (repo) {
            const approved = await github.approval(repo, Number(delivery.issue), await github.token(repo), cutoff);
            if (approved) queue.dispatch(repo.id, Number(delivery.issue), approved.event);
          }
          queue.db.prepare('UPDATE deliveries SET due=? WHERE digest=?').run(Number.MAX_SAFE_INTEGER, delivery.digest);
        } catch {
          const failures = Number(delivery.failures) + 1;
          queue.db.prepare('UPDATE deliveries SET due=?,failures=? WHERE digest=?')
            .run(failures > 5 ? Number.MAX_SAFE_INTEGER : Date.now() + 30_000 * 2 ** failures, failures, delivery.digest);
        }
      }
      const job = queue.next();
      if (job) {
        const repo = settings.repositories.find(item => item.id === job.repo);
        if (!repo) queue.finish(job.id, 'ineligible', 'Repository removed from settings.');
        else {
          try { await processJob(queue, job, repo, github, cutoff, root, propose); }
          catch (error) {
            console.error('Job', job.id, error instanceof Error ? error.message : 'failed');
            queue.defer(status(queue, job.id));
          }
        }
      }
      if (Date.now() >= pollAt && !stopping) {
        pollAt = Date.now() + (settings.pollSeconds ?? 900) * 1000;
        for (const repo of settings.repositories) {
          try {
            const token = await github.token(repo);
            const query = new URLSearchParams({ state: 'open', labels: repo.label, since: settings.since });
            const tickets = await github.list('/repos/' + repo.name + '/issues?' + query, token);
            for (const ticket of tickets) {
              if (!ticket.pull_request && positive(ticket.number)) {
                queue.receive(hash(['poll', repo.id, ticket.number, ticket.updated_at].join(':')), repo.id, ticket.number);
              }
            }
          } catch { console.error('Reconciliation scan failed for', repo.name); }
        }
      }
      if (!job && !delivery && !stopping) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    server.close();
    queue.db.close();
    lock.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
