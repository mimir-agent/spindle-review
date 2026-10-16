import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { planFor, roundForSha } from "./rounds.ts";
import { AuthError, Redactor, childEnv, modelAuth, type Env } from "./secrets.ts";
import {
  DEFAULT_INDEX,
  commentRecord,
  fetchRoundPatches,
  findOpenPull,
  getPull,
  postComment,
  type Fetch,
  type Pull,
} from "./tangled.ts";
import { buildPrompt, claudeArgs, parseClaudeResult, readGuidance, renderComment, runClaude, type Finding } from "./review.ts";

export const HELP = `spindle-review: quiet, round-aware review for Tangled pull requests

Usage: spindle-review [options]

In a spindle pull_request workflow it needs no options: it finds the pull
request from TANGLED_REPO_REPO_DID, TANGLED_PR_SOURCE_BRANCH,
TANGLED_PR_TARGET_BRANCH and TANGLED_PR_SOURCE_SHA, reviews the round, and
posts one comment as the account in ATP_IDENTIFIER.

Options:
  --pull <at-uri>       Review this pull request instead of looking it up.
  --round <n>           Review this round (0 is the first). Default: the round
                        built by this pipeline, else the latest.
  --repo-dir <path>     Repository checkout to review in. Default: cwd.
  --dry-run             Print the comment instead of posting it.
  --quiet-when-clean    Post nothing when there are no findings.
  --max-turns <n>       Turn cap for the model. Default 30.
  --timeout <seconds>   Time cap for the model. Default 900.
  --model <name>        Model alias passed to the claude CLI.
  --ci-result <path>    A CI result file the reviewer may read.
  --local-auth          Use the claude CLI's own login when no token is set.
  -h, --help            Show this help.

Environment:
  CLAUDE_CODE_OAUTH_TOKEN  From \`claude setup-token\` (or ANTHROPIC_API_KEY).
  ATP_IDENTIFIER           Handle or DID of the account that posts the comment.
  ATP_APP_PASSWORD         App password for that account.
  ATP_PDS                  That account's PDS. Default: looked up from the DID.
  TANGLED_INDEX            Tangled index. Default ${DEFAULT_INDEX}.
  CLAUDE_BIN               The claude executable. Default: claude.
`;

