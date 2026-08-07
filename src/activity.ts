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
  /**
   * Apps currently holding a grant, read from the OAuth store rather than
   * inferred from the audit log. Those are different questions: a grant can
   * exist while nothing has ever used it, which is precisely the state worth
   * spotting in a new user.
   */
  connections: number;
  /** Their names, so the admin line can say who rather than how many. */
  connectedApps: string[];
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
  const [audit, pending, labelDoc, devices, limits, usage, grants] = await Promise.all([
    readAudit(kv, userId),
    listPending(kv, userId),
    loadLabels(kv, userId),
    listDevices(kv, userId),
    limitsFor(env, userId),
    usageFor(kv, userId),
    // Never worth failing the whole admin page over: if the OAuth store is
    // unreachable we show zero connections rather than nothing at all.
    env.OAUTH_PROVIDER.listUserGrants(userId).catch(() => ({ items: [] })),
  ]);

  // The grant label is "<App> → <email>"; the app name is the half before it.
  const connectedApps = [
    ...new Set(
      (grants.items ?? []).map((g) => {
        const label = (g.metadata as { label?: string } | undefined)?.label ?? "";
        return label.split(" → ")[0] || "unknown app";
      }),
    ),
  ];

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
    connections: connectedApps.length,
    connectedApps,
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
  // Connections come from the OAuth store, so this is now a fact rather than
  // an inference from an empty audit log — which was wrong for anyone who had
  // connected an app that never called anything.
  //
  // No grant *and* no history is a cold start. No grant *with* history is a
  // disconnection, which is a different thing: the OAuth store forgets a
  // revoked grant, the audit log doesn't. Telling someone who used the vault
  // for a month that they have "no apps connected yet" reads as a bug.
  if (a.connections === 0 && !a.lastRead) return { text: "no apps connected yet", state: "cold" };
  // Ahead of the disconnection case on purpose: a rotting queue is the one
  // state worth acting on, and it stays true whether or not a grant survives.
  if (a.pending > 0 && (a.oldestPendingDays ?? 0) >= 7)
    return {
      text: `${a.pending} pending, oldest ${a.oldestPendingDays} days — queue is rotting`,
      state: "stuck",
    };
  if (a.connections === 0)
    return {
      text: `no apps connected now — last read ${days(a.lastRead!.at)}d ago by ${a.lastRead!.client}`,
      state: "cold",
    };
  // Connected but never used. Its own state, because it is a different problem
  // from never having connected: they got through consent and then nothing
  // asked the vault for anything.
  if (!a.lastRead)
    return {
      text: `${a.connectedApps.join(", ")} connected, but nothing has read the vault yet`,
      state: "cold",
    };
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
