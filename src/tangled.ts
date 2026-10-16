// Reading pull requests from Tangled and writing the review comment back.
//
// Reads use public endpoints only:
//   - api.tangled.org (Tangled's public index, "Bobbin") for sh.tangled.repo.listPulls / getPull
//   - the pull author's PDS for the round patch blobs (com.atproto.sync.getBlob)
// The write is one com.atproto.repo.createRecord on the reviewer account's PDS.

import { gunzipSync } from "node:zlib";

export type Fetch = typeof fetch;

export const DEFAULT_INDEX = "https://api.tangled.org";
export const COMMENT_NSID = "sh.tangled.feed.comment";
export const PULL_NSID = "sh.tangled.repo.pull";

export interface PullRound {
  createdAt: string;
  patchBlob: { ref: { $link: string } };
}

export interface PullRecord {
  title: string;
  body?: string;
  source?: { branch: string; repo?: string };
  target: { branch: string; repo: string };
  rounds: PullRound[];
}

export interface Pull {
  uri: string;
  cid: string;
  record: PullRecord;
}

export interface CommentRecord {
  $type: typeof COMMENT_NSID;
  subject: { uri: string; cid: string };
  body: { $type: "sh.tangled.markup.markdown"; text: string };
  createdAt: string;
  pullRoundIdx: number;
}

export function commentRecord(pull: Pick<Pull, "uri" | "cid">, round: number, text: string, now: Date): CommentRecord {
  return {
    $type: COMMENT_NSID,
    subject: { uri: pull.uri, cid: pull.cid },
    body: { $type: "sh.tangled.markup.markdown", text },
    createdAt: now.toISOString(),
    pullRoundIdx: round,
  };
}

export function parsePullUri(uri: string): { did: string; rkey: string } {
  const m = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/sh\.tangled\.repo\.pull\/([A-Za-z0-9._~:-]+)$/.exec(uri);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`Not a Tangled pull request AT-URI: ${uri}`);
  }
  return { did: m[1], rkey: m[2] };
}

export async function getPull(f: Fetch, index: string, uri: string): Promise<Pull> {
  const body = await getJson(f, `${index}/xrpc/sh.tangled.repo.getPull?pull=${encodeURIComponent(uri)}`);
  return toPull(body);
}

// The spindle does not tell a step which pull request started it. It does give
// the repo DID and the source and target branches, so look the pull up by those.
// Only same-repo branch pulls get secrets on a spindle, so a pull whose source
// lives in another repo is never the one we were started for.
export async function findOpenPull(
  f: Fetch,
  index: string,
  repoDid: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<Pull> {
  const matches: Pull[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ subject: repoDid, status: "open", limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const page = (await getJson(f, `${index}/xrpc/sh.tangled.repo.listPulls?${q}`)) as {
      items?: unknown[];
      cursor?: string | null;
    };
    for (const item of page.items ?? []) {
      const pull = toPull(item);
      const src = pull.record.source;
      if (src === undefined) continue;
      if (src.repo !== undefined && src.repo !== repoDid) continue;
      if (src.branch !== sourceBranch || pull.record.target.branch !== targetBranch) continue;
      matches.push(pull);
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);

  if (matches.length === 0) {
    throw new Error(`No open same-repo pull request from ${sourceBranch} into ${targetBranch} in ${repoDid}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} open pull requests from ${sourceBranch} into ${targetBranch}; pass --pull to pick one: ` +
        matches.map((m) => m.uri).join(", "),
    );
  }
  return matches[0] as Pull;
}

export async function resolvePds(f: Fetch, did: string): Promise<string> {
  let docUrl: string;
  if (did.startsWith("did:plc:")) docUrl = `https://plc.directory/${did}`;
  else if (did.startsWith("did:web:")) docUrl = `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  else throw new Error(`Unsupported DID method: ${did}`);

  const doc = (await getJson(f, docUrl)) as { service?: { id?: string; serviceEndpoint?: unknown }[] };
  const pds = doc.service?.find((s) => s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`);
  if (typeof pds?.serviceEndpoint !== "string") throw new Error(`No PDS listed in the DID document for ${did}.`);
  return pds.serviceEndpoint.replace(/\/+$/, "");
}

// Every round's patch, oldest first. Each is a gzipped git-format-patch blob in
// the pull author's repository.
export async function fetchRoundPatches(f: Fetch, pull: Pull): Promise<string[]> {
  const { did } = parsePullUri(pull.uri);
  const pds = await resolvePds(f, did);
  const out: string[] = [];
  for (const round of pull.record.rounds) {
    const cid = round.patchBlob.ref.$link;
    const res = await f(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`);
    if (!res.ok) throw new Error(`Fetching patch blob ${cid} from ${pds} failed: HTTP ${res.status}`);
    out.push(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"));
  }
  return out;
}

export interface PostTarget {
  identifier: string;
  password: string;
  pds?: string;
}

// Log in as the reviewer account with an app password and write the comment.
// Returns the new record's AT-URI.
export async function postComment(f: Fetch, target: PostTarget, record: CommentRecord): Promise<string> {
  const pds = target.pds ?? (await resolvePds(f, await resolveHandle(f, target.identifier)));
  const session = (await postJson(f, `${pds}/xrpc/com.atproto.server.createSession`, undefined, {
    identifier: target.identifier,
    password: target.password,
  })) as { accessJwt?: string; did?: string };
  if (!session.accessJwt || !session.did) throw new Error("createSession returned no session.");

  const created = (await postJson(f, `${pds}/xrpc/com.atproto.repo.createRecord`, session.accessJwt, {
    repo: session.did,
    collection: COMMENT_NSID,
    validate: false,
    record,
  })) as { uri?: string };
  if (!created.uri) throw new Error("createRecord returned no uri.");
  return created.uri;
}

async function resolveHandle(f: Fetch, identifier: string): Promise<string> {
  if (identifier.startsWith("did:")) return identifier;
  const body = (await getJson(
    f,
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`,
  )) as { did?: string };
  if (!body.did) throw new Error(`Could not resolve handle ${identifier}.`);
  return body.did;
}

function toPull(item: unknown): Pull {
  const o = item as { uri?: unknown; cid?: unknown; value?: unknown };
  if (typeof o.uri !== "string" || typeof o.cid !== "string" || typeof o.value !== "object" || o.value === null) {
    throw new Error("Malformed pull record from the Tangled index.");
  }
  const record = o.value as PullRecord;
  if (!Array.isArray(record.rounds) || typeof record.target?.branch !== "string") {
    throw new Error(`Pull record ${o.uri} has no rounds or target.`);
  }
  return { uri: o.uri, cid: o.cid, record };
}

async function getJson(f: Fetch, url: string): Promise<unknown> {
  const res = await f(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
}

// Error messages carry the URL and status only, never the request body, which
// holds the app password on createSession.
async function postJson(f: Fetch, url: string, jwt: string | undefined, body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const res = await f(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`POST ${url} failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json();
}
