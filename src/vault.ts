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
  /**
   * "fact" (the default, and what every existing queued item is) proposes new
   * text. "labels" proposes tagging an entry that already exists — same queue,
   * same approve/reject, because labels decide what apps can see and that is
   * the owner's call, not an app's.
   */
  kind?: "fact" | "labels";
  /** Labels to attach: suggested alongside a new fact, or the whole point of a "labels" item. */
  labels?: string[];
  /** For kind "labels": the entry being tagged. */
  targetId?: string;
  /** Snapshot of that entry's text, so the review screen can show it. */
  targetText?: string;
}

export interface AuditEntry {
  at: string; // ISO
  client: string;
  action: "read" | "propose" | "generate" | "write";
  detail: string;
  /** Monotonic per user. Gaps make a removed entry visible. */
  seq?: number;
  /** SHA-256 over this entry's content plus `prev`; the link in the chain. */
  hash?: string;
  /** Hash of the entry before this one. "" for the first ever. */
  prev?: string;
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

/**
 * Fill in any category a stored vault doesn't have yet, and repair a
 * malformed section.
 *
 * Categories are added to CATEGORIES over time, but a vault written before
 * that has no key for the new one — and `vault[newCategory].base` on an
 * undefined section throws on the very next read. Normalising here means
 * adding a category is a one-line change to CATEGORIES rather than a
 * migration across every stored vault.
 *
 * Deliberately non-destructive: unknown categories in stored JSON are left
 * alone, so a vault written by a NEWER version (or exported from someone
 * else's fork) survives a round trip through this one intact.
 */
export function normalizeVault(raw: unknown): Vault {
  const stored = (raw ?? {}) as Record<string, unknown>;
  const out = { ...stored } as Vault;
  for (const cat of CATEGORIES) {
    const section = stored[cat] as { base?: unknown; learned?: unknown } | undefined;
    out[cat] = {
      base: Array.isArray(section?.base) ? (section!.base as string[]) : [],
      learned: Array.isArray(section?.learned) ? (section!.learned as LearnedFact[]) : [],
    };
  }
  return out;
}

export async function loadVault(
  kv: KVNamespace,
  userId: string,
  seed?: { name?: string; email?: string },
): Promise<Vault> {
  const raw = await kv.get(vaultKey(userId));
  if (raw) return normalizeVault(JSON.parse(raw));
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

  // A labels proposal touches no text — it only decides who can see an entry
  // that already exists.
  if (item.kind === "labels") {
    if (action === "approve" && item.targetId) {
      const { setLabels, loadLabels } = await import("./labels");
      const existing = (await loadLabels(kv, userId)).labels[item.targetId] ?? [];
      await setLabels(kv, userId, item.targetId, [...existing, ...(item.labels ?? [])]);
    }
    await kv.put(pendingKey(userId), JSON.stringify(pending));
    return item;
  }

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
    // Idempotent: a double-submitted approval must not add the fact twice.
    // KV is eventually consistent, so two clicks a moment apart can both read
    // a pending list that still contains this item — the guard belongs here,
    // where the write happens, not only in the browser.
    const already = vault[item.category].learned.some((l) => l.fact === item.fact);
    if (!already) {
      vault[item.category].learned.push({
        fact: item.fact,
        source: item.client,
        date: item.proposedAt.slice(0, 10),
      });
      await saveVault(kv, userId, vault);
    }
    const newId = entryId(item.category, "learned", item.fact);
    // A superseding fact inherits the old entry's labels and private flag.
    // Without this, an approved update would quietly un-hide something the
    // owner had marked private.
    if (item.replaces) {
      const { relabelEntry } = await import("./labels");
      await relabelEntry(kv, userId, item.replaces, newId);
    }
    if (item.labels?.length) {
      const { setLabels, loadLabels } = await import("./labels");
      const inherited = (await loadLabels(kv, userId)).labels[newId] ?? [];
      await setLabels(kv, userId, newId, [...inherited, ...item.labels]);
    }
  }
  await kv.put(pendingKey(userId), JSON.stringify(pending));
  return item;
}

