/**
 * Fixed-window rate limiting and Turnstile verification.
 *
 * KV is eventually consistent, so a determined attacker can squeeze a few
 * extra requests through a window boundary. That's fine: this is abuse
 * deterrence, not a security boundary — the security boundaries are
 * passphrase hashing, scopes, and token revocation. Deliberately built on
 * KV rather than Cloudflare's native rate-limiting binding so a
 * self-hosted vault behaves identically.
 */
import type { Env } from "./types";

/** Caller identity for limiting: real client IP, else a shared bucket. */
export function clientId(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function rateLimit(
  kv: KVNamespace,
  bucket: string,
  id: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${id}:${window}`;
  const current = Number((await kv.get(key)) ?? "0");
  if (current >= max) return false;
  await kv.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSec * 2) });
  return true;
}

/** Verify a Turnstile token. Passes when unconfigured (dev, self-host). */
export async function verifyTurnstile(env: Env, req: Request, token: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET_KEY);
    body.append("response", token);
    body.append("remoteip", clientId(req));
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const out = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!out.success) {
      console.warn(`[turnstile] rejected: ${(out["error-codes"] ?? []).join(", ")}`);
    }
    return out.success === true;
  } catch (err) {
    console.error(`[turnstile] verification failed: ${String(err)}`);
    return false;
  }
}

/** Widget markup — renders nothing when Turnstile isn't configured. */
export function turnstileWidget(env: Env): string {
  if (!env.TURNSTILE_SITE_KEY) return "";
  return `<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-theme="dark" style="margin:12px 0"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
}

/** Cap on un-reviewed proposals per user — stops a chatty or hostile app
 * from burying the review queue (and from filling KV). */
export const MAX_PENDING = 100;

/** Cap on a single proposed fact. An entry that doesn't fit is usually two
 * entries, or a summary that should have been trimmed. */
export const MAX_FACT_CHARS = 500;
