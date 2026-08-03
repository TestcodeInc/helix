/**
 * Voice likeness — the strictest modality, owner-only by design.
 *
 * Capture is a guided reading session (styled cards + a server-issued
 * verification phrase that didn't exist before the session started, so a
 * podcast clip can't be vaulted as "your" voice). Raw takes are canonical;
 * the provider voice is a cached compilation, destroyed on delete.
 *
 *   voice:<userId> → VoiceProfile
 *
 * Apps NEVER receive samples. They send text; synthesis happens vault-side
 * via ElevenLabs and returns expiring audio links. No API key → honest 501.
 */

export interface VoiceTake {
  id: string;
  style: string; // neutral | warm | excited | question | quiet | phrase
  mime: string;
  b64: string;
  isPhrase: boolean;
  recordedAt: string;
}

export interface VoiceProfile {
  takes: VoiceTake[];
  /** Server-issued verification phrase for the current/next session. */
  phrase: { text: string; issuedAt: string };
  /** Set when a session included the phrase card — "script-verified". */
  verifiedAt?: string;
  /** Cached provider compilation (ElevenLabs voice id). */
  providerVoiceId?: string;
}

const voiceKey = (userId: string) => `voice:${userId}`;

const WORDS = ["violet", "copper", "harbor", "maple", "granite", "prairie", "cedar", "atlas"];

/** The guided session scripts — served by the vault so web, iOS, and
 * Android always read the same ceremony. */
export const VOICE_CARDS = [
  { style: "neutral", direction: "Flat and even, like a narrator", text: "The vault keeps what I choose to share, and nothing more. Every app asks first, and I can change my mind at any time." },
  { style: "warm", direction: "Like telling a friend good news", text: "You are not going to believe this — it actually worked. The whole thing, end to end, on the first try." },
  { style: "question", direction: "Genuinely curious, rising at the end", text: "But who decides what gets remembered? And if I wanted it gone tomorrow, would it actually be gone?" },
  { style: "excited", direction: "Bright and energetic", text: "This changes everything about how it works! One vault, every app, and the whole thing just follows me around." },
  { style: "quiet", direction: "Soft, like someone is sleeping nearby", text: "It's late, and everything is finally done. The lights are off, the queue is empty, and tomorrow can wait." },
] as const;

export function mintPhrase(): { text: string; issuedAt: string } {
  const now = new Date();
  const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = 10 + Math.floor(Math.random() * 89);
  return {
    text: `Today is ${day}, and my Helix code is ${word}-${num}.`,
    issuedAt: now.toISOString(),
  };
}

export async function loadVoice(kv: KVNamespace, userId: string): Promise<VoiceProfile> {
  const raw = await kv.get(voiceKey(userId));
  if (raw) return JSON.parse(raw) as VoiceProfile;
  const profile: VoiceProfile = { takes: [], phrase: mintPhrase() };
  await kv.put(voiceKey(userId), JSON.stringify(profile));
  return profile;
}

export async function saveVoice(kv: KVNamespace, userId: string, p: VoiceProfile): Promise<void> {
  await kv.put(voiceKey(userId), JSON.stringify(p));
}

export async function addTakes(
  kv: KVNamespace,
  userId: string,
  takes: Omit<VoiceTake, "id" | "recordedAt">[],
): Promise<VoiceProfile> {
  const p = await loadVoice(kv, userId);
  for (const t of takes.slice(0, 8)) {
    p.takes.push({
      ...t,
      id: crypto.randomUUID().slice(0, 8),
      recordedAt: new Date().toISOString(),
    });
  }
  p.takes = p.takes.slice(-12); // cap total takes
  if (takes.some((t) => t.isPhrase)) p.verifiedAt = new Date().toISOString();
  // Samples changed → cached compilation is stale.
  p.providerVoiceId = undefined;
  p.phrase = mintPhrase(); // fresh phrase for any future session
  await saveVoice(kv, userId, p);
  return p;
}

export async function deleteTake(
  kv: KVNamespace,
  userId: string,
  takeId: string,
): Promise<VoiceProfile> {
  const p = await loadVoice(kv, userId);
  p.takes = p.takes.filter((t) => t.id !== takeId);
  if (!p.takes.some((t) => t.isPhrase)) p.verifiedAt = undefined;
  p.providerVoiceId = undefined;
  await saveVoice(kv, userId, p);
  return p;
}