const AUDIT_CAP = 200;
const auditMetaKey = (userId: string) => `auditmeta:${userId}`;

/**
 * The link in the chain. Deliberately a plain string join of the fields that
 * matter, in a fixed order: a reader implementing this independently — which
 * is the point of publishing a spec — shouldn't have to match a JSON
 * serialiser's quirks to reproduce a hash.
 */
export async function auditHash(e: {
  at: string;
  client: string;
  action: string;
  detail: string;
  seq: number;
  prev: string;
}): Promise<string> {
  const canonical = [e.seq, e.at, e.client, e.action, e.detail, e.prev].join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Append to the tamper-evident log.
 *
 * Each entry carries the hash of the one before it, so altering or reordering
 * any retained entry breaks every link after it. The sequence number is kept
 * in its own key rather than derived from the array, because the array is
 * capped — without it, an entry removed from a full log would be invisible.
 *
 * What this does and doesn't prove is stated plainly on the audit page: the
 * chain shows that what's here hasn't been edited, not that nothing was ever
 * deleted wholesale by whoever runs the server. Honest beats impressive.
 */
export async function appendAudit(
  kv: KVNamespace,
  userId: string,
  entry: Omit<AuditEntry, "at" | "seq" | "hash" | "prev">,
): Promise<void> {
  const [raw, metaRaw] = await Promise.all([kv.get(auditKey(userId)), kv.get(auditMetaKey(userId))]);
  const log: AuditEntry[] = raw ? JSON.parse(raw) : [];
  const meta = metaRaw ? (JSON.parse(metaRaw) as { seq: number; hash: string }) : { seq: 0, hash: "" };

  const next = {
    ...entry,
    at: new Date().toISOString(),
    seq: meta.seq + 1,
    prev: meta.hash,
  };
  const hash = await auditHash(next);
  log.unshift({ ...next, hash });

  await Promise.all([
    kv.put(auditKey(userId), JSON.stringify(log.slice(0, AUDIT_CAP))),
    kv.put(auditMetaKey(userId), JSON.stringify({ seq: next.seq, hash })),
  ]);
}

export interface ChainCheck {
  ok: boolean;
  /** Entries covered by the chain (older ones predate it). */
  checked: number;
  /** Sequence number of the first entry that doesn't verify. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verify a log, newest-first as stored. Entries written before this feature
 * carry no hash; they're reported as unchecked rather than treated as broken,
 * because an unproven entry and a forged one are different claims.
 */
export async function verifyAuditChain(log: AuditEntry[]): Promise<ChainCheck> {
  const chained = log.filter((e) => e.hash && typeof e.seq === "number");
  if (chained.length === 0) return { ok: true, checked: 0 };

  const ordered = [...chained].sort((a, b) => a.seq! - b.seq!);
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const expected = await auditHash({
      at: e.at,
      client: e.client,
      action: e.action,
      detail: e.detail,
      seq: e.seq!,
      prev: e.prev ?? "",
    });
    if (expected !== e.hash)
      return { ok: false, checked: ordered.length, brokenAt: e.seq, reason: "entry was altered" };
    if (i > 0) {
      const before = ordered[i - 1];
      if (e.prev !== before.hash)
        return {
          ok: false,
          checked: ordered.length,
          brokenAt: e.seq,
          reason: e.seq! - before.seq! > 1 ? "an entry is missing" : "entries were reordered",
        };
    }
  }
  return { ok: true, checked: ordered.length };
}

export async function readAudit(kv: KVNamespace, userId: string): Promise<AuditEntry[]> {
  const raw = await kv.get(auditKey(userId));
  return raw ? (JSON.parse(raw) as AuditEntry[]) : [];
}
