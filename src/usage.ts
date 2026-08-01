/**
 * Generation limits — the cost fuse.
 *
 * Nobody pays yet, but every generation spends real provider money, so
 * caps ship before strangers do. Design goals: limits are *configuration*
 * (wrangler vars, changeable without a code change), overridable per user
 * (beta users, yourself, a design partner), and enforced before any
 * provider call so a capped user never costs a cent.
 *
 *   usage:<userId>:<YYYY-MM>  → { images, speech }   (rolls over monthly)
 *   limits:<userId>           → { images?, speech? } (optional override)
 */
import type { Env } from "./types";

export type GenerationKind = "images" | "speech";

export interface Limits {
  images: number;
  speech: number;
}

export interface Usage {
  images: number;
  speech: number;
}

const DEFAULTS: Limits = { images: 20, speech: 20 };

const period = () => new Date().toISOString().slice(0, 7); // YYYY-MM
const usageKey = (userId: string) => `usage:${userId}:${period()}`;
const limitKey = (userId: string) => `limits:${userId}`;

const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Effective limits: per-user override, else env config, else defaults.
 * A limit of -1 means unlimited. */
export async function limitsFor(env: Env, userId: string): Promise<Limits> {
  const base: Limits = {
    images: num(env.FREE_IMAGES_PER_MONTH, DEFAULTS.images),
    speech: num(env.FREE_SPEECH_PER_MONTH, DEFAULTS.speech),
  };
  const raw = await env.VAULT_KV.get(limitKey(userId));
  if (!raw) return base;
  const override = JSON.parse(raw) as Partial<Limits>;
  return {
    images: typeof override.images === "number" ? override.images : base.images,
    speech: typeof override.speech === "number" ? override.speech : base.speech,
  };
}

export async function setLimits(
  kv: KVNamespace,
  userId: string,
  limits: Partial<Limits>,
): Promise<void> {
  await kv.put(limitKey(userId), JSON.stringify(limits));
}

export async function usageFor(kv: KVNamespace, userId: string): Promise<Usage> {
  const raw = await kv.get(usageKey(userId));
  return raw ? (JSON.parse(raw) as Usage) : { images: 0, speech: 0 };
}

/** True when the user may generate. Unlimited when the limit is negative. */
export async function withinLimit(
  env: Env,
  userId: string,
  kind: GenerationKind,
): Promise<{ ok: true } | { ok: false; used: number; limit: number }> {
  const [limits, usage] = await Promise.all([
    limitsFor(env, userId),
    usageFor(env.VAULT_KV, userId),
  ]);
  const limit = limits[kind];
  if (limit < 0) return { ok: true };
  return usage[kind] < limit ? { ok: true } : { ok: false, used: usage[kind], limit };
}

/** Count a *successful* generation. Failures never consume quota. */
export async function recordUsage(
  kv: KVNamespace,
  userId: string,
  kind: GenerationKind,
): Promise<void> {
  const usage = await usageFor(kv, userId);
  usage[kind] += 1;
  // TTL keeps old months from accumulating: ~70 days covers the rollover.
  await kv.put(usageKey(userId), JSON.stringify(usage), { expirationTtl: 6_048_000 });
}

/** Friendly, non-scolding message for a capped user. */
export function limitMessage(kind: GenerationKind, used: number, limit: number): string {
  const what = kind === "images" ? "images" : "voice clips";
  return `Monthly limit reached — ${used} of ${limit} ${what} generated this month. Your vault is unaffected; the limit resets at the start of next month.`;
}
