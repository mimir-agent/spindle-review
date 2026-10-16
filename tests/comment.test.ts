import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMENT_NSID, commentRecord, parsePullUri } from "../src/tangled.ts";
import { MARKER, parseClaudeResult, renderComment } from "../src/review.ts";
import { FINDING, PULL_CID, PULL_URI } from "./fixtures.ts";

describe("comment record", () => {
  it("matches sh.tangled.feed.comment: strongRef subject, markdown body, createdAt, pullRoundIdx", () => {
    const rec = commentRecord({ uri: PULL_URI, cid: PULL_CID }, 1, "body text", new Date("2026-10-15T12:00:00.000Z"));
    assert.deepEqual(rec, {
      $type: COMMENT_NSID,
      subject: { uri: PULL_URI, cid: PULL_CID },
      body: { $type: "sh.tangled.markup.markdown", text: "body text" },
      createdAt: "2026-10-15T12:00:00.000Z",
      pullRoundIdx: 1,
    });
    assert.equal("replyTo" in rec, false, "top-level comment, never a reply");
  });

  it("keeps pullRoundIdx 0 for the first round", () => {
    const rec = commentRecord({ uri: PULL_URI, cid: PULL_CID }, 0, "x", new Date());
    assert.equal(rec.pullRoundIdx, 0);
  });

  it("parses pull AT-URIs and rejects other collections", () => {
    assert.deepEqual(parsePullUri(PULL_URI), { did: "did:plc:author33333333333333333", rkey: "3mxxpullrkey2" });
    assert.throws(() => parsePullUri("at://did:plc:x/sh.tangled.repo.issue/abc"), /Not a Tangled pull request/);
  });
});

describe("comment body", () => {
  it("is one line when nothing matters", () => {
    assert.equal(renderComment([], 2, { quietWhenClean: false }), "No issues found in round #2.");
  });

  it("is nothing at all when configured to stay quiet", () => {
    assert.equal(renderComment([], 2, { quietWhenClean: true }), null);
  });

  it("states problem, trigger and fix with file:line for each finding, and nothing else", () => {
    const body = renderComment([FINDING], 0, { quietWhenClean: true }) as string;
    assert.match(body, /`src\/a\.ts:2` \(bug\) The new line is evaluated twice\./);
    assert.match(body, /Triggered when: Any call with a non-empty list\./);
    assert.match(body, /Fix: Hoist the call out of the loop\./);
    assert.ok(body.startsWith("**Round #0: 1 issue to fix before merging.**"));
    assert.ok(body.endsWith(MARKER));
  });
});

describe("claude output", () => {
  const ok = (findings: unknown) => JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { findings } });

  it("reads structured findings", () => {
    assert.deepEqual(parseClaudeResult(ok([FINDING])), [FINDING]);
    assert.deepEqual(parseClaudeResult(ok([])), []);
  });

  it("fails when the run hit its turn cap instead of answering", () => {
    const capped = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true });
    assert.throws(() => parseClaudeResult(capped), /did not finish \(error_max_turns\)/);
  });

  it("rejects findings without a line or with an unknown severity", () => {
    assert.throws(() => parseClaudeResult(ok([{ ...FINDING, line: 0 }])), /no line/);
    assert.throws(() => parseClaudeResult(ok([{ ...FINDING, severity: "style" }])), /Unknown severity/);
  });
});
