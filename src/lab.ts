import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync, type ExecFileException } from 'node:child_process';
import { existsSync, chmodSync, copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type Check = { id: string; argv: string[]; failureMarker?: string };
export type Outcome = { status: number | null; output: string };
export type Change = { path: string; content: string };
export type Config = {
  image: string;
  editable: string[];
  context?: string[];
  regression: Check & { failureMarker: string };
  checks?: Check[];
  maxAttempts?: number;
  timeoutMs?: number;
};
type Input = { issue: string; files: Record<string, string>; feedback?: string; editable: string[] };
type Dependencies = {
  propose: (input: Input) => Promise<unknown>;
  verify: (path: string, check: Check, config: Config) => Outcome | Promise<Outcome>;
};

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const atomic = (path: string, data: string) => {
  writeFileSync(path + '.tmp', data, { mode: 0o600 });
  renameSync(path + '.tmp', path);
};
const json = (path: string, value: unknown) => atomic(path, JSON.stringify(value, null, 2) + '\n');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', path, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
  });
}

function safePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 240 && path.split('/').every(part =>
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !['node_modules', 'vendor'].includes(part.toLowerCase()));
}

function isCheck(value: any): value is Check {
  return !!value && typeof value.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(value.id)
    && Array.isArray(value.argv) && value.argv.length > 0
    && value.argv.every((arg: unknown) => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0'));
}

export function validateConfig(config: Config) {
  if (!config || typeof config !== 'object' ||
      typeof config.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(config.image) ||
      !Array.isArray(config.editable) || !config.editable.length || !config.editable.every(safePath) ||
      (config.context !== undefined && (!Array.isArray(config.context) || !config.context.every(safePath))) ||
      !isCheck(config.regression) || typeof config.regression.failureMarker !== 'string' || !config.regression.failureMarker.trim() ||
      (config.checks !== undefined && (!Array.isArray(config.checks) || config.checks.length > 8 || !config.checks.every(isCheck))) ||
      (config.maxAttempts !== undefined && (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 3)) ||
      (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 300_000))) {
    throw new Error('Invalid configuration. A pinned image, exact editable paths, and a regression check with a failure marker are required.');
  }
  const ids = [config.regression, ...(config.checks ?? [])].map(check => check.id);
  if (new Set(ids).size !== ids.length) throw new Error('Check IDs must be unique.');
  for (const path of config.editable) {
    if (/(^|\/)(tests?|__tests__|scripts?|ci)(\/|$)|(?:^|[/._-])(?:test|spec)(?:[._-]|$)|lock|(?:^|\/)package\.json$|(?:^|\/)(?:pyproject\.toml|makefile|dockerfile|requirements[^/]*\.txt)$/i.test(path)) {
      throw new Error('Protected path in editable list: ' + path);
    }
  }
}

function clone(source: string, target: string, base: string) {
  git(dirname(target), 'clone', '--quiet', '--no-local', '--no-checkout', '--', source, target);
  git(target, 'checkout', '--quiet', '--detach', base);
  git(target, 'remote', 'remove', 'origin');
}

function changesFrom(value: unknown, allowed: string[]): Change[] {
  if (!Array.isArray(value) || !value.length || value.length > allowed.length) throw new Error('Expected a nonempty list of changes.');
  const seen = new Set<string>();
  for (const change of value) {
    if (!change || !allowed.includes(change.path) || seen.has(change.path) ||
        typeof change.content !== 'string' || Buffer.byteLength(change.content) > 120_000 || change.content.includes('\0')) {
      throw new Error('Candidate tried to change an unauthorized path or returned invalid content.');
    }
    seen.add(change.path);
  }
  return value;
}

function patchOf(path: string, base: string) {
  return git(path, 'diff', '--binary', '--no-ext-diff', '--no-textconv', base, '--');
}

