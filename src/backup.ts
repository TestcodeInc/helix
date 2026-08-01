/**
 * Nightly vault backup to R2.
 *
 * Losing a stranger's vault to a bug is the one unrecoverable reputation
 * event, so this runs on a cron and can also be triggered by hand from
 * /admin. Ephemeral keys (rate-limit counters, one-time tokens, generated
 * media) are skipped — they're TTL'd and worthless in a restore.
 *
 * Note the ceiling: this materialises everything in memory, which is fine
 * for a beta-sized instance and will need streaming (or per-user objects)
 * once vaults with media get numerous.
 */
import type { Env } from "./types";

const EPHEMERAL = ["genimg:", "rl:", "verify:", "reset:"];
const RETAIN_DAYS = 30;

export interface BackupResult {
  ok: boolean;
  key?: string;
  keys?: number;
  bytes?: number;
  error?: string;
}

export async function runBackup(env: Env): Promise<BackupResult> {
  if (!env.BACKUPS) return { ok: false, error: "no R2 bucket bound (BACKUPS)" };

  try {
    const dump: Record<string, string> = {};
    let cursor: string | undefined;
    let scanned = 0;

    do {
      const page = await env.VAULT_KV.list({ cursor, limit: 1000 });
      for (const k of page.keys) {
        scanned++;
        if (EPHEMERAL.some((p) => k.name.startsWith(p))) continue;
        const value = await env.VAULT_KV.get(k.name);
        if (value !== null) dump[k.name] = value;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    const body = JSON.stringify({
      format: "helix-backup/v1",
      taken_at: new Date().toISOString(),
      key_count: Object.keys(dump).length,
      scanned,
      keys: dump,
    });
    const key = `backups/${new Date().toISOString().slice(0, 10)}.json`;
    await env.BACKUPS.put(key, body, {
      httpMetadata: { contentType: "application/json" },
    });

    await pruneOldBackups(env);
    return { ok: true, key, keys: Object.keys(dump).length, bytes: body.length };
  } catch (err) {
    console.error(`[backup] failed: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
}

async function pruneOldBackups(env: Env): Promise<void> {
  if (!env.BACKUPS) return;
  const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
  const listed = await env.BACKUPS.list({ prefix: "backups/" });
  for (const obj of listed.objects) {
    const day = obj.key.slice("backups/".length, "backups/".length + 10);
    const at = Date.parse(day);
    if (Number.isFinite(at) && at < cutoff) await env.BACKUPS.delete(obj.key);
  }
}
