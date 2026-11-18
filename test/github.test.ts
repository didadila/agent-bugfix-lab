import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Queue, processJob, webhookServer } from '../src/daemon.ts';
import { authorization, GitHub, repositoryGit, type Repository } from '../src/github.ts';

const repo: Repository = {
  id: 10, name: 'owner/fixture', installation: 11, approvers: [12], label: 'agent-fix', delivery: 'draft-pr',
  checks: { image: 'node@sha256:' + '0'.repeat(64), editable: ['total.js'],
    regression: { id: 'total', argv: ['node', 'check.js'], failureMarker: 'EXPECTED_TOTAL' } },
};
const since = '2026-01-01T00:00:00Z';

test('label authorization checks the newest event, actor, and cutoff', () => {
  const labeled = { id: 1, event: 'labeled', label: { name: repo.label }, actor: { id: 12 }, created_at: since };
  assert.equal(authorization([labeled], repo, Date.parse(since)), 1);
  assert.equal(authorization([labeled, { ...labeled, id: 2, event: 'unlabeled' }], repo, 0), undefined);
  assert.equal(authorization([{ ...labeled, actor: { id: 99 } }], repo, 0), undefined);
  assert.equal(authorization([labeled], repo, Date.parse(since) + 1), undefined);
});

test('webhook persists signed maintainer labels and deduplicates deliveries and jobs', async t => {
  const queue = new Queue(':memory:');
  const server = webhookServer({ since, repositories: [repo] }, queue, 'fixture-secret');
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.close(); queue.db.close(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const request = (actor: number, valid = true) => {
    const body = JSON.stringify({ repository: { id: repo.id }, installation: { id: repo.installation },
      action: 'labeled', label: { name: repo.label }, issue: { number: 3 }, sender: { id: actor } });
    const signature = createHmac('sha256', 'fixture-secret').update(body).digest('hex');
    return fetch('http://127.0.0.1:' + address.port + '/github/webhook', {
      method: 'POST', body, headers: { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=' + (valid ? signature : '0'.repeat(64)) },
    });
  };
  assert.equal((await request(12, false)).status, 401);
  assert.equal((await request(99)).status, 204);
  assert.equal((await request(12)).status, 204);
  assert.equal((await request(12)).status, 204);
  assert.equal(queue.db.prepare('SELECT count(*) AS n FROM deliveries').get()?.n, 1);
  assert.equal(queue.dispatch(10, 3, 1), queue.dispatch(10, 3, 1));
  assert.equal(queue.db.prepare('SELECT count(*) AS n FROM jobs').get()?.n, 1);
});

test('worker publishes only the verified tree and reconciles a lost draft PR response after restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bugfix-delivery-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  mkdirSync(source);
  const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' }).toString().trim();
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'total.js'), 'exports.total = (a,b) => a-b;\n');
  writeFileSync(join(source, 'check.js'), 'if (require("./total.js").total(2,3) !== 5) { console.error("EXPECTED_TOTAL"); process.exit(1); }\n');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  git(root, 'clone', '--bare', source, remote);
  const base = git(source, 'rev-parse', 'HEAD');
  let pr: { draft: boolean; body: string } | undefined;
  let prRequests = 0;
  const approved = { event: 1, ticket: { number: 3, title: 'Totals subtract', body: null, state: 'open', labels: [{ name: repo.label }] } };
  class FixtureGitHub extends GitHub {
    async token() { return 'fixture'; }
    async approval() { return approved; }
    async request(path: string, _token: string, body?: object, missing?: boolean) {
      if (path.endsWith('/pulls')) {
        prRequests++;
        pr = body as typeof pr;
        assert.equal(pr?.draft, true);
        throw new Error('Simulated lost response');
      }
      if (path.endsWith('heads/main')) return { object: { sha: base } };
      if (path.includes('/git/ref/heads/bugfix-lab/')) {
        try {
          const branch = path.split('/heads/')[1];
          return { object: { sha: git(remote, 'rev-parse', branch) } };
        } catch (error) { if (missing) return null; throw error; }
      }
      return { id: 10, default_branch: 'main' };
    }
    async findPull() { return pr ? 'https://github.com/owner/fixture/pull/2' : undefined; }
  }
  const services = {
    git(path: string, args: string[], options?: Parameters<typeof repositoryGit>[2]) {
      return repositoryGit(path, args.map(arg => arg === 'https://github.com/owner/fixture.git' ? remote : arg),
        { ...options, token: undefined });
    },
    async verify(path: string) {
      try {
        execFileSync(process.execPath, ['check.js'], { cwd: path, stdio: 'pipe' });
        return { status: 0, output: '' };
      } catch (error) {
        return { status: error.status, output: error.stderr.toString() };
      }
    },
  };
  const propose = async () => [{ path: 'total.js', content: 'exports.total = (a,b) => a+b;\n' }];
  const db = join(root, 'queue.sqlite');
  let queue = new Queue(db);
  const id = queue.dispatch(repo.id, 3, 1);
  const github = new FixtureGitHub('', '');
  await assert.rejects(processJob(queue, queue.next()!, repo, github, 0, root, propose, services), /lost response/);
  assert.equal(git(remote, 'show', 'bugfix-lab/' + id + ':total.js'), 'exports.total = (a,b) => a+b;');
  queue.db.close();
  queue = new Queue(db);
  assert.equal(queue.next()?.stage, 'creating');
  await processJob(queue, queue.next()!, repo, github, 0, root, propose, services);
  assert.equal(queue.db.prepare('SELECT stage FROM jobs WHERE id=?').get(id)?.stage, 'delivered');
  assert.equal(prRequests, 1);
  queue.db.close();
});

test('GitHub approval rechecks the label actor’s current write access', async () => {
  let permission = 'write';
  class FixtureGitHub extends GitHub {
    async request(path: string) {
      if (path.endsWith('/permission')) return { permission, user: { id: 12 } };
      return { number: 3, title: 'Functional issue', state: 'open', labels: [{ name: repo.label }] };
    }
    async list() {
      return [{ id: 1, event: 'labeled', label: { name: repo.label }, actor: { id: 12, login: 'maintainer' }, created_at: since }];
    }
  }
  const github = new FixtureGitHub('', '');
  assert.equal((await github.approval(repo, 3, 'fixture', Date.parse(since)))?.event, 1);
  permission = 'read';
  assert.equal(await github.approval(repo, 3, 'fixture', Date.parse(since)), undefined);
});
