/**
 * Transactional email via Resend (helix.ai is the verified sending
 * domain; send.helix.ai carries Resend's bounce/return-path records).
 * Two messages only: verify your email, reset your
 * passphrase. Both plain text on purpose — a vault that opens with a
 * marketing template starts the relationship wrong.
 *
 * Self-hosters without a RESEND_API_KEY still get a working signup: the
 * verification link is shown on screen instead (to the same person who
 * just typed the address). Reset links are NEVER shown — self-hosted
 * passphrase recovery goes through /admin.
 */
import type { Env } from "./types";

export const emailConfigured = (env: Env) => Boolean(env.RESEND_API_KEY);

async function send(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn("[email] no RESEND_API_KEY — falling back to on-screen link");
    return false;
  }
  const from = env.EMAIL_FROM ?? "Helix <hello@helix.ai>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      // The provider's message is the whole debugging story — surface it
      // in the worker log rather than swallowing it.
      console.error(
        `[email] resend rejected ${res.status}: ${(await res.text()).slice(0, 400)} (from="${from}" to="${to}")`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[email] resend request failed: ${String(err)}`);
    return false;
  }
}

export function sendVerification(
  env: Env,
  to: string,
  name: string,
  link: string,
): Promise<boolean> {
  return send(
    env,
    to,
    "Confirm your Helix vault",
    `Hi ${name},

Confirm this address and your vault is ready:

${link}

Your vault is the one place your AI apps read from — you decide what goes
in it, you can see every time an app reads it, and you can cut any app off
in one click.

If you didn't sign up for Helix, you can ignore this — nothing was created
that you'd need to undo.

— Helix
${env.PUBLIC_ORIGIN ?? "https://vault.helix.ai"}`,
  );
}

export function sendReset(env: Env, to: string, name: string, link: string): Promise<boolean> {
  return send(
    env,
    to,
    "Reset your Helix passphrase",
    `Hi ${name},

Set a new passphrase here — the link works for one hour:

${link}

Your vault and everything in it is untouched. Apps you've connected stay
connected.

If you didn't ask for this, ignore it and your passphrase stays as it is.

— Helix
${env.PUBLIC_ORIGIN ?? "https://vault.helix.ai"}`,
  );
}
