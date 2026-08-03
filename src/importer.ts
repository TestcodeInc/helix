/**
 * Import a `helix-export/v1` document into a vault.
 *
 * Export without import is half a portability claim, so this is the mirror
 * of buildExport(). Three rules shape it:
 *
 *  1. **Merge, never replace.** Importing into an empty vault reproduces the
 *     original; importing into a populated one adds what's missing. Nothing
 *     the owner already has is destroyed by a file they picked.
 *  2. **Idempotent.** Entries dedupe on content, so importing the same file
 *     twice is a no-op. Recovery shouldn't require knowing whether you
 *     already tried.
 *  3. **Some things cannot travel.** An audit log describes what happened on
 *     the server that wrote it; accepting a foreign one would let a document
 *     dictate history, and the log is exactly what users are asked to trust.
 *     Voice verification is a live ceremony against a server-minted phrase,
 *     so it is re-earned, not copied. OAuth grants belong to the issuing
 *     server. Each refusal is reported rather than silently dropped.
 */
import { CATEGORIES, type Category, type Vault, type LearnedFact, loadVault, saveVault } from "./vault";
import {
  MAX_PHOTOS_PER_SUBJECT,
  type Subject,
  type SubjectPhoto,
  createSubject,
  getSubject,
  listSubjects,
  addPhotosToSubject,
} from "./subjects";
import { loadVoice, saveVoice, type VoiceTake } from "./voice";
import {
  loadLabels,
  saveLabels,
  allEntryIds,
  normalizeLabel,
  MAX_LABELS_PER_ENTRY,
} from "./labels";

/** Refuse oversized uploads before parsing. Photo-heavy vaults are large;
 * this is generous enough for a real one and small enough to bound memory. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export interface ImportResult {
  facts: number;
  subjects: number;
  photos: number;
  takes: number;
  /** Labels and private flags applied to entries that exist here. */
  marks: number;
  /** Plain-language notes about anything deliberately not imported. */
  notes: string[];
}

interface ExportDoc {
  format?: unknown;
  vault?: unknown;
  subjects?: unknown;
  voice?: unknown;
  marks?: unknown;
  audit?: unknown;
  connected_apps?: unknown;
  pending?: unknown;
}

