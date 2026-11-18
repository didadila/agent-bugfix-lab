# Agent Bugfix Lab

Agent Bugfix Lab turns a local issue into a reviewable patch for an ordinary functional defect. It records the expected failure on the Git baseline, applies the proposed changes in a separate checkout, then runs independent checks before exporting a verified patch.

## Requirements

- Node.js 22.18 or newer and Git
- A running Docker engine and a locally available image pinned by digest
- An OpenAI-compatible chat completions provider with JSON object response support

Use repositories you control or are authorized to repair. The current CLI supports replacements of existing tracked text files explicitly listed by the operator. It cannot add files or edit files outside that list. Keep tests, fixtures, configuration and dependency metadata outside the editable list. Select context files intentionally because the issue, selected source files and bounded failure feedback are sent to the configured model provider.

## Run

Prepare a configuration file outside the target repository. Use the digest from a locally available image. The regression command must emit the configured marker and exit nonzero when the target behavior is broken, then exit zero when it is fixed. Other required checks must exit zero.

```json
{
  "image": "node@sha256:REPLACE_WITH_64_HEX_DIGEST",
  "editable": ["src/total.js"],
  "context": ["verify-total.js"],
  "regression": {
    "id": "total",
    "argv": ["node", "verify-total.js"],
    "failureMarker": "EXPECTED_TOTAL"
  },
  "checks": [],
  "maxAttempts": 2
}
```

Configure `BUGFIX_MODEL` and, for remote providers, `BUGFIX_API_KEY` in the calling environment. For a different provider, set `BUGFIX_API_URL` to its full HTTPS chat completions endpoint or a loopback endpoint.

```sh
node src/cli.ts run --repo /path/to/repo --issue issue.md --config lab.json
node src/cli.ts replay --run .bugfix-runs/RUN_ID
```

The CLI uses the target repository's committed HEAD. A successful run writes `verified.patch`, the regression evidence, and replay snapshots in the run directory. Review the patch before applying it to the same baseline with Git. Exit codes are 0 for verified runs, 2 for runs that end without verification and 1 for command or configuration errors. Store run artifacts privately. They can contain proprietary source, issues and test output.

The runner executes the supplied check command directly as a non-root user in the pinned image, with a read-only workspace, isolated networking and no access to the Git metadata. Use an image with required dependencies preloaded. Check recipes must work with read-only source and place temporary or generated files under `/tmp`. Container isolation depends on the host and Docker configuration. Regression evidence establishes what the configured checks observed. Reviewers still need to assess whether the patch changes the intended behavior and preserves meaningful checks.

## Development

```sh
node --test
```

Tests create disposable Git repositories with synthetic JavaScript and Python defects. They exercise verification and replay with deterministic model and runner substitutes. Python 3 is required for the Python fixture.

## GitHub automation

Deploy one daemon per state directory on a trusted host. The daemon listens on loopback. Publish only its webhook path through an HTTPS reverse proxy and set a unique, strong webhook secret on the GitHub App.

1. Create and install a GitHub App only on the repositories you intend to repair. Give it Issues read, Contents read and Pull requests read. Enable Contents and Pull requests write if the selected repositories use draft PR delivery. Subscribe to the Issues event, and configure the webhook URL as `https://YOUR_HOST/github/webhook`.
2. Copy `deployment.example.json` to a private file. Set the installation ID, repository ID, full repository name and numeric account IDs allowed to authorize repairs. Set `since` to the desired activation time. The label must be applied by an approved account at or after that time. The account must still have write or admin access when the daemon checks authorization.
3. Configure `BUGFIX_GITHUB_APP_ID`, `BUGFIX_GITHUB_KEY_FILE` and `BUGFIX_WEBHOOK_SECRET` in the service environment, along with the model settings above. Keep the App private key and deployment file outside your checkout. Pre-pull the image pinned in the deployment policy.
4. Start the daemon.

```sh
node src/daemon.ts /private/path/deployment.json /private/path/bugfix-state
```

Start with `delivery: "patch"`. Verify the resulting evidence before switching a repository to `"draft-pr"` and restarting the daemon. Each label application authorizes one run. A new run needs a new label application. Relabel only after inspecting the previous run and any existing draft PR.

Signed webhook requests enter a durable queue. A periodic scan reconciles missed events, including after restarts, by reading recent open issues with the configured label and checking their current label history. The scan defaults to 900 seconds and can be configured with `pollSeconds` (minimum 60). The daemon rereads issue authorization, compares frozen evidence to the current verification policy, checks branch freshness, and only publishes the verified candidate. It uses a dedicated branch and never merges PRs. Before enabling draft PRs, review GitHub Actions workflows that respond to bot pushes or pull requests and isolate candidate execution from privileged workflows.

The state directory contains `queue.sqlite` and `runs/`. Keep it private and persistent. Monitor job stage and result through the SQLite `jobs` table or use CLI replay on a run directory. If a push or creation response is uncertain, the daemon reads back the branch or PR. An operation that remains ambiguous is recorded for review. Resolve it on GitHub before submitting a new authorization. Inspect stopped runs for a temporary branch before removing it through your regular repository workflow.

This release supports one host and one worker per state directory. Its reconciliation scan limits GitHub list requests to 1,000 results per list. Use explicit repositories with a recent activation cutoff. A GitHub App's permissions and repository branch rules remain authoritative.

Only the example deployment is tracked. Keep model and GitHub secrets, actual deployment files, state stores, issue material, logs, repositories used as fixtures, and generated patches out of version control.

[GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) · [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