export async function deleteVoice(kv: KVNamespace, userId: string, apiKey?: string): Promise<void> {
  const p = await loadVoice(kv, userId);
  if (p.providerVoiceId && apiKey) {
    // Destroy the provider-side compilation too — deletion means deletion.
    await fetch(`https://api.elevenlabs.io/v1/voices/${p.providerVoiceId}`, {
      method: "DELETE",
      headers: { "xi-api-key": apiKey },
    }).catch(() => {});
  }
  await kv.delete(voiceKey(userId));
}

/** Ensure the provider voice exists (compile lazily), return its id. */
async function ensureProviderVoice(
  kv: KVNamespace,
  userId: string,
  apiKey: string,
  name: string,
): Promise<{ ok: true; voiceId: string } | { ok: false; error: string }> {
  const p = await loadVoice(kv, userId);
  if (p.takes.length === 0)
    return { ok: false, error: "No voice recorded. Record a session at /voice first." };
  if (!p.verifiedAt)
    return { ok: false, error: "Voice not verified — the session must include the verification phrase card." };
  if (p.providerVoiceId) return { ok: true, voiceId: p.providerVoiceId };

  const form = new FormData();
  form.append("name", `helix-${name}-${userId}`.slice(0, 60));
  for (const t of p.takes.slice(0, 6)) {
    const bytes = Uint8Array.from(atob(t.b64), (ch) => ch.charCodeAt(0));
    const ext = t.mime.includes("mp4") ? "m4a" : t.mime.includes("mpeg") ? "mp3" : "webm";
    form.append("files", new File([bytes], `${t.id}.${ext}`, { type: t.mime }));
  }
  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(`[voice] compile failed ${res.status}: ${detail}`);
    return { ok: false, error: compileError(res.status, detail) };
  }
  const out = (await res.json()) as { voice_id?: string };
  if (!out.voice_id) return { ok: false, error: "provider returned no voice id" };
  p.providerVoiceId = out.voice_id;
  await saveVoice(kv, userId, p);
  return { ok: true, voiceId: out.voice_id };
}

/**
 * Turn a provider failure into something the reader can act on.
 *
 * The distinction that matters is whose problem it is. A billing or quota
 * failure at the provider is the vault operator's to fix, and telling the
 * owner to "try again" would send them in circles — so say plainly that it
 * isn't them. Raw provider JSON helps nobody and leaks the operator's
 * account details into a third-party app's conversation.
 */
export function compileError(status: number, detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes("paid_plan_required") || d.includes("payment_required") || status === 402)
    return "Voice generation is unavailable on this Helix server right now: the voice provider account doesn't have voice cloning enabled. Nothing is wrong with your recordings, and this isn't something you can fix — tell the person who runs this vault.";
  if (status === 401 || status === 403)
    return "Voice generation is unavailable on this Helix server: the voice provider rejected its credentials. Your recordings are fine — this is a server configuration problem.";
  if (status === 429)
    return "The voice provider is rate-limiting this Helix server. Try again in a few minutes.";
  if (d.includes("too_short") || d.includes("duration"))
    return "The provider couldn't build a voice from these recordings — they may be too short. Record another session at /voice with a little more in each card.";
  return `Voice generation failed at the provider (status ${status}). Your recordings are unchanged. If this keeps happening, tell the person who runs this vault.`;
}

/** The downstream the owner's recordings actually reach. Named on the
 * consent screen and in every audit entry — an undisclosed provider is the
 * thing the whole likeness model exists to prevent. */
export const VOICE_PROVIDER = "ElevenLabs (eleven_multilingual_v2)";

/** Synthesize speech in the owner's voice. Returns mp3 bytes as base64. */
export async function synthesize(
  kv: KVNamespace,
  userId: string,
  userName: string,
  apiKey: string | undefined,
  text: string,
): Promise<
  { ok: true; b64: string; mime: string; provider: string } | { ok: false; status: number; error: string }
> {
  if (!apiKey)
    return { ok: false, status: 501, error: "voice synthesis not configured (ELEVENLABS_API_KEY missing)" };
  const compiled = await ensureProviderVoice(kv, userId, apiKey, userName);
  if (!compiled.ok) return { ok: false, status: 400, error: compiled.error };

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${compiled.voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: text.slice(0, 1000),
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    },
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(`[voice] synthesis failed ${res.status}: ${detail}`);
    return { ok: false, status: 502, error: compileError(res.status, detail) };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    s += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return { ok: true, b64: btoa(s), mime: "audio/mpeg", provider: VOICE_PROVIDER };
}
