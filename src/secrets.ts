// Model auth and secret handling. Nothing in this file prints a secret; the
// Redactor exists so that nothing anywhere else does either.

export const MODEL_AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
export const POSTING_SECRET_VARS = ["ATP_APP_PASSWORD"] as const;

export type Env = Readonly<Record<string, string | undefined>>;

export class AuthError extends Error {
  override name = "AuthError";
}

export type ModelAuth = "oauth-token" | "api-key" | "local-login";

// The reviewer needs one way to reach the model. In CI that is a secret set on
// the spindle. On a laptop, --local-auth says "use the claude CLI's own login".
export function modelAuth(env: Env, localAuth: boolean): ModelAuth {
  if (nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN)) return "oauth-token";
  if (nonEmpty(env.ANTHROPIC_API_KEY)) return "api-key";
  if (localAuth) return "local-login";
  throw new AuthError(
    "No model credentials. Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY " +
      "as a spindle secret. To use the claude CLI's own login on your machine, pass --local-auth.",
  );
}

// The env handed to the claude child: everything except the posting secret,
// which the model has no reason to see.
export function childEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if ((POSTING_SECRET_VARS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export class Redactor {
  #values = new Set<string>();

  constructor(env: Env) {
    for (const k of [...MODEL_AUTH_VARS, ...POSTING_SECRET_VARS]) {
      const v = env[k];
      if (nonEmpty(v)) this.add(v);
    }
  }

  add(value: string): void {
    if (value.length > 0) this.#values.add(value);
  }

  apply(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is replaced whole.
    for (const v of [...this.#values].sort((a, b) => b.length - a.length)) {
      out = out.split(v).join("[redacted]");
    }
    return out;
  }
}

function nonEmpty(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== "";
}
