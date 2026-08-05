/**
 * The text `get_context` returns to an assistant.
 *
 * Extracted from index.ts so it can be tested. index.ts imports
 * `cloudflare:workers`, which means the whole MCP surface — the tool that
 * matters most in this product — could not be loaded outside the Worker
 * runtime and therefore had no assertions at all. A scope bug lived in it for
 * a full version because of that: a read-only grant was being told to call
 * propose_learning and propose_labels, tools it had never been given.
 *
 * Everything here is a pure function of its inputs. No KV, no audit, no
 * network. index.ts does the reading and the logging and hands the results in.
 *
 * The guidance is deliberately assembled rather than templated: each block is
 * conditional on something real — the scopes this grant carries, whether the
 * vault is nearly empty, whether anything is waiting for review — and the
 * conditions are the part worth asserting.
 */
import {
  CATEGORIES,
  renderContext,
  freshnessSummary,
  type Category,
  type Vault,
} from "./vault";

export interface GuidanceInput {
  /** Already filtered for labels and privacy by the caller. */
  vault: Vault;
  /** Categories this response covers. */
  categories: Category[];
  /** Labels in use, with counts, already narrowed to this grant. */
  labels: { label: string; count: number }[];
  /** The label the caller asked to scope to, if any. */
  askedLabel?: string;
  /** How many proposals are waiting in the owner's review queue. */
  pendingCount: number;
  /** Whether this grant carries the `propose` scope. */
  canPropose: boolean;
}

/** Entries visible in this response, across every category. */
export function countEntries(vault: Vault): number {
  return CATEGORIES.reduce((n, c) => n + vault[c].base.length + vault[c].learned.length, 0);
}

/**
 * A vault with almost nothing in it and nothing waiting. The product's weakest
 * moment: nothing to read, so nothing to demonstrate, and a form to fill in
 * before anything works.
 *
 * Four rather than zero because a vault seeded with name and email at signup
 * isn't meaningfully less empty than one with neither.
 */
export const NEARLY_EMPTY_AT = 4;

export function isNearlyEmpty(vault: Vault, pendingCount: number): boolean {
  return countEntries(vault) <= NEARLY_EMPTY_AT && pendingCount === 0;
}

const ONBOARDING_OFFER =
  "\n\n---\nThis vault is nearly empty, so the user is probably new to Helix. Tell them, in your own words, that you can help fill it: you already know things about them from your conversations, and you can propose those as facts for them to approve or reject. Ask first. If they agree, propose what you genuinely know — one propose_learning call per fact, spread across the categories above, and only things you are actually confident about. Say plainly that some of it may surprise them, that nothing is saved until they approve it, and that rejecting is as useful as approving.";

const ONBOARDING_READ_ONLY =
  "\n\n---\nThis vault is nearly empty and this app can only read it, so you cannot help fill it directly. Tell the user they can add facts themselves at /vault on their Helix server, or connect an assistant with permission to propose so it can offer what it already knows about them.";

const STANDING_INSTRUCTIONS =
  "\n\nStanding instructions — do not ask permission first, proposals are safe (the user approves or rejects each one in their review queue):\n" +
  "1. When this conversation surfaces a durable fact that is missing or outdated above, call propose_learning immediately. If it CORRECTS an entry above, pass that entry's id as \"replaces\" — a correction proposed without it leaves the vault holding both versions.\n" +
  "2. Before the conversation ends, do a gap scan: compare what you now know about the user against the sections above, paying attention to sections that are thin or haven't gained a fact in a long time. Propose what's missing — especially decisions made, projects that moved on, and preferences demonstrated but never stated. Significance matters more than recency: propose the important thing you learned an hour ago, not just the last thing mentioned.\n" +
  "3. If entries above are untagged and clearly belong to a project, person or recurring thread, call propose_labels for them. Labels are how the user hands one app a single slice of their vault instead of a whole category, so tagging is real work on their behalf. Reuse the labels already listed rather than minting near-duplicates.";

export function buildContextText(input: GuidanceInput): string {
  const { vault, categories, labels, askedLabel, pendingCount, canPropose } = input;

  let text = renderContext(vault, categories, { ids: true });
  text += `\n\n---\nSection freshness (entries; newest app-added fact): ${freshnessSummary(vault, categories)}`;

  if (labels.length) {
    text += `\nLabels in use (call get_context with "label" to scope to one): ${labels
      .map((l) => `${l.label} (${l.count})`)
      .join(", ")}`;
  }
  if (askedLabel && !labels.some((l) => l.label === askedLabel)) {
    text += `\nNote: no entries carry the label "${askedLabel}", so nothing was returned for it.`;
  }

  const nearlyEmpty = isNearlyEmpty(vault, pendingCount);

  /**
   * Every block below names a tool. A grant without `propose` has none of
   * them, and guidance that sends a model hunting for a tool it wasn't given
   * undermines the guidance that is correct. So the whole propose-shaped half
   * is gated, and a read-only grant staring at an empty vault gets told the
   * one thing it can usefully say instead of nothing.
   */
  if (canPropose) {
    if (nearlyEmpty) text += ONBOARDING_OFFER;
    text += STANDING_INSTRUCTIONS;
  } else if (nearlyEmpty) {
    text += ONBOARDING_READ_ONLY;
  }

  if (pendingCount > 0) {
    text += `\n\n---\nNote for the user: ${pendingCount} proposed learning${pendingCount === 1 ? "" : "s"} await${pendingCount === 1 ? "s" : ""} your review in your Helix review queue (/review on your Helix server). Please mention this to the user.`;
  }

  return text;
}
