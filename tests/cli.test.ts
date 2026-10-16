import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { claudeArgs } from "../src/review.ts";
import { childEnv } from "../src/secrets.ts";
import { FINDING, PIPELINE_ENV, PULL_URI, REPO_DID, SHA0, SHA1, harness } from "./fixtures.ts";

const TOKEN = "sk-ant-oat01-SECRET-TOKEN-VALUE";
const API_KEY = "sk-ant-api03-SECRET-KEY-VALUE";
const APP_PASSWORD = "abcd-efgh-ijkl-mnop";

describe("auth", () => {
  it("fails with a clear message when no model credentials are set", async () => {
    const h = harness({ ...PIPELINE_ENV });
    const code = await main(["--dry-run"], h.deps);
    assert.equal(code, 2);
    assert.match(h.err.join(""), /No model credentials\. Set CLAUDE_CODE_OAUTH_TOKEN .* or ANTHROPIC_API_KEY/);
    assert.equal(h.net.calls.length, 0, "no network work before auth is checked");
  });

  it("treats a blank token as missing", async () => {
    const h = harness({ ...PIPELINE_ENV, CLAUDE_CODE_OAUTH_TOKEN: "  " });
    assert.equal(await main(["--dry-run"], h.deps), 2);
  });

  it("accepts ANTHROPIC_API_KEY instead of a token", async () => {
    const h = harness({ ...PIPELINE_ENV, ANTHROPIC_API_KEY: API_KEY, TANGLED_PR_SOURCE_SHA: SHA1 });
    assert.equal(await main(["--dry-run"], h.deps), 0);
  });

  it("needs the posting secrets unless it is a dry run", async () => {
    const h = harness({ ...PIPELINE_ENV, CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    assert.equal(await main([], h.deps), 2);
    assert.match(h.err.join(""), /Posting needs ATP_IDENTIFIER and ATP_APP_PASSWORD/);
  });
});

describe("in a spindle pull_request pipeline", () => {
  const env = {
    ...PIPELINE_ENV,
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    ATP_IDENTIFIER: "did:plc:reviewer",
    ATP_APP_PASSWORD: APP_PASSWORD,
    ATP_PDS: "https://reviewer-pds.example.test",
  };

  it("looks the pull up by the repo's own DID, not the owner's", async () => {
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: SHA0 });
    assert.equal(await main(["--dry-run"], h.deps), 0);
    const list = h.net.calls.find((c) => c.url.includes("listPulls"));
    assert.ok(list);
    assert.equal(new URL(list.url).searchParams.get("subject"), REPO_DID);
  });

  it("reviews round 0 in full when the pipeline built round 0", async () => {
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: SHA0 });
    await main(["--dry-run"], h.deps);
    assert.match(h.prompts[0] ?? "", /round #0, the first submission\. Review the whole change/);
    assert.doesNotMatch(h.prompts[0] ?? "", /previous\.patch/);
  });

  it("reviews only the change since the last round when the pipeline built round 1", async () => {
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: SHA1 });
    await main(["--dry-run"], h.deps);
    assert.match(h.prompts[0] ?? "", /round #1\. Round #0 was already reviewed/);
    assert.match(h.prompts[0] ?? "", /previous\.patch/);
  });

  it("refuses to guess when the built sha matches no round", async () => {
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: "9".repeat(40) });
    assert.equal(await main(["--dry-run"], h.deps), 1);
    assert.match(h.err.join(""), /No round of this pull request ends at 9{40}/);
  });

  it("skips pulls whose source branch lives in another repo", async () => {
    const forked = {
      uri: "at://did:plc:other/sh.tangled.repo.pull/fork",
      cid: "bafyfork",
      state: "open",
      value: { title: "fork", source: { branch: "feature", repo: "did:plc:fork" }, target: { branch: "main", repo: REPO_DID }, rounds: [] },
    };
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: SHA0 }, [], { extraPulls: [forked] });
    assert.equal(await main(["--dry-run"], h.deps), 0, "the fork pull is ignored, not reported as ambiguous");
  });

  it("dry run prints the one-line clean result and posts nothing", async () => {
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: SHA1 });
    assert.equal(await main(["--dry-run"], h.deps), 0);
    assert.equal(h.out.join(""), "No issues found in round #1.\n");
    assert.equal(h.net.calls.filter((c) => c.init?.method === "POST").length, 0);
  });

  it("posts nothing at all when clean and --quiet-when-clean is set", async () => {
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: SHA1 });
    assert.equal(await main(["--quiet-when-clean"], h.deps), 0);
    assert.equal(h.out.join(""), "");
    assert.equal(h.net.calls.filter((c) => c.init?.method === "POST").length, 0);
  });

  it("posts one top-level comment record for the reviewed round", async () => {
    const h = harness({ ...env, TANGLED_PR_SOURCE_SHA: SHA1 }, [FINDING]);
    assert.equal(await main([], h.deps), 0);
    const create = h.net.calls.find((c) => c.url.endsWith("/xrpc/com.atproto.repo.createRecord"));
    assert.ok(create);
    assert.ok(create.url.startsWith("https://reviewer-pds.example.test/"));
    const body = JSON.parse(String(create.init?.body));
    assert.equal(body.repo, "did:plc:reviewer");
    assert.equal(body.collection, "sh.tangled.feed.comment");
    assert.equal(body.record.subject.uri, PULL_URI);
    assert.equal(body.record.pullRoundIdx, 1);
    assert.match(body.record.body.text, /src\/a\.ts:2/);
    assert.equal(h.net.calls.filter((c) => c.url.endsWith("createRecord")).length, 1);
    assert.match(h.out.join(""), /Posted at:\/\/did:plc:reviewer\/sh\.tangled\.feed\.comment\//);
  });
});

