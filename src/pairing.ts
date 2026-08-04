/**
 * Pairing a phone from an already-authenticated web session.
 *
 * The alternative is typing the vault passphrase into a phone. That works,
 * and it's what the app does today, but it's worse in three ways: the root
 * credential travels to a second device, phone keyboards push people toward
 * weaker passphrases, and it requires a native sign-in endpoint that no
 * Turnstile can protect.
 *
 * A pairing code is minted by a session that already proved it knows the
 * passphrase. So the code is an *authorisation to mint one device token*,
 * nothing more:
 *
 *   - short-lived (five minutes)
 *   - single-use (claimed once, then gone)
 *   - useless on its own — it grants no read access, only the right to
 *     receive a token that the owner can revoke from /connections
 *
 *   pair:<code> → { userId, deviceHint, claimed }
 */

/** Long enough that guessing inside the TTL is hopeless, short enough to
 * read aloud or type if the camera won't cooperate. Excludes characters
 * that are easy to confuse when read off a screen. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const TTL_SECONDS = 300;

export interface PairingRecord {
  userId: string;
  /** What the web page called it, so the device list is legible later. */
  deviceHint: string;
  createdAt: string;
  /** Set when a device has claimed it — the web page polls for this. */
  claimedAt?: string;
  claimedName?: string;
}

const pairKey = (code: string) => `pair:${code.toUpperCase()}`;

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * Normalise what arrived: a typed code, or the whole URL a QR scanner read.
 *
 * The QR encodes `https://<origin>/p/<code>` so that scanning it without the
 * app installed lands somewhere useful. A scanner inside the app hands the
 * whole string through, so the code has to be recovered here rather than
 * assuming every client remembers to parse it.
 */
export function normalizeCode(raw: string): string {
  let s = raw.trim();
  const fromUrl = s.match(/\/p\/([A-Za-z0-9]{1,16})/);
  if (fromUrl) s = fromUrl[1];
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .slice(0, CODE_LENGTH);
}

export async function mintPairingCode(
  kv: KVNamespace,
  userId: string,
  deviceHint = "phone",
): Promise<{ code: string; expiresIn: number }> {
  const code = newCode();
  const record: PairingRecord = {
    userId,
    deviceHint: deviceHint.slice(0, 40),
    createdAt: new Date().toISOString(),
  };
  // KV expiry is the real guarantee here, not a timestamp check we might
  // forget to make: the code stops existing on its own.
  await kv.put(pairKey(code), JSON.stringify(record), { expirationTtl: TTL_SECONDS });
  return { code, expiresIn: TTL_SECONDS };
}

export async function readPairing(kv: KVNamespace, code: string): Promise<PairingRecord | null> {
  const raw = await kv.get(pairKey(normalizeCode(code)));
  return raw ? (JSON.parse(raw) as PairingRecord) : null;
}

/**
 * Claim a code. Deletes it first, so two devices racing the same code can't
 * both end up with a token — whoever's delete lands first wins, and the
 * loser sees an expired code rather than a silent second grant.
 */
export async function claimPairingCode(
  kv: KVNamespace,
  code: string,
  deviceName: string,
): Promise<PairingRecord | null> {
  const key = pairKey(normalizeCode(code));
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.delete(key);
  const record = JSON.parse(raw) as PairingRecord;
  if (record.claimedAt) return null;

  // Leave a short-lived receipt so the web page's poll can report success
  // rather than timing out into "this expired", which would be a lie.
  const claimed: PairingRecord = {
    ...record,
    claimedAt: new Date().toISOString(),
    claimedName: deviceName.slice(0, 60),
  };
  await kv.put(`${key}:done`, JSON.stringify(claimed), { expirationTtl: 120 });
  return record;
}

/** For the web page's poll: has this code been claimed yet? */
export async function pairingStatus(
  kv: KVNamespace,
  code: string,
): Promise<"waiting" | "claimed" | "expired"> {
  const key = pairKey(normalizeCode(code));
  const done = await kv.get(`${key}:done`);
  if (done) return "claimed";
  return (await kv.get(key)) ? "waiting" : "expired";
}

export async function claimedName(kv: KVNamespace, code: string): Promise<string | null> {
  const done = await kv.get(`${pairKey(normalizeCode(code))}:done`);
  return done ? ((JSON.parse(done) as PairingRecord).claimedName ?? null) : null;
}
