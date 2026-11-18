#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { modelProvider } from './model.ts';
import { dockerVerify, replay, runFix } from './lab.ts';

const usage = `Usage:
  bugfix-lab run --repo PATH --issue FILE --config FILE [--output DIR]
  bugfix-lab replay --run DIR

Run requires BUGFIX_MODEL and, for a remote provider, BUGFIX_API_KEY. BUGFIX_API_URL optionally selects
an OpenAI-compatible chat completions endpoint. Review the selected context
before sending it to the configured provider.`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' }, issue: { type: 'string' }, config: { type: 'string' },
      output: { type: 'string' }, run: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) return console.log(usage);
  if (positionals.length === 1 && command === 'replay' && values.run) {
    console.log(JSON.stringify(replay(values.run), null, 2));
    return;
  }
  if (positionals.length !== 1 || command !== 'run' || !values.repo || !values.issue || !values.config) {
    throw new Error(usage);
  }
  const result = await runFix({
    repository: values.repo,
    issue: readFileSync(values.issue, 'utf8'),
    config: JSON.parse(readFileSync(values.config, 'utf8')),
    output: values.output ?? '.bugfix-runs',
  }, { verify: dockerVerify, propose: modelProvider() });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'verified') process.exitCode = 2;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Unexpected CLI error.');
  process.exitCode = 1;
});
