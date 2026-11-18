import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { replay, runFix, validateConfig, type Config } from '../src/lab.ts';

const config: Config = {
  image: 'example@sha256:' + '0'.repeat(64), editable: ['calc.js'],
  regression: { id: 'regression', argv: ['node', 'verify.js'], failureMarker: 'EXPECTED_TOTAL' },
  checks: [{ id: 'unit', argv: ['node', 'verify.js'] }],
};

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'bugfix-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  mkdirSync(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git('init');
  writeFileSync(join(repository, 'calc.js'), 'export const sum = (a, b) => a - b;\n');
  writeFileSync(join(repository, 'verify.js'), 'import {sum} from "./calc.js"; if (sum(2, 3) !== 5) { console.error("EXPECTED_TOTAL"); process.exit(1); }\n');
  writeFileSync(join(repository, 'package.json'), '{"type":"module"}');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
  return { repository, output: join(root, 'out'), config, issue: 'The total subtracts its second operand.' };
}

const repair = async () => [{ path: 'calc.js', content: 'export const sum = (a, b) => a + b;\n' }];
function check(path) {
  try {
    execFileSync(process.execPath, ['verify.js'], { cwd: path, stdio: 'pipe' });
    return { status: 0, output: '' };
  } catch (error) {
    return { status: error.status, output: error.stderr.toString() };
  }
}

test('verifies a candidate independently and seals the exported patch', async t => {
  const options = setup(t);
  const result = await runFix(options, { propose: repair, verify: check });
  assert.equal(result.status, 'verified', result.reason);
  assert.match(readFileSync(join(result.directory, 'verified.patch'), 'utf8'), /a \+ b/);
  assert.match(readFileSync(join(options.repository, 'calc.js'), 'utf8'), /a - b/);
  assert.equal(replay(result.directory).complete, true);
  writeFileSync(join(result.directory, 'verified.patch'), 'altered');
  assert.throws(() => replay(result.directory), /does not match/);
});

test('blocks unavailable baseline without contacting model', async t => {
  const result = await runFix(setup(t), {
    propose: async () => assert.fail('model should not run'),
    verify: () => ({ status: null, output: 'unavailable' }),
  });
  assert.equal(result.status, 'blocked');
  assert(!existsSync(join(result.directory, 'verified.patch')));
});

test('blocks changes outside the editable allowlist', async t => {
  const result = await runFix(setup(t), {
    propose: async () => [{ path: 'verify.js', content: '' }], verify: check,
  });
  assert.match(result.reason, /unauthorized/);
});

test('blocks verification that modifies the candidate', async t => {
  const options = setup(t);
  const result = await runFix(options, { propose: repair, verify: path => {
    const result = check(path);
    if (result.status === 0) writeFileSync(join(path, 'calc.js'), 'modified');
    return result;
  }});
  assert.match(result.reason, /changed tracked candidate/);
  assert(!existsSync(join(result.directory, 'verified.patch')));
});

test('retries a verification failure with feedback', async t => {
  const result = await runFix(setup(t), {
    verify: check,
    propose: async ({ feedback }) => feedback ? repair() : [{
      path: 'calc.js', content: 'export const sum = (a, b) => a * b;\n',
    }],
  });
  assert.equal(result.status, 'verified', result.reason);
  assert(existsSync(join(result.directory, 'verification-2.json')));
});

test('rejects malformed and test-editing configurations', () => {
  assert.throws(() => validateConfig({ ...config, editable: ['../src.js'] }));
  assert.throws(() => validateConfig({ ...config, editable: ['calc.test.js'] }));
  assert.throws(() => validateConfig({ ...config, image: 'node:latest' }));
});

test('routes security reports out of the functional defect workflow', async t => {
  const options = { ...setup(t), issue: 'Reported security vulnerability' };
  const result = await runFix(options, {
    verify: () => assert.fail('runner should not run'),
    propose: async () => assert.fail('model should not run'),
  });
  assert.equal(result.status, 'ineligible');
});

test('runs the same functional repair contract for Python', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bugfix-python-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init');
  writeFileSync(join(root, 'total.py'), 'def total(a, b):\n    return a - b\n');
  writeFileSync(join(root, 'verify.py'), 'from total import total\nassert total(2, 3) == 5, "EXPECTED_TOTAL"\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
  const result = await runFix({
    repository: root, output: join(root, 'out'), issue: 'Total subtracts the second value.',
    config: { ...config, editable: ['total.py'], regression: { ...config.regression, argv: ['python3', '-B', 'verify.py'] }, checks: [] },
  }, {
    propose: async () => [{ path: 'total.py', content: 'def total(a, b):\n    return a + b\n' }],
    verify(path, check) {
      try {
        execFileSync(check.argv[0], check.argv.slice(1), { cwd: path, stdio: 'pipe' });
        return { status: 0, output: '' };
      } catch (error) {
        return { status: error.status, output: error.stderr?.toString() ?? error.message };
      }
    },
  });
  assert.equal(result.status, 'verified', result.reason);
});

test('CLI calls the provider and runner adapters and replays their result', async t => {
  const options = setup(t);
  const root = join(options.repository, '..');
  const tools = join(root, 'bin');
  mkdirSync(tools);
  writeFileSync(join(tools, 'docker'), `#!/bin/sh
[ "$1" = run ] || exit 0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mount) workspace=${'${2#type=bind,source=}'}; cd "${'${workspace%,target=/workspace,readonly}'}" || exit 125; shift ;;
    --entrypoint) shift; command="$1"; shift; shift; exec "$command" "$@" ;;
  esac
  shift
done
exit 125
`, { mode: 0o700 });
  const issue = join(root, 'issue.md');
  const recipe = join(root, 'config.json');
  const node = process.execPath;
  writeFileSync(issue, options.issue);
  writeFileSync(recipe, JSON.stringify({
    ...config, regression: { ...config.regression, argv: [node, 'verify.js'] },
    checks: [],
  }));
  const seen: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ changes: await repair() }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const exec = promisify(execFile);
  const cli = new URL('../src/cli.ts', import.meta.url);
  const { stdout } = await exec(node, [decodeURIComponent(cli.pathname), 'run', '--repo', options.repository,
    '--issue', issue, '--config', recipe, '--output', options.output], {
    env: { PATH: tools + ':' + process.env.PATH, BUGFIX_MODEL: 'fixture', BUGFIX_API_KEY: 'fixture',
      BUGFIX_API_URL: 'http://127.0.0.1:' + address.port + '/v1/chat/completions' },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'verified');
  assert.equal(seen.length, 1);
  const playback = await exec(node, [decodeURIComponent(cli.pathname), 'replay', '--run', result.directory]);
  assert.equal(JSON.parse(playback.stdout).complete, true);
});
