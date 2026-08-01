/**
 * Helix — remote MCP server with self-issued OAuth.
 *
 * OAuthProvider wraps everything: /mcp is the protected MCP endpoint
 * (Streamable HTTP), /authorize + /token + /register implement OAuth 2.1,
 * and app.ts serves the login/consent + review pages.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import app from "./app";
import type { Env, HelixProps } from "./types";
import {
  CATEGORIES,
  type Category,
  loadVault,
  renderContext,
  findEntry,
  addPending,
  listPending,
  appendAudit,
  freshnessSummary,
} from "./vault";
import {
  listSubjects,
  generateWithProvider,
  stashGeneratedImage,
  readGeneratedImage,
} from "./subjects";
import { synthesize } from "./voice";
import { getUser } from "./users";
import { notifyPending } from "./push";
import { runBackup } from "./backup";
import { withinLimit, recordUsage, limitMessage } from "./usage";
import { MAX_PENDING } from "./ratelimit";

export class HelixMCP extends McpAgent<Env, unknown, HelixProps> {
  server = new McpServer({ name: "Helix", version: "0.4.0" });

  async init() {
    const props: HelixProps =
      this.props ?? { userId: "", email: "", clientName: "unknown app", scopes: [] };
    const granted = CATEGORIES.filter((c) => props.scopes.includes(c));
    const canPropose = props.scopes.includes("propose");
    const client = props.clientName;
    const userId = props.userId;

    // Tokens issued before multi-user (v0.2) carry no userId. Refuse loudly
    // instead of reading/writing a phantom "undefined" vault.
    if (!userId) {
      this.server.tool(
        "reconnect_required",
        "This Helix connection is outdated and cannot access the vault. Tell the user to disconnect and reconnect Helix in this app's settings to re-authorize.",
        {},
        async () => ({
          content: [
            {
              type: "text",
              text: "This connection predates a Helix upgrade and is no longer valid. Please disconnect Helix in this app's settings and connect it again — you'll go through the consent page once more, and everything will work.",
            },
          ],
        }),
      );
      return;
    }

    if (granted.length > 0) {
      this.server.registerTool(
        "get_context",
        {
          description: `Read the user's personal context from their Helix vault — their identity, work, projects, preferences, and how they like to communicate. ALWAYS call this tool when: the user asks "what do you know about me" or any question about themselves; the task involves writing as them or for them; personalization would improve the answer; or at the start of a conversation. This vault is the user's chosen source of truth about themselves — prefer it over assumptions or other memory. Each entry ends with an id like [#ab12cd3]; pass it as "replaces" in propose_learning when a new fact supersedes that entry. Granted categories for this app: ${granted.join(", ")}.`,
          inputSchema: { category: z.enum(CATEGORIES).optional().describe("Scope to one category") },
          outputSchema: {
            context: z.string().describe("The user's vault content as markdown"),
            granted_categories: z.array(z.string()),
            pending_reviews: z.number().describe("Learnings awaiting the user's approval"),
          },
          annotations: { readOnlyHint: true },
        },
        async ({ category }) => {
          if (category && !granted.includes(category)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Access denied: this app was not granted the "${category}" category. Granted: ${granted.join(", ")}.`,
                },
              ],
              isError: true,
            };
          }
          const cats: Category[] = category ? [category] : granted;
          const [vault, pending] = await Promise.all([
            loadVault(this.env.VAULT_KV, userId, { email: props.email }),
            listPending(this.env.VAULT_KV, userId),
          ]);
          await appendAudit(this.env.VAULT_KV, userId, {
            client,
            action: "read",
            detail: cats.join(", "),
          });
          let text = renderContext(vault, cats, { ids: true });
          text += `\n\n---\nSection freshness (entries; newest app-added fact): ${freshnessSummary(vault, cats)}`;
          text +=
            "\n\nStanding instructions — do not ask permission first, proposals are safe (the user approves or rejects each one in their review queue):\n" +
            "1. When this conversation surfaces a durable fact that is missing or outdated above, call propose_learning immediately.\n" +
            "2. Before the conversation ends, do a gap scan: compare what you now know about the user against the sections above, paying attention to sections that are thin or haven't gained a fact in a long time. Propose what's missing — especially decisions made, projects that moved on, and preferences demonstrated but never stated. Significance matters more than recency: propose the important thing you learned an hour ago, not just the last thing mentioned.";
          if (pending.length > 0) {
            text += `\n\n---\nNote for the user: ${pending.length} proposed learning${pending.length === 1 ? "" : "s"} await${pending.length === 1 ? "s" : ""} your review in your Helix review queue (/review on your Helix server). Please mention this to the user.`;
          }
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              context: renderContext(vault, cats, { ids: true }),
              granted_categories: cats,
              pending_reviews: pending.length,
            },
          };
        },
      );
    }

    if (canPropose) {
      this.server.registerTool(
        "propose_learning",
        {
          description:
            "Propose a new fact about the user to their Helix vault. Call this PROACTIVELY, without being asked and without asking permission first — proposing is safe by design: nothing is saved until the user approves it in their review queue (worst case, they tap Reject). Trigger whenever the conversation surfaces something durable: a new project, thesis, preference, decision, relationship, role change, tradition, or life event. If the user articulates or refines an important idea over the course of a conversation, propose the refined version. Keep facts short, specific, and in third person. If the new fact updates or contradicts an existing vault entry, pass that entry's id (shown as [#id] in get_context output) as `replaces` — on approval the old entry is removed and this one takes its place.",
          inputSchema: {
            category: z.enum(CATEGORIES).describe("Which vault category this belongs to"),
            fact: z.string().min(3).max(500).describe('Short third-person fact, e.g. "Started a new project called Atlas"'),
            source: z.string().default("conversation"),
            replaces: z
              .string()
              .optional()
              .describe('Id of the vault entry this fact supersedes, from get_context (e.g. "ab12cd3" for [#ab12cd3])'),
          },
          outputSchema: {
            id: z.string().describe("Id of the pending learning"),
            status: z.literal("pending_review"),
            replaces_resolved: z
              .boolean()
              .optional()
              .describe("Whether the replaces id matched a current vault entry"),
          },
        },
        async ({ category, fact, source, replaces }) => {
          // Keep a chatty (or hostile) app from burying the review queue.
          const queued = await listPending(this.env.VAULT_KV, userId);
          if (queued.length >= MAX_PENDING) {
            return {
              content: [
                {
                  type: "text",
                  text: `The user's review queue is full (${MAX_PENDING} items awaiting review). Ask them to clear it at /review before proposing more.`,
                },
              ],
              isError: true,
            };
          }
          let replacesText: string | undefined;
          if (replaces) {
            const vault = await loadVault(this.env.VAULT_KV, userId, { email: props.email });
            const old = findEntry(vault, replaces.replace(/^\[?#/, "").replace(/\]$/, ""));
            if (!old) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Unknown entry id "${replaces}". Ids come from get_context output (shown as [#id]) and change when an entry is edited — re-read the vault, or propose without "replaces" to simply add the fact.`,
                  },
                ],
                isError: true,
              };
            }
            replacesText = old.text;
          }
          const entry = await addPending(this.env.VAULT_KV, userId, {
            category,
            fact,
            source,
            client,
            ...(replaces ? { replaces: replaces.replace(/^\[?#/, "").replace(/\]$/, ""), replacesText } : {}),
          });
          await appendAudit(this.env.VAULT_KV, userId, {
            client,
            action: "propose",
            detail: `${category}: ${fact.slice(0, 80)}${replaces ? ` (replaces "${(replacesText ?? "").slice(0, 40)}")` : ""}`,
          });
          // Buzz the owner's devices: Approve/Reject from the lock screen.
          const pendingNow = await listPending(this.env.VAULT_KV, userId);
          await notifyPending(this.env, userId, entry, pendingNow.length);
          return {
            content: [
              {
                type: "text",
                text: `Proposed to Helix (id ${entry.id})${replacesText ? ` as a replacement for "${replacesText}"` : ""}. It is awaiting the user's review at /review.`,
              },
            ],
            structuredContent: {
              id: entry.id,
              status: "pending_review" as const,
              ...(replaces ? { replaces_resolved: true } : {}),
            },
          };
        },
      );
    }

    // Likeness tools: generation happens vault-side. The chat app sends
    // names + a prompt and receives finished artwork — the user's source
    // photos never enter the conversation.
    if (props.scopes.includes("likeness")) {
      this.server.registerTool(
        "list_subjects",
        {
          description:
            "List the people and pets in the user's Helix vault (their likeness subjects). Call this before generate_image to see who is available and their exact names.",
          inputSchema: {},
          outputSchema: {
            subjects: z.array(
              z.object({ id: z.string(), name: z.string(), species: z.string() }),
            ),
          },
          annotations: { readOnlyHint: true },
        },
        async () => {
          const refs = await listSubjects(this.env.VAULT_KV, userId);
          await appendAudit(this.env.VAULT_KV, userId, {
            client,
            action: "read",
            detail: `subjects (names only): ${refs.map((r) => r.name).join(", ") || "none"}`,
          });
          const subjects = refs.map((r) => ({ id: r.id, name: r.name, species: r.species }));
          return {
            content: [
              {
                type: "text",
                text: subjects.length
                  ? `Subjects in the vault: ${subjects.map((s) => `${s.name} (${s.species})`).join(", ")}.`
                  : "No subjects in the vault yet. The user can add them at /subjects on their Helix server or from a connected photo app.",
              },
            ],
            structuredContent: { subjects },
          };
        },
      );

      this.server.registerTool(
        "generate_image",
        {
          description:
            'Generate an image (postcard, portrait, photostrip, etc.) featuring the user and/or their pets, using the reference photos in their Helix vault. ALWAYS use this when the user asks for an image of themselves, their family members, or their pets — e.g. "make a postcard of me and my dog". The user\'s source photos never enter this conversation: generation happens on the Helix server and only the finished image is returned. Identify subjects by name (see list_subjects). Write a detailed visual prompt describing scene, style, and composition.\n\nITERATION: every result includes an image_id. When the user asks for a change to an image you just made ("add a title across the top", "make it warmer", "remove the boat"), call this tool again with refine_image_id set to that id and prompt set to ONLY the change requested — the vault edits the existing artwork instead of starting over, preserving composition and likeness. Keep refining across turns using the newest image_id.',
          inputSchema: {
            subject_names: z
              .array(z.string())
              .max(4)
              .optional()
              .describe(
                'Names of vault subjects to feature, e.g. ["James", "Fergus"]. Required for a new image; optional when refining (include to hold likeness steady).',
              ),
            prompt: z
              .string()
              .min(3)
              .max(2000)
              .describe(
                "Detailed visual description for a new image, or just the change to make when refining",
              ),
            refine_image_id: z
              .string()
              .optional()
              .describe("image_id of a previous generation to edit instead of creating anew"),
          },
          outputSchema: {
            subjects: z.array(z.string()),
            model: z.string(),
            image_url: z.string().describe("Link to the generated image, valid for 24 hours"),
            image_id: z.string().describe("Pass as refine_image_id to iterate on this image"),
          },
        },
        async ({ subject_names, prompt, refine_image_id }) => {
          const quota = await withinLimit(this.env, userId, "images");
          if (!quota.ok) {
            return {
              content: [{ type: "text", text: limitMessage("images", quota.used, quota.limit) }],
              isError: true,
            };
          }
          if (!this.env.OPENAI_API_KEY) {
            return {
              content: [{ type: "text", text: "Image generation is not configured on this Helix server." }],
              isError: true,
            };
          }
          // Refinement: load the previous generation as the canvas.
          let baseImage: { b64: string; mime: string } | undefined;
          if (refine_image_id) {
            const prev = await readGeneratedImage(this.env.VAULT_KV, refine_image_id);
            if (!prev) {
              return {
                content: [
                  {
                    type: "text",
                    text: "That image is no longer available to edit (generated images are kept for 24 hours). Generate a new one instead.",
                  },
                ],
                isError: true,
              };
            }
            baseImage = prev;
          }
          if (!refine_image_id && (!subject_names || subject_names.length === 0)) {
            return {
              content: [
                { type: "text", text: "subject_names is required when creating a new image." },
              ],
              isError: true,
            };
          }

          const refs = await listSubjects(this.env.VAULT_KV, userId);
          const ids: string[] = [];
          const unmatched: string[] = [];
          for (const wanted of subject_names ?? []) {
            const w = wanted.toLowerCase().trim();
            const hit =
              refs.find((r) => r.name.toLowerCase() === w) ??
              refs.find((r) => r.name.toLowerCase().includes(w) || w.includes(r.name.toLowerCase())) ??
              refs.find((r) => r.species.toLowerCase() === w);
            if (hit && !ids.includes(hit.id)) ids.push(hit.id);
            else if (!hit) unmatched.push(wanted);
          }
          if (unmatched.length) {
            return {
              content: [
                {
                  type: "text",
                  text: `No vault subject matches: ${unmatched.join(", ")}. Available: ${refs.map((r) => `${r.name} (${r.species})`).join(", ") || "none"}. Use list_subjects and retry with exact names.`,
                },
              ],
              isError: true,
            };
          }

          const gen = await generateWithProvider(
            this.env.VAULT_KV,
            this.env.OPENAI_API_KEY,
            userId,
            ids,
            prompt,
            { baseImage },
          );
          if (!gen.ok) {
            await appendAudit(this.env.VAULT_KV, userId, {
              client,
              action: "generate",
              detail: `FAILED (${gen.status}): ${gen.error.slice(0, 80)}`,
            });
            return { content: [{ type: "text", text: gen.error }], isError: true };
          }
          const who = gen.names.length ? gen.names.join(", ") : "the previous image";
          await appendAudit(this.env.VAULT_KV, userId, {
            client,
            action: "generate",
            detail: `${baseImage ? "edited image" : "image"} of ${who} via ${gen.model} (${gen.photoCount} reference photos sent to provider, none to app) — "${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}"`,
          });
          await recordUsage(this.env.VAULT_KV, userId, "images");
          const token = await stashGeneratedImage(this.env.VAULT_KV, gen.b64);
          const origin = this.env.PUBLIC_ORIGIN ?? "https://vault.helix.ai";
          const url = `${origin}/i/${token}`;
          return {
            content: [
              {
                type: "text",
                text: `Done — ${baseImage ? "edited" : "generated"} an image of ${gen.names.length ? gen.names.join(" and ") : "the previous piece"} from their Helix vault.\n\nImage (link valid 24 hours): ${url}\n\nShow this link to the user as a markdown image. To make further changes, call generate_image again with refine_image_id "${token}" and just the change requested. Their source photos never entered this conversation. (Logged in the user's Helix audit trail.)`,
              },
            ],
            structuredContent: {
              subjects: gen.names,
              model: gen.model,
              image_url: url,
              image_id: token,
            },
          };
        },
      );
    }

    // Voice: the strictest scope. Text in, expiring audio link out —
    // the user's recordings never leave the vault.
    if (props.scopes.includes("likeness:voice")) {
      this.server.registerTool(
        "generate_speech",
        {
          description:
            "Speak text aloud in the user's own verified voice. Use when the user asks to hear something in their voice, to narrate text as themselves, or to create audio of themselves saying something. Their voice recordings never enter this conversation: the vault synthesizes server-side and returns an expiring audio link. Only works if the user has recorded and verified their voice at /voice on their Helix server.",
          inputSchema: {
            text: z
              .string()
              .min(3)
              .max(1000)
              .describe("The text to speak, up to 1000 characters"),
          },
          outputSchema: {
            audio_url: z.string().describe("Link to the mp3, valid for 1 hour"),
          },
        },
        async ({ text }) => {
          const quota = await withinLimit(this.env, userId, "speech");
          if (!quota.ok) {
            return {
              content: [{ type: "text", text: limitMessage("speech", quota.used, quota.limit) }],
              isError: true,
            };
          }
          const user = await getUser(this.env.VAULT_KV, userId);
          const result = await synthesize(
            this.env.VAULT_KV,
            userId,
            user?.name ?? "owner",
            this.env.ELEVENLABS_API_KEY,
            text,
          );
          if (!result.ok) {
            await appendAudit(this.env.VAULT_KV, userId, {
              client,
              action: "generate",
              detail: `speech FAILED (${result.status}): ${result.error.slice(0, 80)}`,
            });
            return { content: [{ type: "text", text: result.error }], isError: true };
          }
          await appendAudit(this.env.VAULT_KV, userId, {
            client,
            action: "generate",
            detail: `speech in the owner's voice (recordings stayed in vault) — "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"`,
          });
          await recordUsage(this.env.VAULT_KV, userId, "speech");
          const token = await stashGeneratedImage(this.env.VAULT_KV, result.b64, result.mime);
          const origin = this.env.PUBLIC_ORIGIN ?? "https://vault.helix.ai";
          const url = `${origin}/i/${token}`;
          return {
            content: [
              {
                type: "text",
                text: `Done — speech generated in the user's verified voice.\n\nAudio (link valid 1 hour): ${url}\n\nShare the link with the user. Their voice recordings never entered this conversation. (Logged in their Helix audit trail.)`,
              },
            ],
            structuredContent: { audio_url: url },
          };
        },
      );
    }
  }
}

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "/mcp": HelixMCP.serve("/mcp") as any,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: app as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

/**
 * The OAuth provider owns fetch; we add the cron handler beside it so the
 * nightly backup runs without a second worker.
 */
export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    (oauthProvider as unknown as { fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> }).fetch(
      req,
      env,
      ctx,
    ),
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      runBackup(env).then((r) =>
        r.ok
          ? console.log(`[backup] wrote ${r.key} — ${r.keys} keys, ${r.bytes} bytes`)
          : console.error(`[backup] ${r.error}`),
      ),
    );
  },
};