describe("secrets never in output", () => {
  const all = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: API_KEY, ATP_APP_PASSWORD: APP_PASSWORD };

  it("redacts secrets even when an error message would carry one", async () => {
    // A finding whose text echoes the token and the app password.
    const echo = { ...FINDING, problem: `Leaks ${TOKEN} and ${APP_PASSWORD}` };
    const h = harness({ ...PIPELINE_ENV, ...all, ATP_IDENTIFIER: "x", TANGLED_PR_SOURCE_SHA: SHA0 }, [echo]);
    await main(["--dry-run"], h.deps);
    const printed = h.out.join("") + h.err.join("");
    for (const s of Object.values(all)) assert.equal(printed.includes(s), false, "secret printed");
    assert.match(printed, /\[redacted\]/);
  });

  it("does not print secrets on the missing-pipeline error", async () => {
    const h = harness({ ...all });
    assert.equal(await main(["--dry-run"], h.deps), 1);
    const printed = h.out.join("") + h.err.join("");
    for (const s of Object.values(all)) assert.equal(printed.includes(s), false);
  });

  it("keeps the app password out of the model's environment", () => {
    const env = childEnv({ ...all, PATH: "/bin" });
    assert.equal(env.ATP_APP_PASSWORD, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN, "the CLI needs its own token");
  });

  it("never passes a secret or --bare on the claude command line", () => {
    const args = claudeArgs("prompt", { maxTurns: 5, patchDir: "/tmp/p" });
    assert.equal(args.includes("--bare"), false);
    for (const s of Object.values(all)) assert.equal(args.join(" ").includes(s), false);
  });
});

describe("claude invocation", () => {
  const args = claudeArgs("prompt", { maxTurns: 7, patchDir: "/tmp/p" });
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  it("is headless, capped, and read-only", () => {
    assert.equal(args[0], "-p");
    assert.equal(after("--max-turns"), "7");
    assert.ok(args.includes("--restricted"));
    assert.equal(after("--permission-mode"), "dontAsk");
  });

  // Pinned exactly. Widening any of these (adding Bash or a Bash(...) rule back,
  // or dropping a disallowed tool) must fail here and be argued in review.
  it("offers exactly Read, Grep and Glob and no shell", () => {
    const allowedAt = args.indexOf("--allowedTools");
    const disallowedAt = args.indexOf("--disallowedTools");
    const end = args.includes("--model") ? args.indexOf("--model") : args.length;
    assert.equal(after("--tools"), "Read,Grep,Glob");
    assert.deepEqual(args.slice(allowedAt + 1, disallowedAt), ["Read", "Grep", "Glob"]);
    assert.deepEqual(args.slice(disallowedAt + 1, end), [
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
    ]);
    assert.equal(args.filter((a) => a.includes("Bash(")).length, 0, "no Bash rule of any kind");
    assert.equal(disallowedAt > allowedAt && end === args.length, true, "the tool lists close the argument list");
  });

  it("pins the same lists when a model is chosen", () => {
    const withModel = claudeArgs("prompt", { maxTurns: 7, patchDir: "/tmp/p", model: "opus" });
    assert.deepEqual(withModel.slice(-2), ["--model", "opus"]);
    assert.deepEqual(withModel.slice(0, -2), args);
  });
});
