/**
 * Owner devices — the OWNER door, distinct from OAuth app grants.
 *
 * An owner device authenticates with the vault passphrase (once) and holds
 * a long-lived device token. Crucially, this power is NOT an OAuth scope:
 * no app can request it on a consent screen. It exists so the owner's own
 * phone can approve/reject learnings — including from a push notification.
 *
 *   device:<sha256(token)>  → OwnerDevice        (auth lookup)
 *   devices:<userId>        → OwnerDeviceRef[]   (listing/revocation)
 */

export interface OwnerDevice {
  userId: string;
  deviceName: string;
  createdAt: string;
  /** APNs token, once the device registers for push. */
  apnsToken?: string;
}

export interface OwnerDeviceRef {
  tokenHash: string;
  deviceName: string;
  createdAt: string;
  hasPush: boolean;
}

const deviceKey = (hash: string) => `device:${hash}`;
const listKey = (userId: string) => `devices:${userId}`;

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listDevices(kv: KVNamespace, userId: string): Promise<OwnerDeviceRef[]> {
  const raw = await kv.get(listKey(userId));
  return raw ? (JSON.parse(raw) as OwnerDeviceRef[]) : [];
}

/** Mint a device token for a verified owner. Returns the raw token (shown
 * once, stored only as a hash — a KV leak can't impersonate devices). */
export async function createDevice(
  kv: KVNamespace,
  userId: string,
  deviceName: string,
): Promise<string> {
  const raw = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hash = await sha256hex(raw);
  const device: OwnerDevice = {
    userId,
    deviceName: deviceName.slice(0, 60) || "iOS device",
    createdAt: new Date().toISOString(),
  };
  const list = await listDevices(kv, userId);
  list.push({ tokenHash: hash, deviceName: device.deviceName, createdAt: device.createdAt, hasPush: false });
  await Promise.all([
    kv.put(deviceKey(hash), JSON.stringify(device)),
    kv.put(listKey(userId), JSON.stringify(list)),
  ]);
  return raw;
}

/** Resolve a bearer device token → owner device, or null. */
export async function getDeviceByToken(
  kv: KVNamespace,
  rawToken: string,
): Promise<(OwnerDevice & { tokenHash: string }) | null> {
  const hash = await sha256hex(rawToken);
  const raw = await kv.get(deviceKey(hash));
  return raw ? { ...(JSON.parse(raw) as OwnerDevice), tokenHash: hash } : null;
}

export async function setDevicePushToken(
  kv: KVNamespace,
  tokenHash: string,
  apnsToken: string,
): Promise<void> {
  const raw = await kv.get(deviceKey(tokenHash));
  if (!raw) return;
  const device = JSON.parse(raw) as OwnerDevice;
  device.apnsToken = apnsToken;
  const list = await listDevices(kv, device.userId);
  const entry = list.find((d) => d.tokenHash === tokenHash);
  if (entry) entry.hasPush = true;
  await Promise.all([
    kv.put(deviceKey(tokenHash), JSON.stringify(device)),
    kv.put(listKey(device.userId), JSON.stringify(list)),
  ]);
}

export async function revokeDevice(
  kv: KVNamespace,
  userId: string,
  tokenHash: string,
): Promise<void> {
  const list = (await listDevices(kv, userId)).filter((d) => d.tokenHash !== tokenHash);
  await Promise.all([
    kv.delete(deviceKey(tokenHash)),
    kv.put(listKey(userId), JSON.stringify(list)),
  ]);
}

/** APNs tokens for every push-registered device of a user. */
export async function pushTokensFor(kv: KVNamespace, userId: string): Promise<string[]> {
  const refs = (await listDevices(kv, userId)).filter((d) => d.hasPush);
  const tokens: string[] = [];
  for (const ref of refs) {
    const raw = await kv.get(deviceKey(ref.tokenHash));
    const apns = raw ? (JSON.parse(raw) as OwnerDevice).apnsToken : undefined;
    if (apns) tokens.push(apns);
  }
  return tokens;
}
