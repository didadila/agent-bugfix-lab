import { createHmac, sign, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { Config } from './lab.ts';

export type Repository = {
  id: number;
  name: string;
  installation: number;
  approvers: number[];
  label: string;
  delivery: 'patch' | 'draft-pr';
  checks: Config;
};

export type Ticket = { number: number; title: string; body: string | null; state: string; pull_request?: object; labels: { name: string }[] };
type LabelEvent = { id: number; event: string; label?: { name: string }; actor?: { id: number; login?: string }; created_at: string };

export function signed(body: Buffer, signature: string | undefined, secret: string) {
  if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), createHmac('sha256', secret).update(body).digest());
}

export function authorization(events: LabelEvent[], repository: Repository, cutoff: number) {
  const latest = events.filter(event => ['labeled', 'unlabeled'].includes(event.event) && event.label?.name === repository.label)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
  if (latest?.event === 'labeled' && latest.actor && repository.approvers.includes(latest.actor.id)
      && Number.isSafeInteger(latest.id) && Date.parse(latest.created_at) >= cutoff) return latest.id;
}

const execute = promisify(execFile);
export async function repositoryGit(path: string, args: string[], options: { token?: string; timestamp?: string; raw?: boolean } = {}) {
  const directory = options.token ? mkdtempSync(join(tmpdir(), 'bugfix-auth-')) : undefined;
  const askpass = directory ? join(directory, 'askpass') : undefined;
  try {
    if (askpass) writeFileSync(askpass, '#!/bin/sh\ncase "$1" in Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$BUGFIX_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
      ...(askpass ? { GIT_ASKPASS: askpass, BUGFIX_GIT_TOKEN: options.token } : {}),
      ...(options.timestamp ? {
        GIT_AUTHOR_NAME: 'Agent Bugfix Lab', GIT_AUTHOR_EMAIL: 'bugfix-lab@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'Agent Bugfix Lab', GIT_COMMITTER_EMAIL: 'bugfix-lab@users.noreply.github.com',
        GIT_AUTHOR_DATE: options.timestamp, GIT_COMMITTER_DATE: options.timestamp,
      } : {}),
    };
    try {
      const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false', '-C', path, ...args],
        { env, timeout: 120_000, maxBuffer: 256_000 });
      return options.raw ? result.stdout : result.stdout.trim();
    } catch {
      throw new Error('Git operation failed: ' + args[0]);
    }
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

export class GitHub {
  app: string;
  key: string;
  constructor(app: string, key: string) {
    this.app = app;
    this.key = key;
  }

  jwt() {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const data = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: now - 60, exp: now + 540, iss: this.app });
    return data + '.' + sign('RSA-SHA256', Buffer.from(data), this.key).toString('base64url');
  }

  async request(path: string, token: string, body?: object, missing = false) {
    const response = await fetch('https://api.github.com' + path, {
      headers: {
        authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'user-agent': 'agent-bugfix-lab',
        'x-github-api-version': '2022-11-28',
      },
      method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error('GitHub request failed with HTTP ' + response.status);
    return response.json();
  }

  async token(repository: Repository, write = false) {
    const result = await this.request('/app/installations/' + repository.installation + '/access_tokens', this.jwt(), {
      repository_ids: [repository.id],
      permissions: write ? { contents: 'write', pull_requests: 'write' } : { contents: 'read', issues: 'read', pull_requests: 'read' },
    });
    if (typeof result.token !== 'string') throw new Error('GitHub did not issue an installation token.');
    return result.token as string;
  }

  async list(path: string, token: string, limit = 10) {
    const items = [];
    for (let page = 1; page <= limit; page++) {
      const response = await this.request(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page, token);
      if (!Array.isArray(response)) throw new Error('Expected a GitHub list response.');
      items.push(...response);
      if (response.length < 100) return items;
    }
    throw new Error('GitHub pagination limit reached.');
  }

  async approval(repository: Repository, issue: number, token: string, cutoff: number) {
    const prefix = '/repos/' + repository.name + '/issues/' + issue;
    const ticket: Ticket = await this.request(prefix, token);
    if (ticket.state !== 'open' || ticket.pull_request || !ticket.labels.some(label => label.name === repository.label)) return;
    const events: LabelEvent[] = await this.list(prefix + '/events', token);
    const event = authorization(events, repository, cutoff);
    const actor = events.find(item => item.id === event)?.actor;
    if (!event || !actor?.login) return;
    const permission = await this.request('/repos/' + repository.name + '/collaborators/' + encodeURIComponent(actor.login) + '/permission',
      token, undefined, true);
    if (permission?.user?.id === actor.id && ['write', 'admin'].includes(permission.permission)) {
      return { event, ticket };
    }
  }

  async findPull(repository: Repository, branch: string, base: string, token: string, commit: string, id: string) {
    const query = new URLSearchParams({ head: repository.name.split('/')[0] + ':' + branch, base, state: 'all' });
    const pulls = await this.list('/repos/' + repository.name + '/pulls?' + query, token);
    if (!pulls.length) return;
    const pull = pulls.length === 1 ? pulls[0] : null;
    if (!pull || pull.head?.sha !== commit || !pull.body?.includes('<!-- bugfix-lab:' + id + ' -->')) {
      throw new Error('Found a pull request with conflicting ownership or candidate.');
    }
    return pull.html_url as string;
  }
}