export async function runFix(options: {
  repository: string; issue: string; config: Config; output: string;
}, deps: Dependencies) {
  const { config, issue } = options;
  validateConfig(config);
  if (!issue.trim() || Buffer.byteLength(issue) > 16_000) throw new Error('Issue must contain 1–16000 bytes.');
  const source = realpathSync(options.repository);
  const base = git(source, 'rev-parse', '--verify', 'HEAD^{commit}').toString().trim();
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const outputRoot = realpathSync(output);
  const repoRoot = git(source, 'rev-parse', '--show-toplevel').toString().trim();
  const fromRepo = relative(repoRoot, outputRoot);
  if (fromRepo.split(sep).includes('.git') || (outputRoot === repoRoot)) throw new Error('Unsafe output directory.');
  const id = randomUUID();
  const directory = join(outputRoot, id);
  mkdirSync(directory, { mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), 'bugfix-lab-'));
  const events: { sequence: number; stage: string; at: string }[] = [];
  const event = (stage: string) => {
    events.push({ sequence: events.length + 1, stage, at: new Date().toISOString() });
    json(join(directory, 'events.json'), events);
  };
  const snapshot = { id, base, issue, config };
  json(join(directory, 'snapshot-1.json'), snapshot);
  const finish = (status: string, reason: string, candidate?: string) => {
    event('complete');
    const result = { id, base, status, reason, candidate };
    json(join(directory, 'result.json'), result);
    json(join(directory, 'snapshot-2.json'), {
      result, inputHash: digest(readFileSync(join(directory, 'snapshot-1.json'))),
      eventHash: digest(readFileSync(join(directory, 'events.json'))),
    });
    return { ...result, directory };
  };
  try {
    if (/\b(?:CVE-\d{4}-\d+|exploit|credential theft|remote code execution|sql injection|cross.site scripting|security vulnerability)\b|安全漏洞|漏洞利用/i.test(issue)) {
      return finish('ineligible', 'Security reports require manual triage.');
    }
    const paths = [...new Set([...config.editable, ...(config.context ?? [])])];
    const files = Object.create(null) as Record<string, string>;
    let bytes = 0;
    for (const path of paths) {
      const entry = git(source, 'ls-tree', base, '--', path).toString();
      if (!/^100(?:644|755) blob /.test(entry)) throw new Error('Expected a tracked regular file: ' + path);
      const data = git(source, 'show', base + ':' + path);
      bytes += data.length;
      if (bytes > 180_000 || data.includes(0)) throw new Error('Context must be text within the configured size budget.');
      files[path] = decoder.decode(data);
    }

    const baseline = join(scratch, 'base');
    clone(source, baseline, base);
    event('baseline');
    const before = await deps.verify(baseline, config.regression, config);
    json(join(directory, 'baseline.json'), before);
    if (before.status === null || before.status === 0 || !before.output.includes(config.regression.failureMarker)) {
      return finish('blocked', 'Baseline did not fail with the expected functional regression marker.');
    }
    let feedback: string | undefined;
    const candidates = new Set<string>();
    for (let attempt = 1; attempt <= (config.maxAttempts ?? 2); attempt++) {
      event('propose');
      const proposed = changesFrom(await deps.propose({ issue, files, feedback, editable: config.editable }), config.editable);
      const work = join(scratch, 'work-' + attempt);
      clone(source, work, base);
      for (const change of proposed) writeFileSync(join(work, change.path), change.content);

      const patch = patchOf(work, base);
      if (!patch.length) return finish('failed', 'Agent returned an empty patch.');
      const candidate = digest(patch);
      if (candidates.has(candidate)) return finish('failed', 'Agent repeated a previously rejected patch.');
      candidates.add(candidate);
      const patchFile = join(directory, 'candidate-' + attempt + '.patch');
      writeFileSync(patchFile, patch, { mode: 0o600 });
      event('verify');
      const results = [];
      const checks = [config.regression, ...(config.checks ?? [])];
      for (const check of checks) {
        const verification = join(scratch, 'verify-' + attempt + '-' + check.id);
        clone(source, verification, base);
        git(verification, 'apply', '--binary', '--', patchFile);
        if (digest(patchOf(verification, base)) !== candidate) throw new Error('Candidate identity mismatch.');
        const result = await deps.verify(verification, check, config);
        if (digest(patchOf(verification, base)) !== candidate) throw new Error('Verification changed tracked candidate files.');
        results.push({ id: check.id, ...result });
      }
      json(join(directory, 'verification-' + attempt + '.json'), { candidate, results });
      if (results.every(result => result.status === 0)) {
        copyFileSync(patchFile, join(directory, 'verified.patch'));
        return finish('verified', 'Expected baseline failure observed and all candidate checks passed.', candidate);
      }
      if (results.some(result => result.status === null)) return finish('blocked', 'Verification runner could not complete.', candidate);
      feedback = results.filter(result => result.status !== 0)
        .map(result => result.id + '\n' + result.output.slice(-2000)).join('\n');
    }
    return finish('failed', 'Candidate verification failed within the attempt budget.');
  } catch (error) {
    return finish('blocked', error instanceof Error ? error.message : 'Unexpected run failure.');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const execute = promisify(execFile);

function allowRunnerRead(directory: string) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) allowRunnerRead(path);
    if (entry.isFile()) chmodSync(path, 0o755);
  }
}

export async function dockerVerify(path: string, check: Check, config: Config): Promise<Outcome> {
  const name = 'bugfix-lab-' + randomUUID();
  const directory = mkdtempSync(join(tmpdir(), 'bugfix-runner-'));
  try {
    const workspace = join(realpathSync(directory), 'workspace');
    cpSync(path, workspace, {
      recursive: true, verbatimSymlinks: true,
      filter: entry => entry !== join(path, '.git'),
    });
    allowRunnerRead(workspace);
    const args = ['run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
      '--memory=512m', '--cpus=1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--env', 'HOME=/tmp', '--mount', 'type=bind,source=' + workspace + ',target=/workspace,readonly',
      '--workdir', '/workspace', '--entrypoint', check.argv[0], config.image, ...check.argv.slice(1)];
    try {
      const result = await execute('docker', args, { timeout: config.timeoutMs ?? 60_000, maxBuffer: 256_000, killSignal: 'SIGKILL' });
      return { status: 0, output: result.stdout + result.stderr };
    } catch (error) {
      const failure = error as ExecFileException & { stdout?: string; stderr?: string };
      const code = failure.code;
      const status = typeof code === 'number' && ![125, 126, 127, 137].includes(code) ? code : null;
      if (status === null) {
        await execute('docker', ['rm', '-f', name], { timeout: 10_000 }).catch(() => undefined);
      }
      return { status, output: [failure.stdout, failure.stderr].filter(Boolean).join('\n') || 'Runner could not complete.' };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function replay(directory: string) {
  const read = (name: string) => readFileSync(join(directory, name));
  const first = read('snapshot-1.json');
  const events = read('events.json');
  if (!existsSync(join(directory, 'snapshot-2.json'))) {
    return { complete: false, input: JSON.parse(first.toString()), events: JSON.parse(events.toString()) };
  }
  const seal = JSON.parse(read('snapshot-2.json').toString());
  const result = JSON.parse(read('result.json').toString());
  if (seal.inputHash !== digest(first) || seal.eventHash !== digest(events) ||
      JSON.stringify(seal.result) !== JSON.stringify(result) || JSON.parse(first.toString()).id !== result.id ||
      (result.status === 'verified' && digest(read('verified.patch')) !== result.candidate)) {
    throw new Error('Run evidence does not match its seal.');
  }
  return { complete: true, result, events: JSON.parse(events.toString()) };
}
