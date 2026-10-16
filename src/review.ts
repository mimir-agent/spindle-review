// Building the prompt, running the claude CLI, and turning its answer into the
// comment body.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewPlan } from "./rounds.ts";

export const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md", "REVIEW.md"] as const;

export interface Finding {
  file: string;
  line: number;
  severity: "bug" | "security" | "contract";
  problem: string;
  trigger: string;
  fix: string;
}

export interface ReviewInput {
  title: string;
  description: string;
  // Round 0: the model reads that round's patch. Later rounds: it reads both
  // patches from the patch dir and reviews only what changed between them.
  plan: ReviewPlan;
  guidance: { file: string; text: string }[];
  ciResultFile?: string;
}

const SEVERITIES = ["bug", "security", "contract"] as const;

export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          severity: { type: "string", enum: SEVERITIES },
          problem: { type: "string" },
          trigger: { type: "string" },
          fix: { type: "string" },
        },
        required: ["file", "line", "severity", "problem", "trigger", "fix"],
      },
    },
  },
  required: ["findings"],
} as const;

// Read-only tools. Bash is offered for git history only; --permission-mode
// dontAsk denies every command not on this list, and --restricted confines file
// reads to the working directory and the --add-dir we pass.
export const TOOLS = ["Read", "Grep", "Glob", "Bash"] as const;
export const ALLOWED_BASH = [
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git blame:*)",
  "Bash(git grep:*)",
] as const;
export const DISALLOWED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"] as const;

export function readGuidance(repoDir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const file of GUIDANCE_FILES) {
    const p = path.join(repoDir, file);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ file, text: fs.readFileSync(p, "utf8") });
  }
  return out;
}

export function buildPrompt(input: ReviewInput, patchDir: string): string {
  const { plan } = input;
  const lines: string[] = [];
  lines.push(
    "You are reviewing a pull request on Tangled. The repository is checked out in the current directory at the pull request's head.",
    "",
    `Title: ${input.title}`,
  );
  if (input.description.trim()) lines.push("Description:", input.description.trim());
  lines.push("");

  if (plan.kind === "full") {
    lines.push(
      `This is round #${plan.round}, the first submission. Review the whole change.`,
      `The patch is in ${path.join(patchDir, "round.patch")}.`,
    );
  } else {
    lines.push(
      `This is round #${plan.round}. Round #${plan.previous} was already reviewed.`,
      `Review only what changed between the two rounds: code that is new or different in round #${plan.round}.`,
      `Round #${plan.previous}: ${path.join(patchDir, "previous.patch")}`,
      `Round #${plan.round}: ${path.join(patchDir, "round.patch")}`,
      "Do not report problems that were already present, unchanged, in the previous round.",
    );
  }
  lines.push("");

  if (input.guidance.length > 0) {
    lines.push("The repository's own guidance for contributors and reviewers follows. Hold the change to it.");
    for (const g of input.guidance) lines.push(`--- ${g.file} ---`, g.text.trim(), `--- end ${g.file} ---`);
    lines.push("");
  }
  if (input.ciResultFile) {
    lines.push(`A CI result for this round is in ${input.ciResultFile}. Read it; do not rerun the tests.`, "");
  }

  lines.push(
    "Report only findings a maintainer must act on before merging:",
    "- bug: wrong behavior, a crash, data loss, a race, a resource leak.",
    "- security: an injection, an auth or permission hole, a leaked secret, unsafe input handling.",
    "- contract: a broken API, schema, protocol or documented promise that callers rely on.",
    "Do not report style, naming, formatting, missing comments, missing tests, refactoring ideas, or anything you are unsure of.",
    "Check each finding against the code before you report it. If you cannot point to the line that is wrong and say what input makes it go wrong, leave it out.",
    "An empty list is a good answer when nothing matters.",
    "",
    "For each finding give: file (path relative to the repo root), line (in the new version of the file), severity,",
    "problem (one or two sentences), trigger (what input or sequence makes it happen), fix (one or two sentences).",
    "You may read files and run read-only git commands. You cannot edit anything.",
  );
  return lines.join("\n");
}

export function claudeArgs(prompt: string, opts: { maxTurns: number; patchDir: string; model?: string }): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(FINDINGS_SCHEMA),
    "--max-turns",
    String(opts.maxTurns),
    "--restricted",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--add-dir",
    opts.patchDir,
    "--tools",
    TOOLS.join(","),
    "--allowedTools",
    ...ALLOWED_BASH,
    "--disallowedTools",
    ...DISALLOWED,
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export class ReviewError extends Error {
  override name = "ReviewError";
}

export function parseClaudeResult(stdout: string): Finding[] {
  let out: { is_error?: boolean; subtype?: string; structured_output?: unknown };
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new ReviewError("The claude CLI did not return JSON.");
  }
  if (out.is_error || out.subtype !== "success") {
    throw new ReviewError(`The review did not finish (${out.subtype ?? "unknown result"}).`);
  }
  const so = out.structured_output as { findings?: unknown } | undefined;
  if (!so || !Array.isArray(so.findings)) throw new ReviewError("The review returned no findings list.");
  return so.findings.map(checkFinding);
}

function checkFinding(raw: unknown): Finding {
  const f = raw as Record<string, unknown>;
  const str = (k: string): string => {
    if (typeof f[k] !== "string" || (f[k] as string).trim() === "") throw new ReviewError(`A finding has no ${k}.`);
    return (f[k] as string).trim();
  };
  if (!Number.isInteger(f.line) || (f.line as number) < 1) throw new ReviewError("A finding has no line.");
  const severity = str("severity");
  if (!(SEVERITIES as readonly string[]).includes(severity)) throw new ReviewError(`Unknown severity ${severity}.`);
  return {
    file: str("file"),
    line: f.line as number,
    severity: severity as Finding["severity"],
    problem: str("problem"),
    trigger: str("trigger"),
    fix: str("fix"),
  };
}

export const MARKER = "<!-- spindle-review -->";

// The comment body, or null when there is nothing to post.
export function renderComment(findings: readonly Finding[], round: number, opts: { quietWhenClean: boolean }): string | null {
  if (findings.length === 0) return opts.quietWhenClean ? null : `No issues found in round #${round}.`;
  const out: string[] = [];
  const noun = findings.length === 1 ? "issue" : "issues";
  out.push(`**Round #${round}: ${findings.length} ${noun} to fix before merging.**`, "");
  findings.forEach((f, i) => {
    out.push(
      `${i + 1}. \`${f.file}:${f.line}\` (${f.severity}) ${f.problem}`,
      `   Triggered when: ${f.trigger}`,
      `   Fix: ${f.fix}`,
      "",
    );
  });
  out.push(MARKER);
  return out.join("\n");
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runClaude(
  bin: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
