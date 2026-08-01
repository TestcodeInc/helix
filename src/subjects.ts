/**
 * Likeness subjects — people and pets whose photos live in the vault.
 * Spike-grade storage: photos are base64 in KV (R2 comes with v0.5).
 *   subjectindex:<userId>        → SubjectRef[]  (lightweight, for lists)
 *   subject:<userId>:<subjectId> → Subject       (full, includes photos)
 *
 * Trust model: apps get refs + tiny thumbnails only. Full photos are read
 * server-side at generation time and sent to the declared image provider —
 * never returned to the app.
 */

export interface SubjectPhoto {
  id: string;
  mime: string;
  b64: string;
  /** Tiny per-photo thumbnail (data URI), made client-side at upload.
   * The subject's avatar is always the FIRST photo's thumb, so curation
   * (delete / make-primary) keeps the cast face current automatically. */
  thumb?: string;
}

export interface Subject {
  id: string;
  name: string;
  species: string; // "dog" | "cat" | "person" | free text
  /** Small data-URI thumbnail (client-side downscaled at upload). Safe to share with apps. */
  thumb: string;
  photos: SubjectPhoto[];
  createdAt: string;
}

export interface SubjectRef {
  id: string;
  name: string;
  species: string;
  photoCount: number;
}

/** Parse an image data URI into a stored photo, or null if malformed. */
export function parseDataUri(uri: string): SubjectPhoto | null {
  const m = uri.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/);
  return m ? { id: crypto.randomUUID().slice(0, 6), mime: m[1], b64: m[2] } : null;
}

/** Zip photo data URIs with optional parallel thumbs (JSON bodies). */
export function zipPhotos(uris: string[] = [], thumbs: string[] = []): SubjectPhoto[] {
  return uris
    .map((u, i) => {
      const photo = parseDataUri(u);
      if (photo && thumbs[i]?.startsWith("data:image/")) photo.thumb = thumbs[i];
      return photo;
    })
    .filter((x): x is SubjectPhoto => x !== null);
}

const indexKey = (userId: string) => `subjectindex:${userId}`;
const subjectKey = (userId: string, id: string) => `subject:${userId}:${id}`;

export async function listSubjects(kv: KVNamespace, userId: string): Promise<SubjectRef[]> {
  const raw = await kv.get(indexKey(userId));
  return raw ? (JSON.parse(raw) as SubjectRef[]) : [];
}

export async function getSubject(
  kv: KVNamespace,
  userId: string,
  id: string,
): Promise<Subject | null> {
  const raw = await kv.get(subjectKey(userId, id));
  return raw ? (JSON.parse(raw) as Subject) : null;
}

export async function createSubject(
  kv: KVNamespace,
  userId: string,
  data: { name: string; species: string; thumb: string; photos: SubjectPhoto[] },
): Promise<Subject> {
  const subject: Subject = {
    id: crypto.randomUUID().slice(0, 8),
    ...data,
    createdAt: new Date().toISOString(),
  };
  const index = await listSubjects(kv, userId);
  index.push({
    id: subject.id,
    name: subject.name,
    species: subject.species,
    photoCount: subject.photos.length,
  });
  await Promise.all([
    kv.put(subjectKey(userId, subject.id), JSON.stringify(subject)),
    kv.put(indexKey(userId), JSON.stringify(index)),
  ]);
  return subject;
}

export async function deleteSubject(kv: KVNamespace, userId: string, id: string): Promise<void> {
  const index = (await listSubjects(kv, userId)).filter((s) => s.id !== id);
  await Promise.all([
    kv.delete(subjectKey(userId, id)),
    kv.put(indexKey(userId), JSON.stringify(index)),
  ]);
}

/** Persist a mutated subject: avatar follows first photo, index count synced. */
async function saveSubject(kv: KVNamespace, userId: string, subject: Subject): Promise<Subject> {
  if (subject.photos[0]?.thumb) subject.thumb = subject.photos[0].thumb;
  const index = await listSubjects(kv, userId);
  const entry = index.find((r) => r.id === subject.id);
  if (entry) entry.photoCount = subject.photos.length;
  await Promise.all([
    kv.put(subjectKey(userId, subject.id), JSON.stringify(subject)),
    kv.put(indexKey(userId), JSON.stringify(index)),
  ]);
  return subject;
}

export const MAX_PHOTOS_PER_SUBJECT = 10;

export async function addPhotosToSubject(
  kv: KVNamespace,
  userId: string,
  id: string,
  photos: SubjectPhoto[],
): Promise<Subject | null> {
  const s = await getSubject(kv, userId, id);
  if (!s) return null;
  s.photos = [...s.photos, ...photos].slice(0, MAX_PHOTOS_PER_SUBJECT);
  return saveSubject(kv, userId, s);
}

export async function deletePhotoFromSubject(
  kv: KVNamespace,
  userId: string,
  id: string,
  photoId: string,
): Promise<Subject | null> {
  const s = await getSubject(kv, userId, id);
  if (!s) return null;
  s.photos = s.photos.filter((p) => p.id !== photoId);
  return saveSubject(kv, userId, s);
}

/** Backfill a thumbnail for a pre-thumbnail-era photo (web session only —
 * the browser is the only place with both the full photo and a canvas). */
