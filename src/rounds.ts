// Which round to review, and what to show the model for it. Pure functions.
//
// Tangled stores each pull request round as a git-format-patch. Round indexes
// start at 0, the same numbers the Tangled UI shows as #0, #1, ...

export type ReviewPlan =
  | { kind: "full"; round: number }
  | { kind: "interdiff"; round: number; previous: number };

// Round 0 is reviewed in full. Every later round is reviewed as what changed
// since the round before it.
export function planFor(round: number, roundCount: number): ReviewPlan {
  if (!Number.isInteger(round) || round < 0 || round >= roundCount) {
    throw new Error(`Round #${round} does not exist; this pull request has ${roundCount} round(s).`);
  }
  return round === 0 ? { kind: "full", round } : { kind: "interdiff", round, previous: round - 1 };
}

// git format-patch writes one "From <sha> Mon Sep 17 00:00:00 2001" line per
// commit, oldest first. The last one is the head the round was made from.
export function headSha(patch: string): string | undefined {
  const matches = [...patch.matchAll(/^From ([0-9a-f]{40}) Mon Sep 17 00:00:00 2001$/gm)];
  return matches.at(-1)?.[1];
}

// The spindle tells us the source sha it is building. Find the round whose
// patch ends at that sha. Newest first, because a force-push back to an older
// head would produce a newer round with the same sha.
export function roundForSha(patches: readonly string[], sha: string): number | undefined {
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i];
    if (p !== undefined && headSha(p) === sha) return i;
  }
  return undefined;
}
