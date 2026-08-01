/**
 * Helix vault — storage layer. Multi-user: every key is scoped by userId.
 *   vault:<userId>    → Vault (JSON)
 *   pending:<userId>  → PendingLearning[]
 *   audit:<userId>    → AuditEntry[]
 */

export const CATEGORIES = [
  "identity",
  "work",
  "projects",
  "preferences",
  "relationships",
  "communication-style",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface LearnedFact {
  fact: string;
  source: string;
  date: string; // YYYY-MM-DD
}

export type Vault = Record<Category, { base: string[]; learned: LearnedFact[] }>;

export interface PendingLearning {
  id: string;
  category: Category;
  fact: string;
  source: string;
  client: string;
  proposedAt: string; // ISO
  /** Entry id (see entryId) this fact supersedes; on approval the old entry is removed. */
  replaces?: string;
  /** Snapshot of the superseded entry's text at propose time, for the review UI. */
  replacesText?: string;
}

export interface AuditEntry {
  at: string; // ISO
  client: string;
  action: "read" | "propose" | "generate" | "write";
  detail: string;
}

const vaultKey = (userId: string) => `vault:${userId}`;
const pendingKey = (userId: string) => `pending:${userId}`;
const auditKey = (userId: string) => `audit:${userId}`;

/** Template vault for new users. */
export function seedVault(name = "", email = ""): Vault {
  const empty = () => ({ base: [] as string[], learned: [] as LearnedFact[] });
  return {
    identity: {
      base: [
        ...(name ? [`Name: ${name}`] : []),
        ...(email ? [`Email: ${email}`] : []),
        "One-line bio: (edit me at /vault)",
      ],
      learned: [],
    },
    work: empty(),
    projects: empty(),
    preferences: empty(),
    relationships: empty(),
    "communication-style": empty(),
  };
}

export async function loadVault(
  kv: KVNamespace,
  userId: string,
  seed?: { name?: string; email?: string },
): Promise<Vault> {
  const raw = await kv.get(vaultKey(userId));
  if (raw) return JSON.parse(raw) as Vault;
  const vault = seedVault(seed?.name, seed?.email);
  await kv.put(vaultKey(userId), JSON.stringify(vault));
  return vault;
}

export async function saveVault(kv: KVNamespace, userId: string, vault: Vault): Promise<void> {
  await kv.put(vaultKey(userId), JSON.stringify(vault));
}

/**
 * Stable short id for a vault entry, derived from its content (FNV-1a 32-bit).
 * Content-addressed on purpose: no stored ids, no migration, and a stale
 * reference (entry edited or deleted since it was read) simply stops resolving.
 */
export function entryId(cat: Category, list: "base" | "learned", text: string): string {
  const s = `${cat}/${list}/${text}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(0, 7);
}

export interface EntryRef {
  category: Category;
  list: "base" | "learned";
  index: number;
  text: string;
}

/** Resolve an entry id against the current vault, or null if it no longer matches. */
export function findEntry(vault: Vault, id: string): EntryRef | null {
  for (const cat of CATEGORIES) {
    const s = vault[cat];
    for (let i = 0; i < s.base.length; i++) {
      if (entryId(cat, "base", s.base[i]) === id)
        return { category: cat, list: "base", index: i, text: s.base[i] };
    }
    for (let i = 0; i < s.learned.length; i++) {
      if (entryId(cat, "learned", s.learned[i].fact) === id)
        return { category: cat, list: "learned", index: i, text: s.learned[i].fact };
    }
  }
  return null;
}

/** Render granted categories as markdown. With ids, each entry ends in [#id] so apps can supersede it. */
export function renderContext(
  vault: Vault,
  categories: Category[],
  opts: { ids?: boolean } = {},
): string {
  const tag = (cat: Category, list: "base" | "learned", text: string) =>
    opts.ids ? ` [#${entryId(cat, list, text)}]` : "";
  const parts: string[] = [];
  for (const cat of CATEGORIES) {
    if (!categories.includes(cat)) continue;
    const section = vault[cat];
    parts.push(`# ${cat}`);
    parts.push(section.base.map((f) => `- ${f}${tag(cat, "base", f)}`).join("\n") || "- (empty)");
    if (section.learned.length > 0) {
      parts.push("## Learned");
      parts.push(
        section.learned
          .map((l) => `- ${l.fact} _(via ${l.source}, ${l.date})_${tag(cat, "learned", l.fact)}`)
          .join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}

/**
 * Compact per-section freshness, injected into get_context so a reading
 * model can spot GAPS — sections that are thin or haven't gained a fact in
 * a long time — not just react to facts as they fly past. The vault can't
 * know what it's missing; the assistant in the conversation can.
 */
export function freshnessSummary(vault: Vault, categories: Category[]): string {
  return CATEGORIES.filter((c) => categories.includes(c))
    .map((cat) => {
      const s = vault[cat];
      const count = s.base.length + s.learned.length;
      const newest = s.learned.reduce<string>((max, l) => (l.date > max ? l.date : max), "");
      return `${cat} ${count}${newest ? ` (newest ${newest})` : " (nothing added by apps yet)"}`;
    })
    .join("; ");
}

export async function listPending(kv: KVNamespace, userId: string): Promise<PendingLearning[]> {
  const raw = await kv.get(pendingKey(userId));
  return raw ? (JSON.parse(raw) as PendingLearning[]) : [];
}

export async function addPending(
  kv: KVNamespace,
  userId: string,
  item: Omit<PendingLearning, "id" | "proposedAt">,
): Promise<PendingLearning> {
  const pending = await listPending(kv, userId);
  const entry: PendingLearning = {
    ...item,
    id: crypto.randomUUID().slice(0, 8),
    proposedAt: new Date().toISOString(),
  };
  pending.push(entry);
  await kv.put(pendingKey(userId), JSON.stringify(pending));
  return entry;
}

export async function decidePending(
  kv: KVNamespace,
  userId: string,
  id: string,
  action: "approve" | "reject",
): Promise<PendingLearning | null> {
  const pending = await listPending(kv, userId);
  const idx = pending.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const [item] = pending.splice(idx, 1);
  if (action === "approve") {
    const vault = await loadVault(kv, userId);
    // Supersession: remove the entry this fact replaces, if it still exists
    // unchanged. If it was edited/deleted meanwhile, degrade to a plain add.
    if (item.replaces) {
      const old = findEntry(vault, item.replaces);
      if (old) {
        if (old.list === "base") vault[old.category].base.splice(old.index, 1);
        else vault[old.category].learned.splice(old.index, 1);
      }
    }
    vault[item.category].learned.push({
      fact: item.fact,
      source: item.client,
      date: item.proposedAt.slice(0, 10),
    });
    await saveVault(kv, userId, vault);
  }
  await kv.put(pendingKey(userId), JSON.stringify(pending));
  return item;
}

const AUDIT_CAP = 200;

export async function appendAudit(
  kv: KVNamespace,
  userId: string,
  entry: Omit<AuditEntry, "at">,
): Promise<void> {
  const raw = await kv.get(auditKey(userId));
  const log: AuditEntry[] = raw ? JSON.parse(raw) : [];
  log.unshift({ ...entry, at: new Date().toISOString() });
  await kv.put(auditKey(userId), JSON.stringify(log.slice(0, AUDIT_CAP)));
}

export async function readAudit(kv: KVNamespace, userId: string): Promise<AuditEntry[]> {
  const raw = await kv.get(auditKey(userId));
  return raw ? (JSON.parse(raw) as AuditEntry[]) : [];
}
