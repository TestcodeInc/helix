/**
 * Per-user activity signal for the admin screen.
 *
 * Counts and timestamps only — never content. The security page tells users
 * the operator could technically read their vault but doesn't; a dashboard
 * showing what their pending items *say* would quietly make that false. This
 * module is deliberately incapable of it: nothing here returns vault text.
 *
 * The question it exists to answer is whether an invited user actually
 * arrived, connected something, and came back — and whether their review
 * queue is rotting. Signups are easy to celebrate and mean nothing on their
 * own.
 */
import type { Env } from "./types";
import { readAudit, listPending, type AuditEntry } from "./vault";
import { loadLabels } from "./labels";
import { listDevices } from "./devices";
import { limitsFor, usageFor } from "./usage";

export interface UserActivity {
  pending: number;
  /** Days since the oldest un-reviewed proposal. The rot signal. */
  oldestPendingDays: number | null;
  /** Last read by any app, and which one. */
  lastRead: { at: string; client: string } | null;
  /** Last time the owner approved or rejected anything. */
  lastCurated: string | null;
  /** Last time any app proposed anything. The other half of the loop. */
  lastProposed: string | null;
  /** Reads in the last 14 days. Distinguishes a quiet vault from a busy one
   *  that nothing is contributing to. */
  recentReads: number;
  /** Entries the owner has labelled, and how many are private. */
  labelled: number;
  private: number;
  devices: number;
  images: { used: number; limit: number };
  speech: { used: number; limit: number };
  /** Total audited events — a blunt but honest "have they done anything". */
  events: number;
}

const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

export async function userActivity(env: Env, userId: string): Promise<UserActivity> {
  const kv = env.VAULT_KV;
  const [audit, pending, labelDoc, devices, limits, usage] = await Promise.all([
    readAudit(kv, userId),
    listPending(kv, userId),
    loadLabels(kv, userId),
    listDevices(kv, userId),
    limitsFor(env, userId),
    usageFor(kv, userId),
  ]);

  // The audit log is newest-first, so the first match is the latest.
  const latest = (match: (e: AuditEntry) => boolean) => audit.find(match) ?? null;
  const read = latest((e) => e.action === "read");
  // Approvals and rejections are the owner's own work; "write" covers them
  // along with imports and direct edits made through the owner door.
  const curated = latest((e) => e.action === "write");
  const proposed = latest((e) => e.action === "propose");

  // Reads inside the window, so we can tell "nobody is using this" apart from
  // "plenty of apps are using this and none of them ever contribute".
  const cutoff = Date.now() - 14 * 86_400_000;
  const recentReads = audit.filter(
    (e) => e.action === "read" && Date.parse(e.at) >= cutoff,
  ).length;

  const oldest = pending.reduce<string | null>(
    (min, p) => (!min || p.proposedAt < min ? p.proposedAt : min),
    null,
  );

  return {
    pending: pending.length,
    oldestPendingDays: oldest ? days(oldest) : null,
    lastRead: read ? { at: read.at, client: read.client } : null,
    lastCurated: curated?.at ?? null,
    lastProposed: proposed?.at ?? null,
    recentReads,
    labelled: Object.keys(labelDoc.labels).length,
    private: labelDoc.private.length,
    devices: devices.length,
    images: { used: usage.images, limit: limits.images },
    speech: { used: usage.speech, limit: limits.speech },
    events: audit.length,
  };
}

/**
 * One line, in words, about where this user actually is. Written to be
 * skimmable down a column: the failure states should be obvious without
 * reading the numbers beside them.
 */
export function activitySummary(a: UserActivity): {
  text: string;
  state: "cold" | "warm" | "stuck" | "starving";
} {
  if (a.events === 0) return { text: "never connected an app", state: "cold" };
  if (a.pending > 0 && (a.oldestPendingDays ?? 0) >= 7)
    return {
      text: `${a.pending} pending, oldest ${a.oldestPendingDays} days — queue is rotting`,
      state: "stuck",
    };
  if (!a.lastRead) return { text: "no app has read the vault yet", state: "cold" };
  const since = days(a.lastRead.at);
  if (since >= 14)
    return { text: `last read ${since} days ago by ${a.lastRead.client} — gone quiet`, state: "cold" };
  if (!a.lastCurated) return { text: "reads, but has never approved anything", state: "warm" };
  if (isStarving(a))
    return {
      text: `${a.recentReads} reads in 14 days, nothing proposed in ${proposalDrySpell(a)} — vault is starving`,
      state: "starving",
    };
  return { text: `active — last read ${since === 0 ? "today" : `${since}d ago`}`, state: "warm" };
}

/** Days since anything was proposed, or since the vault's first event if
 *  nothing ever has been. */
export function proposalDrySpell(a: UserActivity): number | null {
  return a.lastProposed ? days(a.lastProposed) : null;
}

/**
 * The failure this exists for.
 *
 * A vault can look healthy on every other measure — apps connected, reads
 * happening, queue empty, owner responsive — while quietly stopping being
 * true about the person. Assistants read it and never contribute back, so it
 * ages into a description of who they were when they set it up.
 *
 * It is invisible precisely because nothing is broken. An empty review queue
 * reads as "all caught up" and is indistinguishable from "nothing has been
 * proposed in a month".
 *
 * Found by using the product: a day-long conversation covering a career
 * change, a compensation target and an employment agreement produced zero
 * proposals, because the assistant never had a reason to touch the vault and
 * so never saw a single one of our carefully worded hints. Every model-side
 * fix we have lives inside a tool result, which only reaches a model that
 * already decided to call a tool. This detection needs no model at all, which
 * is the point.
 *
 * Deliberately requires reads to be happening. A vault nobody is using isn't
 * starving, it's just idle, and that's the "gone quiet" case above.
 */
const STARVING_READS = 5;
const STARVING_DAYS = 21;

export function isStarving(a: UserActivity): boolean {
  if (a.recentReads < STARVING_READS) return false; // idle, not starving
  if (a.pending > 0) return false; // something is contributing
  const dry = proposalDrySpell(a);
  return dry === null || dry >= STARVING_DAYS;
}
