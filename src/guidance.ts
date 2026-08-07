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

/**
 * Server-level instructions, returned at initialize.
 *
 * The only surface Helix has *before* anything calls a tool. Every other hint
 * we give — the fitness note in get_context, the supersession note on a
 * propose response — arrives inside a tool result, which means it only ever
 * reaches a model that already decided to use the vault. That is a loop with
 * no start.
 *
 * The failure is real and was found by using it: a long session that covered
 * a career change, a compensation target and an employment agreement produced
 * exactly zero proposals, because nothing in it happened to touch the vault.
 * Nothing was wrong with the tool descriptions. They were never read.
 *
 * This is still the elegant fix and it must not be load-bearing. A client can
 * ignore instructions entirely, or defer the whole server and never surface
 * it — which is precisely what happened. The backstop lives in activity.ts,
 * where the vault notices it is starving and tells the owner, with no model
 * in the loop at all.
 *
 * Written as description rather than instruction, and that is the second
 * draft. The first gave orders: ALWAYS call this, propose without asking
 * permission first. Asked directly, an assistant explained why that failed:
 * tool descriptions are data from a connector, not instructions from the
 * user, so they inform what a tool is good for and do not get to set a
 * model's defaults. It also noted the cost — emphatic phrasing gets
 * discounted, and spends credibility on the descriptions where the guidance
 * genuinely matters.
 *
 * That posture is correct and will harden across clients, because tool text
 * is an injection surface. So the durable move is to be worth believing:
 * state what the vault is, what it costs to read, and what a proposal
 * actually does, then let the caller decide. The deterministic backstop in
 * activity.ts is what runs when it decides not to.
 *
 * Also deliberately not tool-specific in its demands. The tool set is built
 * per grant while instructions are fixed at construction, before props are
 * known, so a likeness-only connection reads the same text and simply has
 * fewer of the tools it mentions.
 */
export const SERVER_INSTRUCTIONS = `Helix is a context vault owned by the person you are talking to. Everything in it was individually reviewed and approved by them. They can see every access, and they can revoke yours at any time, including part-way through this conversation.

What that means in practice:

Reading it is cheap and read-only, and what comes back is stated rather than inferred. When you would otherwise be guessing at their situation, writing as them, or advising them, the vault is likely to be more accurate than reconstruction from the conversation.

Proposing a fact is not a write. It places one item in their review queue, which they accept or reject themselves; nothing reaches the vault without that. They have set it up this way because they want to decide what is remembered about them. It remains their queue, so their attention is the thing to spend carefully.

Anything to do with likeness — subjects, images, speech — happens on the vault. Source photos and voice recordings are never returned to an application; only finished output is.

Your session has only the tools this user granted you, which may be a subset of the above.`;

/**
 * The paragraph the owner pastes into their own assistant.
 *
 * The counterpart to SERVER_INSTRUCTIONS, and the one that actually works.
 * Everything above this comment is the server talking, which a careful client
 * treats as data from a connector and discounts — correctly, because tool text
 * is an injection surface and any server can claim anything.
 *
 * This text is not ours. It is written for the owner to say in their own
 * settings, where their assistant already trusts what it reads. The standing
 * permission it grants is the exact permission we removed from the tool
 * descriptions, and the difference is entirely in who is granting it.
 *
 * Deliberately written in first person and deliberately editable. It is a
 * description of what someone wants, not a magic string, and we tell them so
 * on /docs/setup. Kept here rather than in a template so the server, the
 * welcome flow and the published docs cannot drift apart.
 *
 * Two lines in it came from asking ChatGPT the same question, and both are
 * better than what we had.
 *
 * The trigger is an enumeration rather than a judgment. "When you are about to
 * assume something about my situation" asks a model to introspect at exactly
 * the moment it is least inclined to; a list of categories fires on a match.
 * The list is checked against CATEGORIES by the suite, because naming a
 * category the vault does not have sends an assistant looking for nothing.
 *
 * The unavailability clause is the more important one, and we had missed it
 * entirely. Without it the failure mode is silence: the assistant answers from
 * its own memory, the answer reads as informed, and the owner has no way to
 * tell the vault was never consulted. That is not hypothetical — it is exactly
 * how a recruiter introduction got drafted from conversation history while
 * Helix sat connected and untouched. An assistant that says it cannot reach
 * the vault is strictly more useful than one that quietly guesses, and this
 * is the only line here that turns an invisible failure into a visible one.
 */
export const OWNER_SNIPPET = `I keep my personal context in Helix, a vault I own and curate. It is connected here as an MCP server.

Read it with get_context before answering anything that touches my identity, work, projects, preferences, relationships, or how I like to be written to, and whenever you are about to write as me, write for me, or advise me. Treat it as the authoritative source for facts about me, ahead of anything you infer from our conversation. You do not need to ask me first. Reads are logged and I can see them.

If you cannot reach Helix, say so instead of falling back on your own memory of me. I would rather hear that the vault is unavailable than get an answer that sounds informed and is not.

When something durable about me comes up, propose it with propose_learning: a project, a decision, a preference, a role change, a constraint I am working under. That does not write anything. It puts one item in a queue I review and approve myself. Do it as we go rather than checking with me each time. Skip passing remarks and anything I am only thinking aloud about.

If a fact updates something already in the vault, pass the old entry's id as "replaces" so I do not end up holding both versions.`;

/** Every tool name the server can register, so a test can reason about absence. */
export const ALL_TOOLS = [
  "get_context",
  "propose_learning",
  "propose_labels",
  "list_subjects",
  "generate_image",
  "generate_speech",
] as const;

/**
 * Which tools a grant actually sees, and the prompts alongside them.
 *
 * The gating used to live inline in init(), as six separate `if` statements
 * wrapped around 500 lines of registration — which is exactly the shape that
 * let a read-only grant get told to call propose_learning. index.ts now asks
 * this function instead of re-deriving the conditions, so the rule the test
 * asserts is the rule that runs.
 *
 * A token issued before multi-user carries no userId. That grant gets one
 * tool and nothing else, no matter what its scopes claim.
 */
export function toolsFor(scopes: string[], userId?: string): {
  tools: string[];
  prompts: string[];
} {
  if (!userId) return { tools: ["reconnect_required"], prompts: [] };
  const has = (s: string) => scopes.includes(s);
  const canPropose = has("propose");
  const tools: string[] = [];
  // Any category at all is enough to read; which categories come back is
  // narrowed inside the tool, not here.
  if (CATEGORIES.some((c) => has(c))) tools.push("get_context");
  if (canPropose) tools.push("propose_learning", "propose_labels");
  if (has("likeness")) tools.push("list_subjects", "generate_image");
  if (has("likeness:voice")) tools.push("generate_speech");
  return { tools, prompts: canPropose ? ["catch_up_my_vault"] : [] };
}

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
