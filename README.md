# spindle-review

A quiet, round-aware pull request reviewer for [Tangled](https://tangled.org). It runs on your own
spindle (Tangled CI) and uses your own Claude subscription through the official, unmodified `claude`
CLI.

- **Round-aware.** The first round of a pull request gets a full review. Every later round gets a
  review of what changed since the round before, so a resubmission is not re-reviewed from scratch.
- **Quiet.** It reports only bugs, security problems and broken contracts. Each finding names the
  file and line, what goes wrong, what triggers it, and the fix. No style notes, no summary. When
  nothing matters it posts one line ("No issues found in round #N."), or nothing with
  `--quiet-when-clean`.
- **Read-only.** The model can read and search the checkout and the patches (the Read, Grep and Glob
  tools). It has no shell: it cannot run commands, edit files or write files.
- **One comment.** The review is a single top-level comment on the pull request, written as an
  `sh.tangled.feed.comment` record by an account you choose.

This project is not made or endorsed by Anthropic.

## Setup

1. **Make a subscription token.** On your own machine, with a Pro, Max, Team or Enterprise plan:

   ```sh
   claude setup-token
   ```

   It prints a long-lived OAuth token. (An Anthropic API key works too; see below.)

2. **Pick the account that posts reviews.** A separate bot account is better than your own (see
   [Limits](#limits)). On its PDS, create an app password (on Bluesky: Settings, Privacy and security,
   App passwords).

3. **Set three secrets** on the repository, under **Settings → Secrets**:

   | Secret | Value |
   | --- | --- |
   | `CLAUDE_CODE_OAUTH_TOKEN` | the token from step 1 (or set `ANTHROPIC_API_KEY` instead) |
   | `ATP_IDENTIFIER` | the posting account's handle or DID |
   | `ATP_APP_PASSWORD` | the app password from step 2 |

4. **Add the workflow.** Copy [`examples/review.yml`](examples/review.yml) to
   `.tangled/workflows/review.yml` and change `branch: ["main"]` to the branches your pull requests
   target. Push it. The next pull request round is reviewed.

The example uses the `nixery` engine with `nodejs_24` from nixpkgs and installs the `claude` CLI with
npm, because nixpkgs packages `claude-code` as unfree. On the `microvm` engine, install Node 24 with
the image's package manager and keep the same two steps.

## Options

```
spindle-review [--pull <at-uri>] [--round <n>] [--repo-dir <path>] [--dry-run]
               [--quiet-when-clean] [--max-turns <n>] [--timeout <seconds>]
               [--model <name>] [--ci-result <path>] [--local-auth]
```

- `--dry-run` prints the comment instead of posting it. It needs no posting secrets.
- `--max-turns` (default 30) and `--timeout` (default 900 seconds) cap each review.
- `--ci-result <path>` points the reviewer at a CI result file it may read. It never reruns your tests.
- `--local-auth` uses the `claude` CLI's own login when no token is set, for trying it on your machine.
- `--pull` and `--round` review a specific pull request and round, for example from your laptop:

  ```sh
  git clone https://github.com/mimir-agent/spindle-review.git ~/spindle-review
  (cd ~/spindle-review && npm ci && npm run build)
  cd path/to/checkout-at-the-pull-request-head
  node ~/spindle-review/bin/spindle-review.js --dry-run --local-auth \
    --pull at://did:plc:.../sh.tangled.repo.pull/3m...
  ```

Repository guidance in `AGENTS.md`, `CLAUDE.md` or `REVIEW.md` at the repository root is given to the
reviewer, which holds the change to it.

## How it works

In a `pull_request` pipeline, spindle sets `TANGLED_REPO_REPO_DID`, `TANGLED_PR_SOURCE_BRANCH`,
`TANGLED_PR_TARGET_BRANCH` and `TANGLED_PR_SOURCE_SHA`. It does not say which pull request started the
pipeline, so spindle-review asks Tangled's public index (`api.tangled.org`,
`sh.tangled.repo.listPulls`) for the open same-repo pull request with those branches. It downloads
every round's patch (a gzipped git-format-patch) from the pull author's PDS, and picks the round whose
last commit is `TANGLED_PR_SOURCE_SHA`.

It runs `claude -p` in the checkout with `--restricted`, `--permission-mode dontAsk`, a read-only tool
list, a JSON schema for findings, and the turn and time caps. It never passes `--bare`, because bare
mode ignores `CLAUDE_CODE_OAUTH_TOKEN`. The app password is removed from the environment the model runs
in, and every secret value is redacted from anything spindle-review prints.

Then it logs in to the posting account's PDS with the app password and writes one record:

```json
{
  "$type": "sh.tangled.feed.comment",
  "subject": { "uri": "at://<author>/sh.tangled.repo.pull/<rkey>", "cid": "<pull record cid>" },
  "body": { "$type": "sh.tangled.markup.markdown", "text": "..." },
  "createdAt": "2026-10-15T12:00:00.000Z",
  "pullRoundIdx": 1
}
```

Tangled's appview picks it up from the firehose and shows it on the pull request under that round.

## Limits

- **Same-repo branch pull requests only.** Spindle does not run `pull_request` pipelines for pull
  requests from forks or for pasted patches, and it only runs them when the pull request author has
  push access to the repository. Spindle never gives secrets to pipelines that run untrusted fork code.
  So outside contributors' pull requests are not reviewed.
- **One top-level comment.** Tangled has no inline or line comments. Findings cite `file:line` in the
  comment body instead.
- **The token lasts one year.** Run `claude setup-token` again and update the secret before it expires.
- **It uses your plan's limits.** Reviews draw from the same five-hour and weekly limits as your own
  use of Claude and Claude Code. A busy repository spends a real share of them. Anthropic describes plan
  limits as assuming "ordinary, individual usage".
- **Where your token lives.** On Tangled's hosted spindle, the token is stored by Tangled. On a
  self-hosted spindle it stays on your own machine.
- **The app password can do anything that account can do.** It is not scoped to "comment on this pull
  request". Use a dedicated bot account.
- **A new round may not be indexed yet.** If the pipeline starts before Tangled's index has the new
  round, spindle-review stops with an error instead of reviewing the wrong round. Rerun the pipeline.
- **Future `claude` releases.** Anthropic has said `--bare` will become the default for `-p` in a
  future release. If that happens without a way to opt out, subscription tokens will stop working here
  and only `ANTHROPIC_API_KEY` will.

## Terms

spindle-review runs the unmodified `claude` binary, signed in with the repository owner's own
subscription, on the owner's own repositories. Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says its rules do
not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude
subscription, including where a platform hosts Claude Code". Use it that way: your token, your
repositories, your plan.

A hosted, multi-user version of this (a service that stores other people's subscription tokens and
reviews for them) is not allowed under that page; it would need each user's own Anthropic API key
instead.

## Development

Node 24 or later. The source is TypeScript run directly by Node's type stripping.

```sh
npm install
npm run check   # typecheck and tests
```

## License

MIT
