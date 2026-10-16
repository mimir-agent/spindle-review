import { gzipSync } from "node:zlib";
import type { Deps } from "../src/cli.ts";
import type { Finding } from "../src/review.ts";

export const OWNER_DID = "did:plc:owner111111111111111111";
export const REPO_DID = "did:plc:repo2222222222222222222";
export const AUTHOR_DID = "did:plc:author33333333333333333";
export const PULL_URI = `at://${AUTHOR_DID}/sh.tangled.repo.pull/3mxxpullrkey2`;
export const PULL_CID = "bafyreipullcid";
export const PDS = "https://pds.example.test";

export const SHA0 = "1111111111111111111111111111111111111111";
export const SHA1 = "2222222222222222222222222222222222222222";

export function patch(sha: string, file: string, added: string): string {
  return [
    `From ${sha} Mon Sep 17 00:00:00 2001`,
    "From: Someone <did:plc:someone>",
    "Subject: [PATCH] change",
    "",
    "---",
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1,2 @@",
    " keep",
    `+${added}`,
    "",
  ].join("\n");
}

export const ROUND0 = patch(SHA0, "src/a.ts", "first");
export const ROUND1 = patch(SHA1, "src/a.ts", "second");

export function pullValue(rounds: number) {
  return {
    $type: "sh.tangled.repo.pull",
    title: "Make a better",
    body: "Explains the change.",
    source: { branch: "feature" },
    target: { branch: "main", repo: REPO_DID },
    createdAt: "2026-10-15T00:00:00Z",
    rounds: Array.from({ length: rounds }, (_, i) => ({
      createdAt: "2026-10-15T00:00:00Z",
      patchBlob: { $type: "blob", mimeType: "application/gzip", ref: { $link: `bafkblob${i}` }, size: 1 },
    })),
  };
}

export interface FakeNet {
  fetch: Deps["fetch"];
  calls: { url: string; init?: RequestInit }[];
}

// A fake network for the public index, plc.directory, the author's PDS, and
// the reviewer's PDS. Every request is recorded.
// extraBlobs serves patch blobs for extraPulls, keyed by blob cid.
export function fakeNet(opts: { rounds?: number; extraPulls?: unknown[]; extraBlobs?: Record<string, string> } = {}): FakeNet {
  const rounds = opts.rounds ?? 2;
  const blobs = [ROUND0, ROUND1];
  const calls: FakeNet["calls"] = [];
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const u = new URL(url);
    if (u.pathname === "/xrpc/sh.tangled.repo.listPulls") {
      return json({ items: [{ uri: PULL_URI, cid: PULL_CID, value: pullValue(rounds), state: "open" }, ...(opts.extraPulls ?? [])] });
    }
    if (u.pathname === "/xrpc/sh.tangled.repo.getPull") {
      return json({ uri: PULL_URI, cid: PULL_CID, value: pullValue(rounds) });
    }
    if (u.hostname === "plc.directory") {
      return json({ service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] });
    }
    if (u.pathname === "/xrpc/com.atproto.sync.getBlob") {
      const cid = u.searchParams.get("cid") ?? "";
      const extra = opts.extraBlobs?.[cid];
      if (extra !== undefined) return new Response(gzipSync(extra), { status: 200 });
      const i = Number(cid.replace("bafkblob", ""));
      return new Response(gzipSync(blobs[i] ?? ""), { status: 200 });
    }
    if (u.pathname === "/xrpc/com.atproto.server.createSession") {
      return json({ accessJwt: "jwt-abc", did: "did:plc:reviewer" });
    }
    if (u.pathname === "/xrpc/com.atproto.repo.createRecord") {
      return json({ uri: "at://did:plc:reviewer/sh.tangled.feed.comment/3newcomment", cid: "bafycomment" });
    }
    return json({ error: "NotFound" }, 404);
  };
  return { fetch: f as Deps["fetch"], calls };
}

// Another open pull from the same source branch into the same target, the way
// stacked pulls on Tangled look. Its one round ends at headSha.
export function stackedPull(rkey: string, headSha: string) {
  const cid = `bafkstacked${rkey}`;
  return {
    pull: {
      uri: `at://${AUTHOR_DID}/sh.tangled.repo.pull/${rkey}`,
      cid: `bafyrei${rkey}`,
      state: "open",
      value: {
        ...pullValue(0),
        title: `Stacked ${rkey}`,
        rounds: [{ createdAt: "2026-10-15T00:00:00Z", patchBlob: { $type: "blob", mimeType: "application/gzip", ref: { $link: cid }, size: 1 } }],
      },
    },
    blobs: { [cid]: patch(headSha, "src/b.ts", `stacked ${rkey}`) },
  };
}

export const PIPELINE_ENV = {
  TANGLED_PIPELINE_KIND: "pull_request",
  TANGLED_REPO_DID: OWNER_DID,
  TANGLED_REPO_REPO_DID: REPO_DID,
  TANGLED_PR_SOURCE_BRANCH: "feature",
  TANGLED_PR_TARGET_BRANCH: "main",
};

export const FINDING: Finding = {
  file: "src/a.ts",
  line: 2,
  severity: "bug",
  problem: "The new line is evaluated twice.",
  trigger: "Any call with a non-empty list.",
  fix: "Hoist the call out of the loop.",
};

export interface Harness {
  deps: Deps;
  out: string[];
  err: string[];
  prompts: string[];
  net: FakeNet;
}

export function harness(env: Record<string, string>, findings: Finding[] = [], netOpts = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const net = fakeNet(netOpts);
  const deps: Deps = {
    env,
    fetch: net.fetch,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    review: async ({ prompt }) => {
      prompts.push(prompt);
      return findings;
    },
  };
  return { deps, out, err, prompts, net };
}