/** Validate the envelope. Returns an error string, or null when usable. */
export function checkExport(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return "That file isn't a Helix export — the contents aren't a JSON object.";
  const d = doc as ExportDoc;
  if (d.format !== "helix-export/v1")
    return `Unsupported export format ${JSON.stringify(d.format ?? "(missing)")}. This vault reads "helix-export/v1".`;
  if (!d.vault || typeof d.vault !== "object")
    return "That export has no vault section — it may be truncated.";
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function importExport(
  kv: KVNamespace,
  userId: string,
  doc: unknown,
): Promise<ImportResult> {
  const d = doc as ExportDoc;
  const result: ImportResult = { facts: 0, subjects: 0, photos: 0, takes: 0, marks: 0, notes: [] };

  // ---- facts -------------------------------------------------------------
  const incoming = d.vault as Partial<Record<Category, { base?: unknown; learned?: unknown }>>;
  const vault: Vault = await loadVault(kv, userId);
  for (const cat of CATEGORIES) {
    const section = incoming[cat];
    if (!section) continue;

    if (Array.isArray(section.base)) {
      const have = new Set(vault[cat].base);
      for (const raw of section.base) {
        const text = str(raw);
        if (!text || have.has(text)) continue;
        vault[cat].base.push(text);
        have.add(text);
        result.facts++;
      }
    }

    if (Array.isArray(section.learned)) {
      const have = new Set(vault[cat].learned.map((l) => l.fact));
      for (const raw of section.learned as LearnedFact[]) {
        const fact = str(raw?.fact);
        if (!fact || have.has(fact)) continue;
        vault[cat].learned.push({
          fact,
          source: str(raw?.source) ?? "import",
          date: str(raw?.date) ?? new Date().toISOString().slice(0, 10),
        });
        have.add(fact);
        result.facts++;
      }
    }
  }
  await saveVault(kv, userId, vault);

  // ---- subjects ----------------------------------------------------------
  // Photo ids are per-install, so photos dedupe on their bytes. Subjects
  // match on name+species: the same dog imported twice is one dog, even
  // though a fresh vault would have minted it a different id.
  if (Array.isArray(d.subjects)) {
    const index = await listSubjects(kv, userId);
    const byName = new Map(index.map((r) => [`${r.name.toLowerCase()}/${r.species.toLowerCase()}`, r.id]));

    for (const raw of d.subjects as Subject[]) {
      const name = str(raw?.name);
      if (!name) continue;
      const species = str(raw?.species) ?? "person";
      const photos: SubjectPhoto[] = Array.isArray(raw?.photos)
        ? raw.photos.filter((p) => p && typeof p.b64 === "string" && typeof p.mime === "string")
        : [];

      const existingId = byName.get(`${name.toLowerCase()}/${species.toLowerCase()}`);
      if (existingId) {
        const existing = await getSubject(kv, userId, existingId);
        if (!existing) continue;
        const have = new Set(existing.photos.map((p) => p.b64));
        const fresh = photos.filter((p) => !have.has(p.b64));
        if (fresh.length) {
          await addPhotosToSubject(kv, userId, existingId, fresh);
          result.photos += Math.min(fresh.length, MAX_PHOTOS_PER_SUBJECT - existing.photos.length);
        }
        continue;
      }

      const created = await createSubject(kv, userId, {
        name,
        species,
        thumb: str(raw?.thumb) ?? photos[0]?.thumb ?? "",
        photos: photos.slice(0, MAX_PHOTOS_PER_SUBJECT),
      });
      byName.set(`${name.toLowerCase()}/${species.toLowerCase()}`, created.id);
      result.subjects++;
      result.photos += created.photos.length;
    }
  }

  // ---- labels and the private flag ---------------------------------------
  // Applied after the facts, and only to entries that actually exist here.
  // Private is a union: an import can hide more, never less. Nothing an
  // owner marked private in one vault becomes visible by moving vaults.
  const marks = d.marks as { labels?: Record<string, unknown>; private?: unknown } | undefined;
  if (marks) {
    const merged = await loadVault(kv, userId);
    const live = new Set(allEntryIds(merged));
    const doc = await loadLabels(kv, userId);
    let changed = 0;
    for (const [id, raw] of Object.entries(marks.labels ?? {})) {
      if (!live.has(id) || !Array.isArray(raw)) continue;
      const incoming = raw
        .map((l) => (typeof l === "string" ? normalizeLabel(l) : null))
        .filter((l): l is string => !!l);
      if (!incoming.length) continue;
      const before = doc.labels[id] ?? [];
      const union = [...new Set([...before, ...incoming])].slice(0, MAX_LABELS_PER_ENTRY);
      if (union.length !== before.length) changed++;
      doc.labels[id] = union;
    }
    if (Array.isArray(marks.private)) {
      const add = marks.private.filter((id): id is string => typeof id === "string" && live.has(id));
      const before = doc.private.length;
      doc.private = [...new Set([...doc.private, ...add])];
      changed += doc.private.length - before;
    }
    if (changed) await saveLabels(kv, userId, doc);
    result.marks = changed;
  }

  // ---- voice -------------------------------------------------------------
  const voiceDoc = d.voice as { takes?: unknown; verified_at?: unknown } | undefined;
  if (voiceDoc && Array.isArray(voiceDoc.takes)) {
    const profile = await loadVoice(kv, userId);
    const have = new Set(profile.takes.map((t) => t.b64));
    let added = 0;
    for (const raw of voiceDoc.takes as VoiceTake[]) {
      if (!raw || typeof raw.b64 !== "string" || have.has(raw.b64)) continue;
      profile.takes.push({
        id: crypto.randomUUID().slice(0, 8),
        style: str(raw.style) ?? "neutral",
        mime: str(raw.mime) ?? "audio/mp4",
        b64: raw.b64,
        isPhrase: false, // see below: verification doesn't travel
        recordedAt: str(raw.recordedAt) ?? new Date().toISOString(),
      });
      have.add(raw.b64);
      added++;
    }
    if (added) {
      profile.takes = profile.takes.slice(-12);
      profile.providerVoiceId = undefined; // samples changed; recompile on demand
      await saveVoice(kv, userId, profile);
      result.takes = added;
    }
    if (voiceDoc.verified_at) {
      result.notes.push(
        "Voice takes were imported, but the voice is not marked verified — verification means reading a phrase this vault minted, so record one session here to re-earn it.",
      );
    }
  }

  // ---- what deliberately didn't come across ------------------------------
  if (Array.isArray(d.audit) && d.audit.length)
    result.notes.push(
      `The export's ${d.audit.length} audit entries were not imported. An audit log is this server's record of what it did; adopting another one would make it a story instead of a record. Your original export keeps them.`,
    );
  if (Array.isArray(d.connected_apps) && d.connected_apps.length)
    result.notes.push(
      `${d.connected_apps.length} connected app${d.connected_apps.length === 1 ? "" : "s"} were listed but can't be imported — app access is granted per vault. Reconnect them and approve the scopes here.`,
    );
  if (Array.isArray(d.pending) && d.pending.length)
    result.notes.push(
      `${d.pending.length} proposal${d.pending.length === 1 ? "" : "s"} awaiting review were skipped. Proposals belong to the queue they were made in; approve them there before exporting if you want them.`,
    );

  return result;
}

/** One-line summary for the audit log and the API response. */
export function importSummary(r: ImportResult): string {
  const parts = [
    `${r.facts} fact${r.facts === 1 ? "" : "s"}`,
    `${r.subjects} subject${r.subjects === 1 ? "" : "s"}`,
    `${r.photos} photo${r.photos === 1 ? "" : "s"}`,
    `${r.takes} voice take${r.takes === 1 ? "" : "s"}`,
    `${r.marks} label/privacy mark${r.marks === 1 ? "" : "s"}`,
  ];
  return `imported ${parts.join(", ")}`;
}