export async function setPhotoThumb(
  kv: KVNamespace,
  userId: string,
  id: string,
  photoId: string,
  thumb: string,
): Promise<Subject | null> {
  const s = await getSubject(kv, userId, id);
  if (!s) return null;
  const photo = s.photos.find((p) => p.id === photoId);
  if (!photo) return null;
  photo.thumb = thumb;
  return saveSubject(kv, userId, s);
}

/** Move a photo to the front — the first photos are the generation
 * references and the first thumb is the subject's avatar, so "primary"
 * is a meaningful curation act, not just cosmetics. */
export async function makePhotoPrimary(
  kv: KVNamespace,
  userId: string,
  id: string,
  photoId: string,
): Promise<Subject | null> {
  const s = await getSubject(kv, userId, id);
  if (!s) return null;
  const idx = s.photos.findIndex((p) => p.id === photoId);
  if (idx > 0) {
    const [photo] = s.photos.splice(idx, 1);
    s.photos.unshift(photo);
  }
  return saveSubject(kv, userId, s);
}

/** Thumbnail for an app-facing list: data URI, or empty string. */
export async function subjectThumb(
  kv: KVNamespace,
  userId: string,
  id: string,
): Promise<string> {
  const s = await getSubject(kv, userId, id);
  return s?.thumb ?? "";
}

/**
 * Stash a generated image behind an unguessable token for 1 hour, so chat
 * clients get a link instead of megabytes of base64 — and never hold the
 * artwork's bytes at all unless the user opens it.
 */
export async function stashGeneratedImage(
  kv: KVNamespace,
  b64: string,
  mime = "image/png",
): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  // 24h: long enough to keep iterating on a piece across a conversation
  // (or overnight), short enough that generated media doesn't accumulate.
  await kv.put(`genimg:${token}`, JSON.stringify({ mime, b64 }), { expirationTtl: 86400 });
  return token;
}

export async function readGeneratedImage(
  kv: KVNamespace,
  token: string,
): Promise<{ mime: string; b64: string } | null> {
  const raw = await kv.get(`genimg:${token}`);
  return raw ? (JSON.parse(raw) as { mime: string; b64: string }) : null;
}

/** Model + image-tool defaults. gpt-5.6-sol orchestrates the image tool —
 * matches the pipeline tuned in Dog Photobooth (better composition and
 * border adherence than calling the image model directly). */
const GEN_MODEL = "gpt-5.6-sol";
// 1536x1536 is the Photobooth-proven default — panels are cut from the square.
const GEN_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "1536x1536", "auto"]);

/**
 * Shared generation core: vault photos → image provider → generated image.
 * Used by both the REST door (/api/generate) and the MCP generate_image
 * tool. Source photos go ONLY to the provider; callers get pixels back.
 *
 * Uses the Responses API: reference photos ride as input_image content and
 * gpt-5.6-sol drives the built-in image_generation tool.
 */
export async function generateWithProvider(
  kv: KVNamespace,
  apiKey: string,
  userId: string,
  subjectIds: string[],
  prompt: string,
  opts: {
    refsPerSubject?: number;
    size?: string;
    quality?: string;
    /** A previous generation to edit rather than start from scratch. */
    baseImage?: { b64: string; mime: string };
  } = {},
): Promise<
  | { ok: true; b64: string; names: string[]; photoCount: number; model: string }
  | { ok: false; status: number; error: string }
> {
  const subjects = await Promise.all(subjectIds.map((id) => getSubject(kv, userId, id)));
  const missing = subjectIds.filter((_, i) => !subjects[i]);
  if (missing.length)
    return { ok: false, status: 404, error: `unknown subject ids: ${missing.join(", ")}` };

  const refsPer = Math.min(3, Math.max(1, opts.refsPerSubject ?? 2));
  const content: Record<string, unknown>[] = [
    {
      type: "input_text",
      text: opts.baseImage
        ? `Edit the first attached image according to this instruction, preserving its composition, style, and the identity of everyone in it. Instruction: ${prompt}`
        : prompt,
    },
  ];
  // The image being edited goes first so the model treats it as the canvas;
  // vault reference photos follow to hold identity steady across edits.
  if (opts.baseImage) {
    content.push({
      type: "input_image",
      image_url: `data:${opts.baseImage.mime};base64,${opts.baseImage.b64}`,
    });
  }
  let photoCount = 0;
  for (const s of subjects) {
    for (const photo of s!.photos.slice(0, refsPer)) {
      content.push({
        type: "input_image",
        image_url: `data:${photo.mime};base64,${photo.b64}`,
      });
      photoCount++;
    }
  }
  if (photoCount === 0 && !opts.baseImage)
    return { ok: false, status: 400, error: "selected subjects have no photos" };

  const size = opts.size && GEN_SIZES.has(opts.size) ? opts.size : "1536x1536";
  const quality = opts.quality === "medium" || opts.quality === "high" ? opts.quality : "low";

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GEN_MODEL,
      input: [{ role: "user", content }],
      tools: [{ type: "image_generation", size, quality }],
      tool_choice: { type: "image_generation" },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, status: 502, error: `provider error ${res.status}: ${detail}` };
  }
  const out = (await res.json()) as {
    output?: { type: string; result?: string }[];
  };
  const call = out.output?.find((o) => o.type === "image_generation_call");
  const b64 = call?.result;
  if (!b64) return { ok: false, status: 502, error: "provider returned no image" };
  return { ok: true, b64, names: subjects.map((s) => s!.name), photoCount, model: GEN_MODEL };
}
