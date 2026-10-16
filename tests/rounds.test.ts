import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headSha, planFor, roundForSha } from "../src/rounds.ts";
import { ROUND0, ROUND1, SHA0, SHA1, patch } from "./fixtures.ts";

describe("round selection", () => {
  it("reviews round 0 in full", () => {
    assert.deepEqual(planFor(0, 1), { kind: "full", round: 0 });
  });

  it("reviews later rounds as the change since the round before", () => {
    assert.deepEqual(planFor(1, 2), { kind: "interdiff", round: 1, previous: 0 });
    assert.deepEqual(planFor(3, 4), { kind: "interdiff", round: 3, previous: 2 });
  });

  it("rejects a round that does not exist", () => {
    assert.throws(() => planFor(2, 2), /Round #2 does not exist/);
    assert.throws(() => planFor(-1, 2), /does not exist/);
  });

  it("reads the head sha from the last commit of a multi-commit patch", () => {
    const two = patch(SHA0, "a", "x") + patch(SHA1, "b", "y");
    assert.equal(headSha(two), SHA1);
    assert.equal(headSha("no header here"), undefined);
  });

  it("finds the round built by the pipeline from its sha, newest first", () => {
    assert.equal(roundForSha([ROUND0, ROUND1], SHA1), 1);
    assert.equal(roundForSha([ROUND0, ROUND1], SHA0), 0);
    assert.equal(roundForSha([ROUND0, ROUND1, ROUND0], SHA0), 2);
    assert.equal(roundForSha([ROUND0], "f".repeat(40)), undefined);
  });
});
