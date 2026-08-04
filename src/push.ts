/**
 * APNs push from the Worker — the queue-rot antidote. When an app proposes
 * a learning, the owner's phone buzzes with Approve/Reject actions.
 *
 * Auth is an ES256 JWT signed with the Apple-issued .p8 key via WebCrypto.
 * Everything no-ops silently when APNS secrets aren't configured.
 */
import type { Env } from "./types";
import type { PendingLearning } from "./vault";
import { pushTokensFor } from "./devices";

let cachedJwt: { token: string; at: number } | null = null;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s));

async function apnsJwt(env: Env): Promise<string> {
  // APNs rejects tokens older than 1h and throttles refreshes under 20min.
  if (cachedJwt && Date.now() - cachedJwt.at < 45 * 60 * 1000) return cachedJwt.token;

  const pem = env.APNS_PRIVATE_KEY!.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64urlStr(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = b64urlStr(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }),
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const token = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
  cachedJwt = { token, at: Date.now() };
  return token;
}

export function pushConfigured(env: Env): boolean {
  return Boolean(env.APNS_PRIVATE_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID);
}

/** Notify all of a user's push-registered devices about a pending learning. */
export async function notifyPending(
  env: Env,
  userId: string,
  entry: PendingLearning,
  pendingCount: number,
): Promise<void> {
  if (!pushConfigured(env)) return;
  const tokens = await pushTokensFor(env.VAULT_KV, userId);
  if (tokens.length === 0) return;

  const host =
    env.APNS_ENV === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const jwt = await apnsJwt(env);
  /**
   * One notification, not one per fact.
   *
   * An assistant asked to populate an empty vault can propose twenty facts in
   * a row. Sent naively that is twenty buzzes during someone's first ten
   * minutes with the product — the opposite of the calm this is supposed to
   * feel like. APNs solves it properly: notifications sharing a collapse id
   * replace each other on the device, so a burst shows up as a single,
   * updating notification.
   *
   * A lone proposal still quotes the fact, because that's what makes an
   * approve-from-the-lock-screen decision possible without opening anything.
   */
  const burst = pendingCount > 1;
  const collapseId = `helix-review-${userId}`.slice(0, 64);
  const payload = JSON.stringify({
    aps: {
      alert: burst
        ? {
            title: "Waiting for your review",
            body: `${pendingCount} proposed memories, the latest from ${entry.client}.`,
          }
        : {
            title: `${entry.client} wants to remember`,
            body: `“${entry.fact.slice(0, 140)}”`,
          },
      badge: pendingCount,
      category: "HELIX_REVIEW",
      sound: "default",
      "thread-id": "helix-review",
    },
    // Only useful when there's exactly one thing to decide; a burst opens the
    // queue instead.
    ...(burst ? {} : { pendingId: entry.id }),
  });

  await Promise.all(
    tokens.map(async (token) => {
      try {
        await fetch(`https://${host}/3/device/${token}`, {
          method: "POST",
          headers: {
            authorization: `bearer ${jwt}`,
            "apns-topic": env.APNS_BUNDLE_ID!,
            "apns-push-type": "alert",
            "apns-priority": "10",
            // Replaces the previous review notification rather than stacking.
            "apns-collapse-id": collapseId,
          },
          body: payload,
        });
      } catch {
        // best effort — a dead device token must never break a proposal
      }
    }),
  );
}
