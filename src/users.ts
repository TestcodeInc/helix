/**
 * User accounts and invites, stored in VAULT_KV.
 *   user:<id>            → User
 *   useremail:<email>    → userId (login lookup)
 *   invite:<token>       → Invite
 */

export interface User {
  id: string;
  email: string;
  name: string;
  passHash: string;
  createdAt: string;
  /** Present only on self-serve signups awaiting email confirmation.
   * Deliberately inverted: absence means "fine" — invited users and every
   * account created before self-serve signup existed stay usable with no
   * migration. */
  unverified?: boolean;
}

export interface Invite {
  token: string;
  email: string;
  name: string;
  userId: string;
  createdAt: string;
  usedAt?: string;
}

const userKey = (id: string) => `user:${id}`;
const emailKey = (email: string) => `useremail:${email.toLowerCase().trim()}`;
const inviteKey = (token: string) => `invite:${token}`;

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "user"
  );
}

export async function getUser(kv: KVNamespace, id: string): Promise<User | null> {
  const raw = await kv.get(userKey(id));
  return raw ? (JSON.parse(raw) as User) : null;
}

export async function getUserByEmail(kv: KVNamespace, email: string): Promise<User | null> {
  const id = await kv.get(emailKey(email));
  return id ? getUser(kv, id) : null;
}

export async function createUser(
  kv: KVNamespace,
  data: { id: string; email: string; name: string; passHash: string; unverified?: boolean },
): Promise<User> {
  const user: User = { ...data, email: data.email.toLowerCase().trim(), createdAt: new Date().toISOString() };
  await kv.put(userKey(user.id), JSON.stringify(user));
  await kv.put(emailKey(user.email), user.id);
  return user;
}

/** A free, readable user id derived from the email local part. */
export async function uniqueUserId(kv: KVNamespace, email: string): Promise<string> {
  const base = slugify(email.split("@")[0]) || "user";
  if (!(await getUser(kv, base))) return base;
  for (let i = 2; i < 30; i++) {
    const candidate = `${base}${i}`;
    if (!(await getUser(kv, candidate))) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function markVerified(kv: KVNamespace, userId: string): Promise<void> {
  const user = await getUser(kv, userId);
  if (!user) return;
  const { unverified: _drop, ...verified } = user;
  await kv.put(userKey(user.id), JSON.stringify(verified));
}

export async function listUsers(kv: KVNamespace): Promise<User[]> {
  const list = await kv.list({ prefix: "user:" });
  const users: User[] = [];
  for (const k of list.keys) {
    const raw = await kv.get(k.name);
    if (raw) users.push(JSON.parse(raw) as User);
  }
  return users;
}

/** Delete a user and all their data (vault, pending queue, audit log). */
export async function deleteUser(kv: KVNamespace, user: User): Promise<void> {
  await Promise.all([
    kv.delete(userKey(user.id)),
    kv.delete(emailKey(user.email)),
    kv.delete(`vault:${user.id}`),
    kv.delete(`pending:${user.id}`),
    kv.delete(`audit:${user.id}`),
  ]);
}

export async function createInvite(
  kv: KVNamespace,
  data: { email: string; name: string; userId?: string },
): Promise<Invite> {
  const invite: Invite = {
    token: crypto.randomUUID(),
    email: data.email.toLowerCase().trim(),
    name: data.name,
    userId: data.userId?.trim() || slugify(data.email.split("@")[0]),
    createdAt: new Date().toISOString(),
  };
  await kv.put(inviteKey(invite.token), JSON.stringify(invite));
  return invite;
}

/** All invites that haven't been used yet. */
export async function listPendingInvites(kv: KVNamespace): Promise<Invite[]> {
  const list = await kv.list({ prefix: "invite:" });
  const invites: Invite[] = [];
  for (const k of list.keys) {
    const raw = await kv.get(k.name);
    if (raw) {
      const inv = JSON.parse(raw) as Invite;
      if (!inv.usedAt) invites.push(inv);
    }
  }
  return invites.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteInvite(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(`invite:${token}`);
}

export async function getInvite(kv: KVNamespace, token: string): Promise<Invite | null> {
  const raw = await kv.get(inviteKey(token));
  return raw ? (JSON.parse(raw) as Invite) : null;
}

export async function markInviteUsed(kv: KVNamespace, invite: Invite): Promise<void> {
  await kv.put(inviteKey(invite.token), JSON.stringify({ ...invite, usedAt: new Date().toISOString() }));
}
