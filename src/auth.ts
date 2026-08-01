/**
 * Auth primitives: PBKDF2 passphrase hashing + HMAC-signed session cookies.
 * No external services — WebCrypto only.
 */

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

const PBKDF2_ITERS = 100_000;

export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERS },
    key,
    256,
  );
  return `${toHex(salt)}:${toHex(bits)}`;
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: PBKDF2_ITERS },
    key,
    256,
  );
  const a = toHex(bits);
  // constant-time compare
  if (a.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}

const SESSION_DAYS = 7;

/** Cookie value: userId.expiryEpoch.signature */
export async function createSessionCookie(userId: string, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = await hmacHex(`${userId}.${exp}`, secret);
  const value = `${userId}.${exp}.${sig}`;
  return `helix_session=${value}; HttpOnly; Secure; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax`;
}

export const CLEAR_SESSION_COOKIE = "helix_session=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax";

const ADMIN_HOURS = 2;

/** Short-lived admin cookie, set after a correct ADMIN_SECRET. */
export async function createAdminCookie(secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_HOURS * 3600;
  const sig = await hmacHex(`admin.${exp}`, secret);
  return `helix_admin=${exp}.${sig}; HttpOnly; Secure; Path=/; Max-Age=${ADMIN_HOURS * 3600}; SameSite=Lax`;
}

export async function verifyAdminCookie(
  cookieHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  const match = (cookieHeader ?? "").match(/helix_admin=(\d+)\.([a-f0-9]+)/);
  if (!match) return false;
  const exp = parseInt(match[1], 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  return match[2] === (await hmacHex(`admin.${exp}`, secret));
}

/** Returns userId if the session cookie is valid, else null. */
export async function verifySessionCookie(
  cookieHeader: string | undefined,
  secret: string,
): Promise<string | null> {
  const match = (cookieHeader ?? "").match(/helix_session=([A-Za-z0-9._-]+)/);
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmacHex(`${userId}.${exp}`, secret);
  return sig === expected ? userId : null;
}
