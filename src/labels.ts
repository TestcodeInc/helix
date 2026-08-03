/**
 * Labels and the private flag — the narrowing layer.
 *
 * Categories are a coarse grant: "work" hands over everything about work at
 * once. Labels let an owner hand an app one slice of a category and nothing
 * else, and the private flag marks entries that never leave the vault at all.
 *
 * Two rules make this safe to reason about:
 *
 *   1. **Labels only ever narrow.** A label-restricted grant sees the
 *      intersection of its categories and its labels — never a `relationships`
 *      entry that happens to be tagged `helix`. Otherwise a label becomes a
 *      privilege-escalation path through the consent screen.
 *   2. **Private beats everything.** No scope, label or grant reveals a
 *      private entry through an app door. Owner doors only.
 *
 * Stored as a sidecar keyed by content-hash entry id rather than as a field on
 * the entries themselves: no migration for existing vaults, and it matches the
 * content-addressed design. The cost is that editing an entry changes its id,
 * so the vault editor re-keys on save (see relabelEntry).
 */
import { CATEGORIES, type Category, type Vault, entryId } from "./vault";

export interface LabelDoc {
  /** entryId → labels. Absent id means "no labels". */
  labels: Record<string, string[]>;
  /** Entry ids that never leave the vault through an app door. */
  private: string[];
}

const labelKey = (userId: string) => `labels:${userId}`;

/** Labels are lowercase, dash-separated, and short enough to fit a checkbox. */
export function normalizeLabel(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s && s.length <= 32 ? s : null;
}

export const MAX_LABELS_PER_ENTRY = 6;

export async function loadLabels(kv: KVNamespace, userId: string): Promise<LabelDoc> {
  const raw = await kv.get(labelKey(userId));
  if (!raw) return { labels: {}, private: [] };
  const doc = JSON.parse(raw) as Partial<LabelDoc>;
  return { labels: doc.labels ?? {}, private: doc.private ?? [] };
}

export async function saveLabels(kv: KVNamespace, userId: string, doc: LabelDoc): Promise<void> {
  await kv.put(labelKey(userId), JSON.stringify(doc));
}

/** Set (or clear) the labels on one entry. Returns what was actually stored. */
export async function setLabels(
  kv: KVNamespace,
  userId: string,
  id: string,
  labels: string[],
): Promise<string[]> {
  const doc = await loadLabels(kv, userId);
  const clean = [...new Set(labels.map(normalizeLabel).filter((l): l is string => !!l))].slice(
    0,
    MAX_LABELS_PER_ENTRY,
  );
  if (clean.length) doc.labels[id] = clean;
  else delete doc.labels[id];
  await saveLabels(kv, userId, doc);
  return clean;
}

export async function setPrivate(
  kv: KVNamespace,
  userId: string,
  id: string,
  isPrivate: boolean,
): Promise<void> {
  const doc = await loadLabels(kv, userId);
  const set = new Set(doc.private);
  if (isPrivate) set.add(id);
  else set.delete(id);
  doc.private = [...set];
  await saveLabels(kv, userId, doc);
}

/**
 * Move an entry's labels and private flag to its new id after an edit.
 * Content-hash ids change with the text, so without this a single typo fix
 * would silently un-label (and un-private) an entry — the failure mode being
 * that something the owner marked private quietly becomes visible.
 */
export async function relabelEntry(
  kv: KVNamespace,
  userId: string,
  oldId: string,
  newId: string,
): Promise<void> {
  if (oldId === newId) return;
  const doc = await loadLabels(kv, userId);
  let touched = false;
  if (doc.labels[oldId]) {
    doc.labels[newId] = doc.labels[oldId];
    delete doc.labels[oldId];
    touched = true;
  }
  if (doc.private.includes(oldId)) {
    doc.private = [...new Set([...doc.private.filter((i) => i !== oldId), newId])];
    touched = true;
  }
  if (touched) await saveLabels(kv, userId, doc);
}

/** Drop label/private records whose entries no longer exist. */
export async function pruneLabels(kv: KVNamespace, userId: string, vault: Vault): Promise<void> {
  const live = new Set(allEntryIds(vault));
  const doc = await loadLabels(kv, userId);
  const before = Object.keys(doc.labels).length + doc.private.length;
  for (const id of Object.keys(doc.labels)) if (!live.has(id)) delete doc.labels[id];
  doc.private = doc.private.filter((id) => live.has(id));
  if (before !== Object.keys(doc.labels).length + doc.private.length)
    await saveLabels(kv, userId, doc);
}

export function allEntryIds(vault: Vault): string[] {
  const ids: string[] = [];
  for (const cat of CATEGORIES) {
    for (const text of vault[cat].base) ids.push(entryId(cat, "base", text));
    for (const l of vault[cat].learned) ids.push(entryId(cat, "learned", l.fact));
  }
  return ids;
}

/** Labels in use, with counts — the index an app is shown so it can ask for one. */
export function labelIndex(
  vault: Vault,
  doc: LabelDoc,
  categories: Category[],
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  const priv = new Set(doc.private);
  for (const cat of CATEGORIES) {
    if (!categories.includes(cat)) continue;
    const ids = [
      ...vault[cat].base.map((t) => entryId(cat, "base", t)),
      ...vault[cat].learned.map((l) => entryId(cat, "learned", l.fact)),
    ];
    for (const id of ids) {
      if (priv.has(id)) continue;
      for (const label of doc.labels[id] ?? []) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface Visibility {
  /** Labels this grant is limited to. Empty/undefined = the whole category. */
  grantLabels?: string[];
  /** Labels this particular call asked for. */
  askedLabels?: string[];
}

/**
 * The single place that decides whether an app may see an entry. Everything
 * that reads on an app's behalf goes through this, so the narrowing rules
 * can't drift between the MCP door and the REST door.
 */
export function visibleTo(doc: LabelDoc, id: string, v: Visibility): boolean {
  if (doc.private.includes(id)) return false; // rule 2: private beats everything
  const own = doc.labels[id] ?? [];
  if (v.grantLabels?.length && !own.some((l) => v.grantLabels!.includes(l))) return false;
  if (v.askedLabels?.length && !own.some((l) => v.askedLabels!.includes(l))) return false;
  return true;
}

/**
 * A copy of the vault with everything this grant may not see removed.
 * Filtering the data — rather than filtering the rendered markdown — means a
 * hidden entry can't leak through a count, a freshness summary or an id.
 */
export function filterVault(vault: Vault, doc: LabelDoc, v: Visibility): Vault {
  const out = {} as Vault;
  for (const cat of CATEGORIES) {
    out[cat] = {
      base: vault[cat].base.filter((t) => visibleTo(doc, entryId(cat, "base", t), v)),
      learned: vault[cat].learned.filter((l) => visibleTo(doc, entryId(cat, "learned", l.fact), v)),
    };
  }
  return out;
}

/** How many entries the owner is holding back, for the owner's own screens. */
export function hiddenCount(vault: Vault, doc: LabelDoc): number {
  const live = new Set(allEntryIds(vault));
  return doc.private.filter((id) => live.has(id)).length;
}