export interface Deps {
  env: Env;
  fetch: Fetch;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  now: () => Date;
  // Runs the model and returns its findings. Injected so tests never spawn claude.
  review: (args: { repoDir: string; patchDir: string; prompt: string; maxTurns: number; timeoutMs: number; model?: string }) => Promise<Finding[]>;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const redact = new Redactor(deps.env);
  const out = (s: string) => deps.stdout(redact.apply(s));
  const err = (s: string) => deps.stderr(redact.apply(s));
  try {
    return await run(argv, deps, out, err);
  } catch (e) {
    err(`spindle-review: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof AuthError ? 2 : 1;
  }
}

async function run(argv: string[], deps: Deps, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pull: { type: "string" },
      round: { type: "string" },
      "repo-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "quiet-when-clean": { type: "boolean", default: false },
      "max-turns": { type: "string", default: "30" },
      timeout: { type: "string", default: "900" },
      model: { type: "string" },
      "ci-result": { type: "string" },
      "local-auth": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    out(HELP);
    return 0;
  }
  const env = deps.env;
  const dryRun = values["dry-run"];

  // Fail on missing credentials before doing any network work.
  modelAuth(env, values["local-auth"]);
  if (!dryRun && (!env.ATP_IDENTIFIER || !env.ATP_APP_PASSWORD)) {
    throw new AuthError("Posting needs ATP_IDENTIFIER and ATP_APP_PASSWORD. Use --dry-run to print the comment instead.");
  }

  const maxTurns = positiveInt(values["max-turns"], "--max-turns");
  const timeoutMs = positiveInt(values.timeout, "--timeout") * 1000;
  const repoDir = path.resolve(values["repo-dir"] ?? process.cwd());
  const index = env.TANGLED_INDEX ?? DEFAULT_INDEX;

  const pull = await locatePull(deps.fetch, index, values.pull, env);
  const patches = await fetchRoundPatches(deps.fetch, pull);
  const round = pickRound(values.round, patches, env.TANGLED_PR_SOURCE_SHA);
  const plan = planFor(round, patches.length);
  err(`spindle-review: ${pull.uri} round #${plan.round} (${plan.kind === "full" ? "full review" : `changes since #${plan.previous}`})\n`);

  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-review-"));
  try {
    fs.writeFileSync(path.join(patchDir, "round.patch"), patches[plan.round] as string);
    if (plan.kind === "interdiff") fs.writeFileSync(path.join(patchDir, "previous.patch"), patches[plan.previous] as string);
    const ciResultFile = values["ci-result"] ? path.resolve(values["ci-result"]) : undefined;
    const prompt = buildPrompt(
      {
        title: pull.record.title,
        description: pull.record.body ?? "",
        plan,
        guidance: readGuidance(repoDir),
        ...(ciResultFile ? { ciResultFile } : {}),
      },
      patchDir,
    );
    const findings = await deps.review({
      repoDir,
      patchDir,
      prompt,
      maxTurns,
      timeoutMs,
      ...(values.model ? { model: values.model } : {}),
    });

    const body = renderComment(findings, plan.round, { quietWhenClean: values["quiet-when-clean"] });
    if (body === null) {
      err("spindle-review: no findings; nothing posted.\n");
      return 0;
    }
    const record = commentRecord(pull, plan.round, body, deps.now());
    if (dryRun) {
      out(body + "\n");
      return 0;
    }
    const uri = await postComment(deps.fetch, {
      identifier: env.ATP_IDENTIFIER as string,
      password: env.ATP_APP_PASSWORD as string,
      ...(env.ATP_PDS ? { pds: env.ATP_PDS } : {}),
    }, record);
    out(`Posted ${uri}\n`);
    return 0;
  } finally {
    fs.rmSync(patchDir, { recursive: true, force: true });
  }
}

async function locatePull(f: Fetch, index: string, uri: string | undefined, env: Env): Promise<Pull> {
  if (uri) return getPull(f, index, uri);
  // TANGLED_REPO_DID is the repo owner's DID. Pull records target the repo's
  // own DID, which spindle sets as TANGLED_REPO_REPO_DID (spindle/models/pipeline_env.go).
  const repoDid = env.TANGLED_REPO_REPO_DID;
  const source = env.TANGLED_PR_SOURCE_BRANCH;
  const target = env.TANGLED_PR_TARGET_BRANCH;
  if (env.TANGLED_PIPELINE_KIND !== "pull_request" || !repoDid || !source || !target) {
    throw new Error(
      "Not running in a spindle pull_request pipeline (TANGLED_PIPELINE_KIND, TANGLED_REPO_REPO_DID and " +
        "TANGLED_PR_* are not all set). Pass --pull <at-uri> to review a specific pull request.",
    );
  }
  return findOpenPull(f, index, repoDid, source, target, env.TANGLED_PR_SOURCE_SHA);
}

function pickRound(flag: string | undefined, patches: readonly string[], sha: string | undefined): number {
  if (flag !== undefined) return positiveInt(flag, "--round", true);
  if (sha) {
    const r = roundForSha(patches, sha);
    if (r === undefined) {
      throw new Error(`No round of this pull request ends at ${sha}. The round may not be indexed yet; rerun the pipeline.`);
    }
    return r;
  }
  return patches.length - 1;
}

function positiveInt(v: string, name: string, allowZero = false): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer.`);
  return n;
}

// The real model runner: the unmodified claude CLI, never with --bare (bare
// mode ignores CLAUDE_CODE_OAUTH_TOKEN).
export function claudeReview(env: Env): Deps["review"] {
  return async ({ repoDir, patchDir, prompt, maxTurns, timeoutMs, model }) => {
    const args = claudeArgs(prompt, { maxTurns, patchDir, ...(model ? { model } : {}) });
    const res = await runClaude(env.CLAUDE_BIN ?? "claude", args, { cwd: repoDir, env: childEnv(env), timeoutMs });
    if (res.timedOut) throw new Error(`The review hit the ${timeoutMs / 1000}s time cap.`);
    if (res.code !== 0 && res.stdout.trim() === "") {
      throw new Error(`claude exited with ${res.code}: ${res.stderr.trim().slice(0, 500)}`);
    }
    return parseClaudeResult(res.stdout);
  };
}
