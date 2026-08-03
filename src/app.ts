/**
 * Default handler for everything that is not /mcp:
 *   GET  /                landing
 *   GET/POST /login       email + passphrase → session cookie
 *   GET  /logout
 *   GET/POST /invite/:token   accept invite, set passphrase
 *   GET/POST /admin       create invites, list users (ADMIN_SECRET)
 *   GET/POST /authorize   OAuth login + consent (per-category scopes)
 *   GET  /review          review queue + audit log (session)
 *   POST /review/decide
 *   GET  /vault           vault editor (session)
 *   POST /vault/add, /vault/update
 *
 * /token and /register are handled by workers-oauth-provider itself.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import {
  CATEGORIES,
  type Category,
  loadVault,
  saveVault,
  renderContext,
  listPending,
  decidePending,
  readAudit,
  appendAudit,
  verifyAuditChain,
  findEntry,
  entryId as entryIdOf,
} from "./vault";
import {
  hashPassphrase,
  verifyPassphrase,
  createSessionCookie,
  verifySessionCookie,
  createAdminCookie,
  verifyAdminCookie,
  CLEAR_SESSION_COOKIE,
} from "./auth";
import {
  listSubjects,
  getSubject,
  createSubject,
  deleteSubject,
  addPhotosToSubject,
  deletePhotoFromSubject,
  makePhotoPrimary,
  setPhotoThumb,
  MAX_PHOTOS_PER_SUBJECT,
  parseDataUri,
  zipPhotos,
  readGeneratedImage,
  type SubjectPhoto,
} from "./subjects";
import { loadVoice, addTakes, deleteTake, deleteVoice, VOICE_CARDS, VOICE_PROVIDER } from "./voice";
import { limitsFor, usageFor } from "./usage";
import { emailConfigured, sendVerification, sendReset } from "./email";
import { rateLimit, clientId, verifyTurnstile, turnstileWidget } from "./ratelimit";
import { runBackup } from "./backup";
import { userActivity, activitySummary } from "./activity";
import { checkExport, importExport, importSummary, MAX_IMPORT_BYTES } from "./importer";
import {
  loadLabels,
  setLabels,
  setPrivate,
  relabelEntry,
  pruneLabels,
  labelIndex,
  normalizeLabel,
} from "./labels";
import {
  createDevice,
  getDeviceByToken,
  setDevicePushToken,
  revokeDevice,
  listDevices,
} from "./devices";
import {
  type User,
  getUser,
  uniqueUserId,
  markVerified,
  getUserByEmail,
  createUser,
  deleteUser,
  listUsers,
  createInvite,
  getInvite,
  markInviteUsed,
  listPendingInvites,
  deleteInvite,
} from "./users";

const app = new Hono<{ Bindings: Env }>();

// Canonical-host redirect: humans landing on the workers.dev URL get sent
// to vault.helix.ai. Protocol traffic is untouched — /mcp and /api/* are
// routed by the OAuthProvider before this handler, /token and /register
// likewise, and /authorize is exempted so OAuth flows started by clients
// still configured with the old URL complete without a mid-flow host hop.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname.endsWith(".workers.dev") && !url.pathname.startsWith("/authorize")) {
    url.hostname = "vault.helix.ai";
    return c.redirect(url.toString(), 301);
  }
  await next();
});

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Ctx = Context<{ Bindings: Env }>;

async function sessionUser(c: Ctx): Promise<User | null> {
  const userId = await verifySessionCookie(c.req.header("Cookie"), c.env.COOKIE_SECRET);
  return userId ? getUser(c.env.VAULT_KV, userId) : null;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#0e0e11;color:#e8e8ea;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.5}
  h1{font-size:1.4em} h2{font-size:1.05em;color:#a8a8b0;margin-top:2em} h3{font-size:.95em;color:#a8a8b0}
  a{color:#8ab4ff} .card{background:#1a1a20;border:1px solid #2a2a33;border-radius:10px;padding:16px 20px;margin:12px 0}
  input[type=text],input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #2a2a33;background:#111116;color:#e8e8ea;margin:4px 0 12px}
  select{padding:8px;border-radius:8px;border:1px solid #2a2a33;background:#111116;color:#e8e8ea}
  label{font-size:.92em} .scope{display:block;margin:4px 0}
  button{background:#4f7cff;color:#fff;border:0;border-radius:8px;padding:9px 18px;font-size:.95em;cursor:pointer}
  button.ghost{background:#2a2a33} button.small{padding:5px 10px;font-size:.85em}
  .muted{color:#77777f;font-size:.85em}
  .row{display:flex;gap:8px;align-items:center}
  .entry{display:flex;gap:8px;align-items:center;margin:6px 0}
  .entry input[type=text]{margin:0;flex:1}
  nav{margin-bottom:20px} nav a{margin-right:14px}
  code{background:#1a1a20;padding:2px 6px;border-radius:6px;word-break:break-all}
  .badge{background:#4f7cff;border-radius:999px;padding:1px 7px;font-size:.75em;color:#fff}
  .hint{color:#77777f;font-size:.85em;margin:-4px 0 8px}
  .fact{display:flex;gap:10px;align-items:baseline;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1d1d24}
  .fact-text{flex:1;min-width:0;overflow-wrap:anywhere}
  .fact-src{color:#55555e;font-size:.78em;margin-top:2px}
  .fact .editor{display:none;flex:1;gap:8px;align-items:center;flex-wrap:wrap}
  .fact .editor input[type=text]{margin:0;flex:1;min-width:180px}
  .fact.editing .editor{display:flex}
  .fact.editing .reader{display:none}
  .linkbtn{background:none;border:0;color:#8ab4ff;cursor:pointer;font-size:.85em;padding:4px 6px;white-space:nowrap}
  button.danger{background:#3a2026;color:#ff9c9c}
  .banner{background:#20222e;border:1px solid #35395a;border-radius:10px;padding:12px 16px;margin:14px 0}
  .addrow{display:flex;gap:8px;margin:10px 0 4px}
  .addrow input{margin:0;flex:1}
  .replacer{margin:8px 0}
  .replacer select{margin:6px 0 2px;max-width:100%}
  .state{margin:4px 0;font-size:.9em}
  .state--stuck{color:#f0a0b4}
  .state--cold{color:#c9a86a}
  .state--warm{color:#7fd6a8}
  .chip{display:inline-block;background:#22243a;border:1px solid #34375a;color:#9aa0c8;border-radius:999px;padding:1px 8px;font-size:.72em;margin-left:6px;vertical-align:middle}
  .chip-private{background:#2e2233;border-color:#5a3448;color:#c89ab4}
  .labelrow{display:block;font-size:.82em;color:#8a8a94;margin:6px 0}
  .small-input{width:auto;min-width:180px;margin:0 0 0 6px;padding:4px 8px;font-size:.9em}
  pre{background:#111116;border:1px solid #2a2a33;padding:16px;border-radius:10px;white-space:pre-wrap;font-size:.85em;line-height:1.5}
  footer{margin:48px 0 24px;padding-top:16px;border-top:1px solid #1d1d24;font-size:.82em;color:#55555e}
  footer a{color:#77777f;margin-right:12px}
  .legal h2{color:#e8e8ea;margin-top:1.6em}
  .legal p,.legal li{color:#a8a8b0}
</style></head><body>${body}
<footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a><a href="/account">Account</a></footer>
</body></html>`;
}

/** Human-facing names, descriptions, and add-placeholders for vault categories. */
const CATEGORY_META: Record<Category, { label: string; hint: string; ph: string }> = {
  identity: { label: "About you", hint: "The basics — who you are.", ph: "e.g. Based in Chicago" },
  work: { label: "Work", hint: "What you do.", ph: "e.g. High school teacher" },
  projects: { label: "Projects", hint: "What you're working on right now.", ph: "e.g. Planning a big trip" },
  preferences: { label: "Preferences", hint: "How you like things done.", ph: "e.g. Short answers over long ones" },
  relationships: { label: "People & family", hint: "The people who matter — only what you choose to share.", ph: "e.g. Married to Sam; two kids" },
  "communication-style": { label: "How you communicate", hint: "How you like your AI to talk to you.", ph: "e.g. Plain language, no jargon" },
};

/** Every grantable scope in consent-screen order, in plain language. */
const SCOPE_META: Record<string, { label: string; desc: string }> = {
  ...Object.fromEntries(
    CATEGORIES.map((cat) => [
      cat,
      { label: `Read ${CATEGORY_META[cat].label.toLowerCase()}`, desc: CATEGORY_META[cat].hint },
    ]),
  ),
  propose: {
    label: "Propose learnings",
    desc: "It can suggest new facts — they wait in your review queue and are never written directly.",
  },
  likeness: {
    label: "Likeness",
    desc: "It sees names and small thumbnails only; your full photos go to the image generator it declares, never to the app.",
  },
  "likeness:write": {
    label: "Add subjects",
    desc: "It can save new people or pets to your vault — photos go straight from your device to your vault.",
  },
  "likeness:voice": {
    label: "Voice",
    // "Never shared" was not true: the recordings reach the speech provider
    // to build the voice. They never reach the app, which is the promise
    // that was meant — say the accurate version of it.
    desc: `It can request speech in your verified voice and receives finished audio. The app never receives your recordings; they go to ${VOICE_PROVIDER} to build your voice, and every request is logged.`,
  },
};

/** What gets pre-checked when an app doesn't declare its scopes. */
const DEFAULT_SCOPES = new Set<string>([...CATEGORIES, "propose"]);

const nav = (user: User | null, pending = 0) =>
  user
    ? `<nav><a href="/vault">Vault</a><a href="/subjects">Subjects</a><a href="/voice">Voice</a><a href="/review">Review${pending > 0 ? ` <span class="badge">${pending}</span>` : ""}</a><a href="/audit">Audit</a><a href="/connections">Connections</a><span class="muted">${esc(user.name)}</span> <a href="/logout" class="muted">sign out</a></nav>`
    : `<nav><a href="/signup">Create a vault</a><a href="/login">Sign in</a></nav>`;

/** Nav with the pending-review badge (one cheap KV read for signed-in users). */
async function navFor(c: Ctx, user: User | null): Promise<string> {
  const pending = user ? (await listPending(c.env.VAULT_KV, user.id)).length : 0;
  return nav(user, pending);
}

// ---------- landing ----------

app.get("/", async (c) => {
  const user = await sessionUser(c);
  return c.html(
    page(
      "Helix",
      `${await navFor(c, user)}<h1>Helix</h1>
<p><em>AI knows everything. Helix knows you.</em></p>
<p>Your personal context vault. Point any MCP client at <code>${esc(new URL(c.req.url).origin)}/mcp</code> and grant it scoped access.</p>
${user ? "" : `<p><a href="/signup"><strong>Create your vault →</strong></a></p>`}`,
    ),
  );
});

// ---------- login / logout ----------

const loginForm = (msg = "") => `
${msg ? `<p class="muted">${esc(msg)}</p>` : ""}
<div class="card"><form method="POST" action="/login">
  <label>Email</label><input type="email" name="email" required>
  <label>Passphrase</label><input type="password" name="passphrase" required>
  <button type="submit">Sign in</button>
  <p class="muted"><a href="/forgot">Forgot your passphrase?</a> · No vault yet? <a href="/signup">Create one</a>.</p>
</form></div>`;

app.get("/login", (c) => c.html(page("Sign in — Helix", `<h1>Helix</h1>${loginForm()}`)));

// ---------- self-serve signup, verification, passphrase reset ----------

const MIN_PASSPHRASE = 10;

/** One-use token in KV: verify:<t> | reset:<t> → userId */
const mintToken = async (kv: KVNamespace, kind: "verify" | "reset", userId: string, ttl: number) => {
  const token = crypto.randomUUID().replace(/-/g, "");
  await kv.put(`${kind}:${token}`, userId, { expirationTtl: ttl });
  return token;
};
const readToken = (kv: KVNamespace, kind: "verify" | "reset", token: string) =>
  kv.get(`${kind}:${token}`);

const signupForm = (env: Env, msg = "", values: { name?: string; email?: string } = {}) => `
${msg ? `<p class="muted">${esc(msg)}</p>` : ""}
<div class="card"><form method="POST" action="/signup">
  <label>Your name</label><input type="text" name="name" required value="${esc(values.name ?? "")}">
  <label>Email</label><input type="email" name="email" required value="${esc(values.email ?? "")}">
  <label>Passphrase <span class="muted">(at least ${MIN_PASSPHRASE} characters — a phrase beats a password)</span></label>
  <input type="password" name="passphrase" required minlength="${MIN_PASSPHRASE}">
  <label>Confirm passphrase</label><input type="password" name="passphrase2" required minlength="${MIN_PASSPHRASE}">
  ${turnstileWidget(env)}
  <button type="submit">Create my vault</button>
  <p class="muted">Your passphrase encrypts nothing yet and unlocks everything — we can't recover it for you, but you can reset it by email. Already have a vault? <a href="/login">Sign in</a>.</p>
</form></div>`;

app.get("/signup", (c) =>
  c.html(
    page(
      "Create your vault — Helix",
      `<h1>Create your vault</h1>
<p class="muted">One place your AI apps read from. You decide what goes in, you see every read, and you can cut any app off in one click.</p>
${signupForm(c.env)}`,
    ),
  ),
);

app.post("/signup", async (c) => {
  if (!(await rateLimit(c.env.VAULT_KV, "signup", clientId(c.req.raw), 8, 3600))) {
    return c.html(
      page("Slow down — Helix", `<h1>Too many attempts</h1><p class="muted">Try again in a little while.</p>`),
      429,
    );
  }
  const form = await c.req.formData();
  const name = (form.get("name")?.toString() ?? "").trim().slice(0, 60);
  const email = (form.get("email")?.toString() ?? "").trim().toLowerCase();
  const passphrase = form.get("passphrase")?.toString() ?? "";
  const passphrase2 = form.get("passphrase2")?.toString() ?? "";

  const fail = (msg: string) =>
    c.html(page("Create your vault — Helix", `<h1>Create your vault</h1>${signupForm(c.env, msg, { name, email })}`), 400);

  if (!(await verifyTurnstile(c.env, c.req.raw, form.get("cf-turnstile-response")?.toString() ?? "")))
    return fail("Please complete the human check and try again.");
  if (!name || !email.includes("@")) return fail("Please enter your name and a valid email.");
  if (passphrase.length < MIN_PASSPHRASE)
    return fail(`Passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  if (passphrase !== passphrase2) return fail("The two passphrases don't match.");

  const existing = await getUserByEmail(c.env.VAULT_KV, email);
  if (existing && !existing.unverified) {
    return fail("An account already exists for that email. Sign in, or reset your passphrase.");
  }

  // Unverified account for this address (or none): (re)create it. An
  // unverified account can't be used, so overwriting is safe.
  const userId = existing?.id ?? (await uniqueUserId(c.env.VAULT_KV, email));
  const user = await createUser(c.env.VAULT_KV, {
    id: userId,
    email,
    name,
    passHash: await hashPassphrase(passphrase),
    unverified: true,
  });

  const token = await mintToken(c.env.VAULT_KV, "verify", user.id, 86_400);
  const link = `${new URL(c.req.url).origin}/verify/${token}`;
  const sent = await sendVerification(c.env, email, name, link);

  return c.html(
    page(
      "Check your email — Helix",
      `<h1>Check your email</h1>
<p>We sent a confirmation link to <strong>${esc(email)}</strong>. Click it and your vault is ready.</p>
${
  sent
    ? `<p class="muted">Didn't arrive within a minute? Check spam, or <a href="/signup">try again</a>.</p>`
    : emailConfigured(c.env)
      ? `<p class="muted">We couldn't send the email just now. <a href="/signup">Try again</a> in a moment.</p>`
      : `<div class="banner"><strong>Email isn't configured on this server.</strong> Use this link to finish: <a href="${link}">confirm your vault</a></div>`
}`,
    ),
  );
});

app.get("/verify/:token", async (c) => {
  const userId = await readToken(c.env.VAULT_KV, "verify", c.req.param("token"));
  const user = userId ? await getUser(c.env.VAULT_KV, userId) : null;
  if (!user) {
    return c.html(
      page(
        "Link expired — Helix",
        `<h1>That link has expired</h1><p class="muted">Confirmation links last 24 hours. <a href="/signup">Sign up again</a> and we'll send a fresh one.</p>`,
      ),
      404,
    );
  }
  await markVerified(c.env.VAULT_KV, user.id);
  await c.env.VAULT_KV.delete(`verify:${c.req.param("token")}`);
  c.header("Set-Cookie", await createSessionCookie(user.id, c.env.COOKIE_SECRET));
  return c.redirect("/welcome");
});

app.post("/signup/resend", async (c) => {
  const email = ((await c.req.formData()).get("email")?.toString() ?? "").trim().toLowerCase();
  const user = await getUserByEmail(c.env.VAULT_KV, email);
  if (user?.unverified) {
    const token = await mintToken(c.env.VAULT_KV, "verify", user.id, 86_400);
    await sendVerification(c.env, user.email, user.name, `${new URL(c.req.url).origin}/verify/${token}`);
  }
  return c.html(
    page(
      "Check your email — Helix",
      `<h1>Sent</h1><p>If <strong>${esc(email)}</strong> is waiting on confirmation, a fresh link is on its way.</p>`,
    ),
  );
});

app.get("/forgot", (c) =>
  c.html(
    page(
      "Reset your passphrase — Helix",
      `<h1>Reset your passphrase</h1>
<p class="muted">We'll email you a link. Your vault and connected apps are untouched.</p>
<div class="card"><form method="POST" action="/forgot">
  <label>Email</label><input type="email" name="email" required>
  ${turnstileWidget(c.env)}
  <button type="submit">Send reset link</button>
</form></div>`,
    ),
  ),
);

app.post("/forgot", async (c) => {
  if (!(await rateLimit(c.env.VAULT_KV, "forgot", clientId(c.req.raw), 5, 3600))) {
    return c.html(
      page("Slow down — Helix", `<h1>Too many requests</h1><p class="muted">Try again in a little while.</p>`),
      429,
    );
  }
  const form = await c.req.formData();
  if (!(await verifyTurnstile(c.env, c.req.raw, form.get("cf-turnstile-response")?.toString() ?? ""))) {
    return c.html(
      page("Reset your passphrase — Helix", `<h1>Human check failed</h1><p class="muted"><a href="/forgot">Try again</a>.</p>`),
      400,
    );
  }
  const email = (form.get("email")?.toString() ?? "").trim().toLowerCase();
  const user = await getUserByEmail(c.env.VAULT_KV, email);
  // Same response either way — never reveal whether an address has a vault.
  if (user) {
    const token = await mintToken(c.env.VAULT_KV, "reset", user.id, 3_600);
    await sendReset(c.env, user.email, user.name, `${new URL(c.req.url).origin}/reset/${token}`);
  }
  return c.html(
    page(
      "Check your email — Helix",
      `<h1>Check your email</h1>
<p>If <strong>${esc(email)}</strong> has a Helix vault, a reset link is on its way. It works for one hour.</p>
<p class="muted">Self-hosting without email configured? Reset from the admin page instead.</p>`,
    ),
  );
});

const resetForm = (token: string, msg = "") => `
${msg ? `<p class="muted">${esc(msg)}</p>` : ""}
<div class="card"><form method="POST" action="/reset/${esc(token)}">
  <label>New passphrase <span class="muted">(at least ${MIN_PASSPHRASE} characters)</span></label>
  <input type="password" name="passphrase" required minlength="${MIN_PASSPHRASE}">
  <label>Confirm</label><input type="password" name="passphrase2" required minlength="${MIN_PASSPHRASE}">
  <button type="submit">Set new passphrase</button>
</form></div>`;

app.get("/reset/:token", async (c) => {
  const userId = await readToken(c.env.VAULT_KV, "reset", c.req.param("token"));
  if (!userId) {
    return c.html(
      page(
        "Link expired — Helix",
        `<h1>That link has expired</h1><p class="muted">Reset links last one hour. <a href="/forgot">Request another</a>.</p>`,
      ),
      404,
    );
  }
  return c.html(page("New passphrase — Helix", `<h1>Set a new passphrase</h1>${resetForm(c.req.param("token"))}`));
});

app.post("/reset/:token", async (c) => {
  const token = c.req.param("token");
  const userId = await readToken(c.env.VAULT_KV, "reset", token);
  const user = userId ? await getUser(c.env.VAULT_KV, userId) : null;
  if (!user) return c.redirect("/forgot");

  const form = await c.req.formData();
  const passphrase = form.get("passphrase")?.toString() ?? "";
  const passphrase2 = form.get("passphrase2")?.toString() ?? "";
  if (passphrase.length < MIN_PASSPHRASE || passphrase !== passphrase2) {
    return c.html(
      page(
        "New passphrase — Helix",
        `<h1>Set a new passphrase</h1>${resetForm(token, "Passphrases must match and be at least " + MIN_PASSPHRASE + " characters.")}`,
      ),
      400,
    );
  }

  // Re-binds the same userId, so the vault, subjects, voice and grants
  // all survive the reset untouched.
  await createUser(c.env.VAULT_KV, {
    id: user.id,
    email: user.email,
    name: user.name,
    passHash: await hashPassphrase(passphrase),
  });
  await c.env.VAULT_KV.delete(`reset:${token}`);
  c.header("Set-Cookie", await createSessionCookie(user.id, c.env.COOKIE_SECRET));
  return c.redirect("/vault");
});

app.post("/login", async (c) => {
  if (!(await rateLimit(c.env.VAULT_KV, "login", clientId(c.req.raw), 20, 900))) {
    return c.html(
      page("Sign in — Helix", `<h1>Helix</h1>${loginForm("Too many attempts. Try again in a few minutes.")}`),
      429,
    );
  }
  const form = await c.req.formData();
  const email = form.get("email")?.toString() ?? "";
  const passphrase = form.get("passphrase")?.toString() ?? "";
  const user = await getUserByEmail(c.env.VAULT_KV, email);
  if (!user || !(await verifyPassphrase(passphrase, user.passHash))) {
    return c.html(page("Sign in — Helix", `<h1>Helix</h1>${loginForm("Wrong email or passphrase.")}`), 401);
  }
  if (user.unverified) {
    return c.html(
      page(
        "Confirm your email — Helix",
        `<h1>One more step</h1>
<p>Confirm <strong>${esc(user.email)}</strong> to finish setting up your vault — check your inbox for the link.</p>
<div class="card"><form method="POST" action="/signup/resend">
  <input type="hidden" name="email" value="${esc(user.email)}">
  <button type="submit">Send it again</button>
</form></div>`,
      ),
      403,
    );
  }
  c.header("Set-Cookie", await createSessionCookie(user.id, c.env.COOKIE_SECRET));
  return c.redirect("/vault");
});

app.get("/logout", (c) => {
  c.header("Set-Cookie", CLEAR_SESSION_COOKIE);
  return c.redirect("/");
});

// ---------- invites ----------

app.get("/invite/:token", async (c) => {
  const invite = await getInvite(c.env.VAULT_KV, c.req.param("token"));
  if (!invite || invite.usedAt) {
    return c.html(page("Helix", `<h1>Invite not valid</h1><p class="muted">This invite is missing or already used.</p>`), 404);
  }
  return c.html(
    page(
      "Join Helix",
      `<h1>Welcome to Helix, ${esc(invite.name)}</h1>
<p>Set a passphrase for <strong>${esc(invite.email)}</strong>. You'll use it to sign in and to approve apps.</p>
<div class="card"><form method="POST" action="/invite/${esc(invite.token)}">
  <label>Choose a passphrase</label><input type="password" name="passphrase" minlength="8" required>
  <label>Repeat it</label><input type="password" name="passphrase2" minlength="8" required>
  <button type="submit">Create my vault</button>
</form></div>`,
    ),
  );
});

app.post("/invite/:token", async (c) => {
  const invite = await getInvite(c.env.VAULT_KV, c.req.param("token"));
  if (!invite || invite.usedAt) return c.redirect("/");
  const form = await c.req.formData();
  const p1 = form.get("passphrase")?.toString() ?? "";
  const p2 = form.get("passphrase2")?.toString() ?? "";
  if (p1.length < 8 || p1 !== p2) {
    return c.html(page("Helix", `<h1>Passphrases must match (min 8 chars)</h1><p><a href="/invite/${esc(invite.token)}">Try again</a></p>`), 400);
  }
  // createUser also (re)binds an existing userId — how an existing vault gets reattached on passphrase reset.
  const user = await createUser(c.env.VAULT_KV, {
    id: invite.userId,
    email: invite.email,
    name: invite.name,
    passHash: await hashPassphrase(p1),
  });
  await loadVault(c.env.VAULT_KV, user.id, { name: invite.name, email: invite.email });
  await markInviteUsed(c.env.VAULT_KV, invite);
  c.header("Set-Cookie", await createSessionCookie(user.id, c.env.COOKIE_SECRET));
  return c.redirect("/welcome");
});

// ---------- connect-your-AI instructions (shared by /welcome and /connections) ----------

/** Per-app connect instructions — every item a closed <details>. */
function connectApps(origin: string): string {
  return `<details><summary class="muted">Claude</summary>
<ol>
  <li>Open <a href="https://claude.ai/settings/connectors" target="_blank">claude.ai → Settings → Connectors</a></li>
  <li>Click <strong>Add custom connector</strong>, paste the address above, and add it</li>
  <li>Click <strong>Connect</strong> — a Helix page opens</li>
  <li>Sign in with your email and passphrase, then click <strong>Approve</strong></li>
</ol></details>
<details><summary class="muted">ChatGPT (Plus)</summary>
<ol>
  <li>ChatGPT → Settings → Apps → Advanced → turn on Developer mode</li>
  <li>Back in Apps, click <strong>Create</strong>: name it Helix, paste the address, choose OAuth</li>
  <li>Approve on the Helix page that opens</li>
</ol></details>
<details><summary class="muted">Cursor</summary>
<p>Settings → MCP → Add server, with URL <code>${esc(origin)}/mcp</code>, then click to sign in.</p></details>
<details><summary class="muted">Gemini app (Mac desktop)</summary>
<p>The Gemini desktop app for macOS supports custom MCP connections as of July 2026 — currently for <strong>AI Ultra</strong> subscribers (US beta):</p>
<ol>
  <li>In the Gemini app, open the Spark / integrations settings and look for <strong>MCP</strong> or custom connections</li>
  <li>Add a server with the address <code>${esc(origin)}/mcp</code></li>
  <li>Sign in and approve on the Helix page that opens</li>
</ol>
<p class="muted">Not on Ultra? Use the free Gemini CLI below — same models. The Gemini web app doesn't support custom connections yet.</p></details>
<details><summary class="muted">Antigravity CLI (Google, free)</summary>
<p>Google retired the Gemini CLI for individuals in June 2026 — its replacement is Antigravity CLI:</p>
<ol>
  <li>Install: <code>brew install --cask antigravity-cli</code> (or the installer at antigravity.google), then run <code>agy</code> and sign in with Google</li>
  <li>Create <code>~/.gemini/antigravity-cli/mcp_config.json</code> with:</li>
</ol>
<pre>{
  "mcpServers": {
    "helix": { "serverUrl": "${esc(origin)}/mcp" }
  }
}</pre>
<p class="muted">Note it's <code>serverUrl</code> — the old <code>url</code> field fails silently.</p>
<ol start="3">
  <li>Restart <code>agy</code>, run <code>/mcp</code>, and authenticate helix — approve on the Helix page that opens</li>
</ol></details>
<details><summary class="muted">Claude Code (terminal)</summary>
<p>Run:</p>
<pre>claude mcp add --transport http helix ${esc(origin)}/mcp</pre>
<p>Then inside Claude Code run <code>/mcp</code> and authenticate — your Helix sign-in page opens in the browser.</p></details>
<details><summary class="muted">VS Code (Copilot)</summary>
<p>Note: the "Browse MCP Servers" gallery in the Extensions view only shows curated servers — adding your own is via the Command Palette (⇧⌘P):</p>
<ol>
  <li>Run <strong>MCP: Add Server</strong> → choose <strong>HTTP</strong> → paste <code>${esc(origin)}/mcp</code> → name it Helix → save to Global</li>
  <li>VS Code opens your Helix sign-in page — approve, done</li>
</ol>
<p>If you don't see that command, run <strong>MCP: Open User Configuration</strong> instead and add:</p>
<pre>{
  "servers": {
    "helix": { "type": "http", "url": "${esc(origin)}/mcp" }
  }
}</pre></details>
<details><summary class="muted">Any other MCP app</summary>
<p>Helix speaks the open MCP standard, so it works with anything that does: Windsurf, Zed, JetBrains, Le Chat, LM Studio, Raycast, Goose, and more every month. Wherever the app asks for an MCP server, paste:</p>
<p><code>${esc(origin)}/mcp</code></p>
<p>If an app only supports local servers, bridge it with:</p>
<pre>npx mcp-remote ${esc(origin)}/mcp</pre></details>`;
}

// ---------- welcome / guided onboarding ----------

const WELCOME_QS: { q: string; name: string; cat: Category; ph: string }[] = [
  { q: "What do you do?", name: "w_work", cat: "work", ph: "e.g. High school teacher; run a small design studio" },
  { q: "What are you working on these days?", name: "w_projects", cat: "projects", ph: "e.g. Planning a big trip; renovating the kitchen" },
  { q: "Family or people who matter (only what you're comfortable sharing)", name: "w_rel", cat: "relationships", ph: "e.g. Married to Sam; two kids; a dog named Otis" },
  { q: "How do you like your AI to talk to you?", name: "w_style", cat: "communication-style", ph: "e.g. Short answers, plain language, no bullet points" },
];

app.get("/welcome", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const origin = new URL(c.req.url).origin;
  const saved = c.req.query("saved") === "1";

  const step1 = saved
    ? `<div class="card"><h2 style="margin-top:0">1 · About you — saved ✓</h2>
<p class="muted">You can add or change anything later in <a href="/vault">your vault</a>.</p></div>`
    : `<div class="card"><h2 style="margin-top:0">1 · Tell Helix about you</h2>
<p class="muted">A sentence or two each. Skip anything you like — this is your vault, only shared with apps you approve.</p>
<form method="POST" action="/welcome/save">
${WELCOME_QS.map((f) => `<label>${esc(f.q)}</label><input type="text" name="${f.name}" placeholder="${esc(f.ph)}">`).join("")}
<button type="submit">Save</button>
</form></div>`;

  return c.html(
    page(
      "Welcome — Helix",
      `${await navFor(c, user)}<h1>Welcome, ${esc(user.name.split(" ")[0])} 👋</h1>
<p>Helix is your personal memory for AI apps. You fill it in once; every AI you approve can use it — and nothing gets added without your say-so.</p>

${step1}

<div class="card"><h2 style="margin-top:0">2 · Connect your AI</h2>
<p>Your personal Helix address:</p>
<p><code>${esc(origin)}/mcp</code></p>
<p class="muted">Paste that wherever an app asks for an MCP server. Step-by-step for Claude, ChatGPT, Cursor, Gemini, VS Code and others below — anything that speaks MCP works, so connect as many as you like. They all read the same vault.</p>
${connectApps(origin)}
</div>

<div class="card"><h2 style="margin-top:0">3 · Try it</h2>
<p>Ask your AI: <em>"What do you know about me?"</em> — it should answer from your vault.</p>
<p>When an AI learns something new about you, it's <strong>not saved automatically</strong>. It waits for you in your <a href="/review">review queue</a> — approve it or reject it. That page also shows exactly which app read what, and when.</p>
</div>`,
    ),
  );
});

app.post("/welcome/save", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const form = await c.req.formData();
  const vault = await loadVault(c.env.VAULT_KV, user.id, { name: user.name, email: user.email });
  for (const f of WELCOME_QS) {
    const val = form.get(f.name)?.toString().trim();
    if (val) vault[f.cat].base.push(val);
  }
  await saveVault(c.env.VAULT_KV, user.id, vault);
  return c.redirect("/welcome?saved=1");
});

// ---------- admin ----------

const inviteForm = `
<div class="card"><form method="POST" action="/admin">
  <h3 style="margin-top:0">New invite</h3>
  <label>Name</label><input type="text" name="name" required>
  <label>Email</label><input type="email" name="email" required>
  <label>User id (optional — defaults to email prefix)</label><input type="text" name="userId" placeholder="e.g. james">
  <button type="submit">Create invite</button>
</form></div>`;

const unlockForm = `
<div class="card"><form method="POST" action="/admin/unlock">
  <label>Admin secret</label><input type="password" name="secret" required>
  <button type="submit">Unlock</button>
</form></div>`;

async function adminPage(c: Ctx, notice = ""): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const [users, invites] = await Promise.all([
    listUsers(c.env.VAULT_KV),
    listPendingInvites(c.env.VAULT_KV),
  ]);
  // Counts and timestamps only — see activity.ts. Sorted so the people who
  // need attention are at the top rather than buried in signup order.
  const activity = new Map(
    await Promise.all(
      users.map(async (u) => [u.id, await userActivity(c.env, u.id)] as const),
    ),
  );
  const rank = { stuck: 0, cold: 1, warm: 2 } as const;
  const sorted = [...users].sort((a, b) => {
    const sa = activitySummary(activity.get(a.id)!).state;
    const sb = activitySummary(activity.get(b.id)!).state;
    return rank[sa] - rank[sb] || a.createdAt.localeCompare(b.createdAt);
  });
  const invitesHtml =
    invites.length === 0
      ? ""
      : `<h2>Pending invites (${invites.length})</h2>
${invites
  .map(
    (i) => `<div class="card">
  <p><strong>${esc(i.name)}</strong> · ${esc(i.email)} · <code>${esc(i.userId)}</code> · sent ${esc(i.createdAt.slice(0, 10))} · not yet accepted</p>
  <p><code>${esc(origin)}/invite/${esc(i.token)}</code></p>
  <form method="POST" action="/admin/cancel-invite" onsubmit="return confirm('Cancel this invite? The link will stop working.')">
    <input type="hidden" name="token" value="${esc(i.token)}">
    <button class="small ghost">Cancel invite</button>
  </form>
</div>`,
  )
  .join("")}`;
  return c.html(
    page(
      "Admin — Helix",
      `<h1>Helix admin</h1>
${notice}
${inviteForm}
${invitesHtml}
<h2>Backups</h2>
<div class="card"><form method="POST" action="/admin/backup">
  <p class="muted">Vaults are backed up to R2 nightly. Run one now to verify the pipeline.</p>
  <button class="small ghost">Back up now</button>
</form></div>
<h2>Users (${users.length})</h2>
<p class="muted">Counts and timestamps only — never vault contents. Users needing attention are listed first.</p>
${
  sorted
    .map((u) => {
      const a = activity.get(u.id)!;
      const s = activitySummary(a);
      return `<div class="card">
  <p><strong>${esc(u.name)}</strong> · ${esc(u.email)} · <code>${esc(u.id)}</code> · joined ${esc(u.createdAt.slice(0, 10))}</p>
  <p class="state state--${s.state}">${esc(s.text)}</p>
  <p class="muted">${a.pending} pending${a.oldestPendingDays !== null ? ` (oldest ${a.oldestPendingDays}d)` : ""} · ${a.events} events · ${
    a.lastRead ? `last read ${esc(a.lastRead.at.slice(0, 10))} by ${esc(a.lastRead.client)}` : "never read"
  } · ${a.lastCurated ? `last curated ${esc(a.lastCurated.slice(0, 10))}` : "never curated"}</p>
  <p class="muted">${a.labelled} labelled · ${a.private} private · ${a.devices} device${a.devices === 1 ? "" : "s"} · images ${a.images.used}/${a.images.limit < 0 ? "∞" : a.images.limit} · speech ${a.speech.used}/${a.speech.limit < 0 ? "∞" : a.speech.limit}</p>
  <div class="row">
    <form method="POST" action="/admin/reset"><input type="hidden" name="userId" value="${esc(u.id)}"><button class="small ghost">New invite link (reset passphrase)</button></form>
    <form method="POST" action="/admin/delete" onsubmit="return confirm('Delete ${esc(u.name)} and ALL their data?')"><input type="hidden" name="userId" value="${esc(u.id)}"><button class="small ghost">Delete user + data</button></form>
  </div>
</div>`;
    })
    .join("") || `<p class="muted">None yet.</p>`
}`,
    ),
  );
}

app.post("/admin/cancel-invite", async (c) => {
  if (!(await isAdmin(c))) return c.redirect("/admin");
  const token = (await c.req.formData()).get("token")?.toString() ?? "";
  if (token) await deleteInvite(c.env.VAULT_KV, token);
  return adminPage(c, `<div class="card"><p>Invite cancelled.</p></div>`);
});

async function isAdmin(c: Ctx): Promise<boolean> {
  return verifyAdminCookie(c.req.header("Cookie"), c.env.COOKIE_SECRET);
}

app.get("/admin", async (c) => {
  if (!(await isAdmin(c))) return c.html(page("Admin — Helix", `<h1>Helix admin</h1>${unlockForm}`));
  return adminPage(c);
});

app.post("/admin/unlock", async (c) => {
  const form = await c.req.formData();
  if (form.get("secret")?.toString() !== c.env.ADMIN_SECRET) {
    return c.html(page("Admin — Helix", `<h1>Wrong admin secret</h1>`), 401);
  }
  c.header("Set-Cookie", await createAdminCookie(c.env.COOKIE_SECRET));
  return c.redirect("/admin");
});

app.post("/admin", async (c) => {
  if (!(await isAdmin(c))) return c.redirect("/admin");
  const form = await c.req.formData();
  const invite = await createInvite(c.env.VAULT_KV, {
    email: form.get("email")?.toString() ?? "",
    name: form.get("name")?.toString() ?? "",
    userId: form.get("userId")?.toString() || undefined,
  });
  const origin = new URL(c.req.url).origin;
  return adminPage(
    c,
    `<div class="card"><p>Invite for <strong>${esc(invite.name)}</strong> (user id <code>${esc(invite.userId)}</code>):</p>
<p><code id="invite">${esc(origin)}/invite/${esc(invite.token)}</code></p>
<p class="muted">Send them this link. It works once.</p></div>`,
  );
});

app.post("/admin/backup", async (c) => {
  if (!(await isAdmin(c))) return c.redirect("/admin");
  const result = await runBackup(c.env);
  return adminPage(
    c,
    result.ok
      ? `<div class="card"><p>Backup written: <code>${esc(result.key ?? "")}</code></p><p class="muted">${result.keys} keys · ${Math.round((result.bytes ?? 0) / 1024)} KB. Backups older than 30 days are pruned automatically.</p></div>`
      : `<div class="card"><p class="muted">Backup failed: ${esc(result.error ?? "unknown")}</p></div>`,
  );
});

app.post("/admin/reset", async (c) => {
  if (!(await isAdmin(c))) return c.redirect("/admin");
  const userId = (await c.req.formData()).get("userId")?.toString() ?? "";
  const user = await getUser(c.env.VAULT_KV, userId);
  if (!user) return adminPage(c, `<p class="muted">User not found.</p>`);
  const invite = await createInvite(c.env.VAULT_KV, { email: user.email, name: user.name, userId: user.id });
  const origin = new URL(c.req.url).origin;
  return adminPage(
    c,
    `<div class="card"><p>Reset link for <strong>${esc(user.name)}</strong> (vault and data kept):</p>
<p><code id="invite">${esc(origin)}/invite/${esc(invite.token)}</code></p></div>`,
  );
});

app.post("/admin/delete", async (c) => {
  if (!(await isAdmin(c))) return c.redirect("/admin");
  const userId = (await c.req.formData()).get("userId")?.toString() ?? "";
  const user = await getUser(c.env.VAULT_KV, userId);
  if (!user) return adminPage(c, `<p class="muted">User not found.</p>`);
  // Revoke all app grants first, then delete the user's data.
  const { items: grants } = await c.env.OAUTH_PROVIDER.listUserGrants(user.id);
  for (const g of grants) await c.env.OAUTH_PROVIDER.revokeGrant(g.id, user.id);
  await deleteUser(c.env.VAULT_KV, user);
  return adminPage(c, `<div class="card"><p>Deleted <strong>${esc(user.name)}</strong> and all their data (${grants.length} app grant(s) revoked).</p></div>`);
});

// ---------- OAuth authorize ----------

app.get("/authorize", async (c) => {
  const oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  const clientName = client?.clientName || oauthReq.clientId || "Unknown app";
  const encoded = btoa(JSON.stringify(oauthReq));
  const user = await sessionUser(c);

  // Scope hints: honour what the app actually asked for. Requested scopes
  // are shown first and pre-checked; everything else is tucked away,
  // unchecked. Apps that ask for nothing get the old defaults.
  const raw = (oauthReq as { scope?: string[] | string }).scope;
  const requested = new Set(
    (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s+]+/) : [])
      .map((s) => s.trim())
      .filter((s) => s && s in SCOPE_META),
  );
  const asked = requested.size > 0;

  const box = (scope: string, checked: boolean) => {
    const meta = SCOPE_META[scope];
    return `<label class="scope"><input type="checkbox" name="scopes" value="${esc(scope)}"${checked ? " checked" : ""}> <strong>${esc(meta.label)}</strong> <span class="muted">${meta.desc}</span></label>`;
  };

  const ordered = Object.keys(SCOPE_META);
  const scopeBoxes = asked
    ? `<h2>${esc(clientName)} is asking for</h2>
${ordered.filter((s) => requested.has(s)).map((s) => box(s, true)).join("")}
<details style="margin-top:14px"><summary class="muted">Give it more than it asked for</summary>
<p class="muted">Only if you have a reason — apps work best with the least access that does the job.</p>
${ordered.filter((s) => !requested.has(s)).map((s) => box(s, false)).join("")}
</details>`
    : `<h2>Grant access to</h2>
<p class="muted">This app didn't say what it needs, so nothing about likeness is pre-selected.</p>
${ordered.map((s) => box(s, DEFAULT_SCOPES.has(s))).join("")}`;

  // Label narrowing. Only offered when we already know who's signing in —
  // before that we can't know which labels exist. An unrestricted grant is
  // the default, so saying nothing here changes nothing.
  let labelBlock = "";
  if (user) {
    const [vault, labelDoc] = await Promise.all([
      loadVault(c.env.VAULT_KV, user.id, { name: user.name, email: user.email }),
      loadLabels(c.env.VAULT_KV, user.id),
    ]);
    const index = labelIndex(vault, labelDoc, [...CATEGORIES]);
    if (index.length) {
      labelBlock = `<details style="margin-top:14px"><summary class="muted">Limit this app to certain labels</summary>
<p class="muted">Pick one or more and this app sees <em>only</em> entries carrying them — inside the categories above, never beyond. Anything you haven't labelled becomes invisible to it, which is usually the point.</p>
${index
  .map(
    (l) =>
      `<label class="scope"><input type="checkbox" name="labels" value="${esc(l.label)}"> <strong>${esc(l.label)}</strong> <span class="muted">${l.count} ${l.count === 1 ? "entry" : "entries"}</span></label>`,
  )
  .join("")}
</details>`;
    }
  }

  const identityBlock = user
    ? `<p class="muted">Signed in as ${esc(user.name)} (${esc(user.email)})</p>
       <label>Confirm passphrase</label><input type="password" name="passphrase" required>`
    : `<h2>Sign in</h2>
       <label>Email</label><input type="email" name="email" required>
       <label>Passphrase</label><input type="password" name="passphrase" required>`;

  return c.html(
    page(
      "Authorize — Helix",
      `<h1>Helix</h1>
<div class="card">
  <p><strong>${esc(clientName)}</strong> wants access to your context vault.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="oauthreq" value="${encoded}">
    <input type="hidden" name="client_name" value="${esc(clientName)}">
    ${user ? `<input type="hidden" name="email" value="${esc(user.email)}">` : ""}
    ${scopeBoxes}
    ${labelBlock}
    ${identityBlock}
    <div class="row">
      <button type="submit">Approve</button>
      <span class="muted">You can revoke access anytime.</span>
    </div>
  </form>
</div>`,
    ),
  );
});

app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const email = form.get("email")?.toString() ?? "";
  const passphrase = form.get("passphrase")?.toString() ?? "";
  const user = await getUserByEmail(c.env.VAULT_KV, email);
  if (!user || !(await verifyPassphrase(passphrase, user.passHash))) {
    return c.html(page("Helix", `<h1>Wrong email or passphrase</h1><p><a href="javascript:history.back()">Try again</a></p>`), 401);
  }
  const oauthReq = JSON.parse(atob(form.get("oauthreq")?.toString() ?? "")) as AuthRequest;
  const clientName = form.get("client_name")?.toString() ?? "Unknown app";
  const scopes = form.getAll("scopes").map((s) => s.toString());
  const labels = [
    ...new Set(
      form
        .getAll("labels")
        .map((s) => normalizeLabel(s.toString()))
        .filter((l): l is string => !!l),
    ),
  ];

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: user.id,
    // Mirrored into metadata as well as props: props ride with the token,
    // metadata is what /connections can read back to show the owner what
    // they actually agreed to.
    metadata: { label: `${clientName} → ${user.email}`, labels },
    scope: scopes,
    props: { userId: user.id, email: user.email, clientName, scopes, labels },
  });

  return Response.redirect(redirectTo, 302);
});

// ---------- connections (grants + revocation) ----------

app.get("/connections", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const [{ items: grants }, audit] = await Promise.all([
    c.env.OAUTH_PROVIDER.listUserGrants(user.id),
    readAudit(c.env.VAULT_KV, user.id),
  ]);

  const cards =
    grants.length === 0
      ? `<p class="muted">No apps connected yet. See the <a href="/welcome">guide</a> to connect one.</p>`
      : grants
          .map((g) => {
            const meta = g.metadata as { label?: string; labels?: string[] } | undefined;
            const label = meta?.label ?? g.clientId;
            const appName = label.split(" → ")[0];
            const grantLabels = meta?.labels ?? [];
            const lastRead = audit.find((a) => a.client === appName && a.action === "read");
            return `<div class="card">
  <p><strong>${esc(appName)}</strong></p>
  <p class="muted">can read: ${(g.scope ?? []).filter((s: string) => s !== "propose").map(esc).join(", ") || "nothing"}${(g.scope ?? []).includes("propose") ? " · can propose learnings" : ""}</p>
  ${grantLabels.length ? `<p class="muted">limited to ${grantLabels.map((l) => `<span class="chip">${esc(l)}</span>`).join("")} — nothing else in those categories reaches it</p>` : ""}
  <p class="muted">${lastRead ? `last read ${esc(lastRead.at.slice(0, 16).replace("T", " "))} (${esc(lastRead.detail)})` : "no reads recorded yet"}</p>
  <form method="POST" action="/connections/revoke">
    <input type="hidden" name="grantId" value="${esc(g.id)}">
    <button class="small ghost">Revoke access</button>
  </form>
</div>`;
          })
          .join("");

  return c.html(
    page(
      "Connections — Helix",
      `${await navFor(c, user)}<h1>Connected apps</h1>
<p class="muted">Every app that can currently read your vault. Revoking cuts it off immediately — it would have to ask for your approval again.</p>
${cards}
${await (async () => {
  const devices = await listDevices(c.env.VAULT_KV, user.id);
  if (devices.length === 0) return "";
  return `<h2>Your devices</h2>
<p class="muted">Owner devices signed in with your passphrase — they can approve and reject learnings${devices.some((d) => d.hasPush) ? ", and get push notifications" : ""}.</p>
${devices
  .map(
    (d) => `<div class="card row">
  <div style="flex:1"><strong>${esc(d.deviceName)}</strong><div class="muted">since ${esc(d.createdAt.slice(0, 10))}${d.hasPush ? " · push enabled" : ""}</div></div>
  <form method="POST" action="/connections/devices/revoke">
    <input type="hidden" name="tokenHash" value="${esc(d.tokenHash)}">
    <button class="small ghost">Revoke</button>
  </form>
</div>`,
  )
  .join("")}`;
})()}
<h2>Connect another AI</h2>
<p class="muted">Your Helix address: <code>${esc(new URL(c.req.url).origin)}/mcp</code> — pick your app:</p>
${connectApps(new URL(c.req.url).origin)}`,
    ),
  );
});

app.post("/connections/revoke", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const grantId = (await c.req.formData()).get("grantId")?.toString() ?? "";
  if (grantId) await c.env.OAUTH_PROVIDER.revokeGrant(grantId, user.id);
  return c.redirect("/connections");
});

// ---------- review queue ----------

app.get("/review", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");

  const [pending, vault] = await Promise.all([
    listPending(c.env.VAULT_KV, user.id),
    loadVault(c.env.VAULT_KV, user.id, { name: user.name, email: user.email }),
  ]);

  /** Existing entries in the same category, offered as supersession targets.
   * A fact proposed and approved inside one conversation never gets an id the
   * AI can see, so the AI can't ask to replace it — the owner has to be able
   * to say so here instead. */
  const replaceOptions = (cat: Category, already?: string) => {
    const s = vault[cat];
    const opts = [
      ...s.base.map((t) => ({ id: entryIdOf(cat, "base", t), text: t })),
      ...s.learned.map((l) => ({ id: entryIdOf(cat, "learned", l.fact), text: l.fact })),
    ];
    if (!opts.length || already) return "";
    return `<details class="replacer"><summary class="muted">Replace an existing entry with this?</summary>
  <p class="muted">Use this when the new fact corrects an old one — the old entry is removed on approval, and keeps its labels.</p>
  <select name="replaces">
    <option value="">Add it as a new entry</option>
    ${opts.map((o) => `<option value="${esc(o.id)}">${esc(o.text.length > 90 ? o.text.slice(0, 90) + "…" : o.text)}</option>`).join("")}
  </select></details>`;
  };

  const pendingHtml =
    pending.length === 0
      ? `<p class="muted">Nothing pending.</p>`
      : pending
          .map(
            (p) => `<div class="card">
  ${
    p.kind === "labels"
      ? `<p><strong>Tag an entry</strong> — ${(p.labels ?? []).map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</p>
  <p class="muted">on: “${esc(p.targetText ?? "")}”</p>
  <p class="muted">Labels don't change what an entry says — they let you give one app this slice and nothing else.</p>`
      : `<p><strong>${esc(CATEGORY_META[p.category]?.label ?? p.category)}</strong> — ${esc(p.fact)}${(p.labels ?? []).map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</p>`
  }
  ${p.replacesText ? `<p class="muted">replaces: <s>${esc(p.replacesText)}</s></p>` : ""}
  <p class="muted">proposed by ${esc(p.client)} · ${esc(p.proposedAt.slice(0, 16).replace("T", " "))}</p>
  <form method="POST" action="/review/decide" onsubmit="this.dataset.sent ? event.preventDefault() : (this.dataset.sent = 1, setTimeout(() => this.querySelectorAll('button').forEach((b) => (b.disabled = true)), 0));">
    <input type="hidden" name="id" value="${p.id}">
    ${p.kind === "labels" ? "" : replaceOptions(p.category, p.replaces)}
    <div class="row">
      <button name="action" value="approve">Approve</button>
      <button name="action" value="reject" class="ghost">Reject</button>
    </div>
  </form>
</div>`,
          )
          .join("");

  return c.html(
    page(
      "Review — Helix",
      `${nav(user, pending.length)}<h1>Review queue</h1>
<p class="muted">Facts apps want to remember about you. Nothing enters your vault without your approval. Curious who's been reading? See the <a href="/audit">audit log</a>.</p>
${pendingHtml}`,
    ),
  );
});

app.get("/audit", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const audit = await readAudit(c.env.VAULT_KV, user.id);
  const chain = await verifyAuditChain(audit);

  const auditHtml =
    audit.length === 0
      ? `<p class="muted">No activity yet.</p>`
      : audit
          .slice(0, 100)
          .map(
            (a) =>
              `<p class="muted">${esc(a.at.slice(0, 16).replace("T", " "))} · <strong>${esc(a.client)}</strong> ${a.action === "read" ? "read" : a.action === "generate" ? "generated" : a.action === "write" ? "" : "proposed"} ${esc(a.detail)}${a.hash ? ` <span class="chip" title="${esc(a.hash)}">#${esc(a.hash.slice(0, 8))}</span>` : ""}</p>`,
          )
          .join("");

  // Say exactly what the chain proves. Overclaiming here would be the worst
  // possible place to do it.
  const chainBanner = !chain.checked
    ? ""
    : chain.ok
      ? `<div class="banner"><strong>Chain intact.</strong> ${chain.checked} ${chain.checked === 1 ? "entry links" : "entries link"} to the one before it, so none of them has been edited or reordered since it was written. It does not prove nothing was ever deleted wholesale — see the <a href="/security">security note</a>.</div>`
      : `<div class="banner"><strong>Chain broken at entry ${chain.brokenAt}</strong> — ${esc(chain.reason ?? "verification failed")}. Entries after that point can't be trusted. Please get in touch.</div>`;

  return c.html(
    page(
      "Audit — Helix",
      `${await navFor(c, user)}<h1>Audit log</h1>
<p class="muted">Every read, proposal, write, and generation by every connected app — who did what, and when.</p>
${chainBanner}
${auditHtml}`,
    ),
  );
});

app.post("/review/decide", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const form = await c.req.formData();
  const id = form.get("id")?.toString() ?? "";
  const action = form.get("action")?.toString() === "approve" ? "approve" : "reject";
  // The owner can supersede an entry the app didn't know to replace — which
  // is the common case, because a fact proposed and approved in the same
  // conversation never gets an id the AI can see.
  const replaces = form.get("replaces")?.toString();
  if (action === "approve" && replaces) {
    const queued = await listPending(c.env.VAULT_KV, user.id);
    const item = queued.find((p) => p.id === id);
    const vault = await loadVault(c.env.VAULT_KV, user.id);
    if (item && findEntry(vault, replaces)) {
      item.replaces = replaces;
      await c.env.VAULT_KV.put(`pending:${user.id}`, JSON.stringify(queued));
    }
  }
  const decided = await decidePending(c.env.VAULT_KV, user.id, id, action);
  // The owner's own decisions belong in the log too. Without this, the audit
  // trail records what apps asked for but not what was allowed — and the
  // security page's promise that every write is logged isn't true.
  const verb = action === "approve" ? "approved" : "rejected";
  if (decided) {
    await appendAudit(c.env.VAULT_KV, user.id, {
      client: "You (web)",
      action: "write",
      detail:
        decided.kind === "labels"
          ? `${verb} labels ${(decided.labels ?? []).join(", ")} proposed by ${decided.client}`
          : `${verb} "${decided.fact.slice(0, 80)}" proposed by ${decided.client}`,
    });
  }
  return c.redirect("/review");
});

// ---------- vault editor ----------

/** One vault entry: plain text by default, form controls revealed by Edit. */
function factRow(
  cat: Category,
  list: "base" | "learned",
  index: number,
  text: string,
  source: string,
  marks: { id: string; labels: string[]; isPrivate: boolean } = { id: "", labels: [], isPrivate: false },
): string {
  const chips =
    marks.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join("") +
    (marks.isPrivate ? `<span class="chip chip-private">private</span>` : "");
  return `<div class="fact">
  <div class="reader fact-text">
    <div>${esc(text)}${chips ? ` ${chips}` : ""}</div>
    <div class="fact-src">${esc(source)}</div>
  </div>
  <form class="editor" method="POST" action="/vault/update">
    <input type="hidden" name="category" value="${cat}"><input type="hidden" name="list" value="${list}"><input type="hidden" name="index" value="${index}">
    <input type="text" name="text" value="${esc(text)}">
    <label class="labelrow">Labels <input type="text" name="labels" value="${esc(marks.labels.join(", "))}" placeholder="helix, family" class="small-input"></label>
    <label class="labelrow"><input type="checkbox" name="private" value="1"${marks.isPrivate ? " checked" : ""}> Private — never leaves the vault, whatever an app was granted</label>
    <button name="action" value="save" class="small">Save</button>
    <button name="action" value="delete" class="small danger" onclick="return confirm('Delete this entry? Apps will no longer see it.')">Delete</button>
    <button type="button" class="linkbtn" onclick="this.closest('.fact').classList.remove('editing')">Cancel</button>
  </form>
  <button type="button" class="linkbtn reader" onclick="this.closest('.fact').classList.add('editing')">Edit</button>
</div>`;
}

app.get("/vault", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const [vault, pending, labelDoc] = await Promise.all([
    loadVault(c.env.VAULT_KV, user.id, { name: user.name, email: user.email }),
    listPending(c.env.VAULT_KV, user.id),
    loadLabels(c.env.VAULT_KV, user.id),
  ]);
  const marksFor = (cat: Category, list: "base" | "learned", text: string) => {
    const id = entryIdOf(cat, list, text);
    return { id, labels: labelDoc.labels[id] ?? [], isPrivate: labelDoc.private.includes(id) };
  };

  const banner =
    pending.length > 0
      ? `<div class="banner">${pending.length} new ${pending.length === 1 ? "memory is" : "memories are"} waiting for your approval. <a href="/review">Review now →</a></div>`
      : "";

  // Gaps nudge: sections that are empty or haven't gained a fact in a long
  // while. The queue catches bad proposals; nothing catches missing ones.
  const now = Date.now();
  const stale = CATEGORIES.map((cat) => {
    const s = vault[cat];
    const newest = s.learned.reduce<string>((max, l) => (l.date > max ? l.date : max), "");
    const days = newest ? Math.floor((now - Date.parse(newest)) / 86_400_000) : Infinity;
    return { cat, empty: s.base.length + s.learned.length === 0, days };
  }).filter((x) => x.empty || x.days > 60);

  const gaps =
    stale.length === 0
      ? ""
      : `<div class="banner"><strong>Worth a look.</strong> ${stale
          .map((x) =>
            x.empty
              ? `<em>${esc(CATEGORY_META[x.cat].label)}</em> is empty`
              : `<em>${esc(CATEGORY_META[x.cat].label)}</em> hasn't changed in ${x.days === Infinity ? "a while" : `${x.days} days`}`,
          )
          .join("; ")}. Your AI apps only know what's here — if life moved on, add it.</div>`;

  const sections = CATEGORIES.map((cat) => {
    const meta = CATEGORY_META[cat];
    const s = vault[cat];
    const rows =
      s.base.map((f, i) => factRow(cat, "base", i, f, "you", marksFor(cat, "base", f))).join("") +
      s.learned
        .map((l, i) =>
          factRow(cat, "learned", i, l.fact, `added by ${l.source} · ${l.date}`, marksFor(cat, "learned", l.fact)),
        )
        .join("");
    return `<h2>${esc(meta.label)}</h2><p class="hint">${esc(meta.hint)}</p>
${rows || `<p class="muted">Nothing here yet.</p>`}
<form method="POST" action="/vault/add" class="addrow">
  <input type="hidden" name="category" value="${cat}">
  <input type="text" name="text" placeholder="${esc(meta.ph)}" required>
  <button class="small">Add</button>
</form>`;
  }).join("");

  return c.html(
    page(
      "Vault — Helix",
      `${nav(user, pending.length)}<h1>Your vault</h1>
<p class="muted">Everything an approved app can know about you, on one page. Apps only see the sections you granted them. <a href="/vault/preview">Preview what an app sees →</a></p>
${banner}${gaps}${sections}`,
    ),
  );
});

app.get("/vault/preview", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const vault = await loadVault(c.env.VAULT_KV, user.id, { name: user.name, email: user.email });
  const text = renderContext(vault, [...CATEGORIES], { ids: true });
  return c.html(
    page(
      "Preview — Helix",
      `${await navFor(c, user)}<h1>What an app sees</h1>
<p class="muted">This is the exact text an app with access to <em>all</em> sections receives when it reads your vault. Apps you granted fewer sections see less. The <code>[#id]</code> tags let apps propose an update to a specific entry — when you approve one, the old entry is swapped out.</p>
<pre>${esc(text)}</pre>
<p><a href="/vault">← Back to your vault</a></p>`,
    ),
  );
});

app.post("/vault/add", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const form = await c.req.formData();
  const category = form.get("category")?.toString() as Category;
  const text = form.get("text")?.toString().trim() ?? "";
  if (CATEGORIES.includes(category) && text) {
    const vault = await loadVault(c.env.VAULT_KV, user.id);
    vault[category].base.push(text);
    await saveVault(c.env.VAULT_KV, user.id, vault);
    await appendAudit(c.env.VAULT_KV, user.id, {
      client: "You (web)",
      action: "write",
      detail: `added to ${category}: "${text.slice(0, 80)}"`,
    });
  }
  return c.redirect("/vault");
});

app.post("/vault/update", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const form = await c.req.formData();
  const category = form.get("category")?.toString() as Category;
  const list = form.get("list")?.toString() === "learned" ? "learned" : "base";
  const index = parseInt(form.get("index")?.toString() ?? "-1", 10);
  const action = form.get("action")?.toString();
  const text = form.get("text")?.toString().trim() ?? "";
  const labels = (form.get("labels")?.toString() ?? "").split(",").filter((s) => s.trim());
  const wantsPrivate = form.get("private") === "1";
  if (CATEGORIES.includes(category) && index >= 0) {
    const vault = await loadVault(c.env.VAULT_KV, user.id);
    const current =
      list === "base" ? vault[category].base[index] : vault[category].learned[index]?.fact;
    const oldId = current !== undefined ? entryIdOf(category, list, current) : "";
    if (list === "base") {
      if (index < vault[category].base.length) {
        if (action === "delete") vault[category].base.splice(index, 1);
        else if (text) vault[category].base[index] = text;
      }
    } else {
      if (index < vault[category].learned.length) {
        if (action === "delete") vault[category].learned.splice(index, 1);
        else if (text) vault[category].learned[index].fact = text;
      }
    }
    await saveVault(c.env.VAULT_KV, user.id, vault);

    if (oldId) {
      await appendAudit(c.env.VAULT_KV, user.id, {
        client: "You (web)",
        action: "write",
        // No text on a delete: this log is append-only and hash-chained, so
        // repeating a deleted entry here would mean deletion didn't delete.
        detail:
          action === "delete"
            ? `deleted a ${category} entry`
            : `edited a ${category} entry: "${text.slice(0, 80)}"`,
      });
      if (action === "delete") {
        await pruneLabels(c.env.VAULT_KV, user.id, vault);
      } else if (text) {
        // Editing the text mints a new content-hash id. Carry the marks
        // across first — otherwise fixing a typo would silently un-private
        // the entry — then apply whatever the form just set.
        const newId = entryIdOf(category, list, text);
        await relabelEntry(c.env.VAULT_KV, user.id, oldId, newId);
        await setLabels(c.env.VAULT_KV, user.id, newId, labels);
        await setPrivate(c.env.VAULT_KV, user.id, newId, wantsPrivate);
      }
    }
  }
  return c.redirect("/vault");
});

// ---------- likeness subjects ----------

app.get("/subjects", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const refs = await listSubjects(c.env.VAULT_KV, user.id);
  const cards = (
    await Promise.all(
      refs.map(async (r) => {
        const s = await getSubject(c.env.VAULT_KV, user.id, r.id);
        return `<div class="card row">
  ${s?.thumb ? `<img src="${s.thumb}" alt="" style="width:56px;height:56px;border-radius:10px;object-fit:cover">` : ""}
  <div style="flex:1"><a href="/subjects/${r.id}"><strong>${esc(r.name)}</strong></a><div class="muted">${esc(r.species)} · ${r.photoCount} photo${r.photoCount === 1 ? "" : "s"} · <a href="/subjects/${r.id}">manage photos</a></div></div>
  <form method="POST" action="/subjects/delete" onsubmit="return confirm('Remove ${esc(r.name)} and all their photos?')">
    <input type="hidden" name="id" value="${r.id}"><button class="small danger">Remove</button>
  </form>
</div>`;
      }),
    )
  ).join("");

  const [limits, used] = await Promise.all([
    limitsFor(c.env, user.id),
    usageFor(c.env.VAULT_KV, user.id),
  ]);
  const quotaLine = `<p class="muted">This month: ${used.images} of ${limits.images < 0 ? "unlimited" : limits.images} images${limits.speech !== 0 ? `, ${used.speech} of ${limits.speech < 0 ? "unlimited" : limits.speech} voice clips` : ""} generated. Limits reset monthly.</p>`;

  return c.html(
    page(
      "Subjects — Helix",
      `${await navFor(c, user)}<h1>Your subjects</h1>
<p class="muted">People and pets whose likeness lives in your vault. Photo apps you approve can generate images of them — they get names and thumbnails; your full photos go only to the image generator, never to the app.</p>
${quotaLine}
${cards || `<p class="muted">No subjects yet. Add your first below.</p>`}
<h2>Add a subject</h2>
<div class="card"><form method="POST" action="/subjects/add" id="subform">
  <label>Name</label><input type="text" name="name" required placeholder="e.g. Fergus">
  <label>Type</label><select name="species"><option>dog</option><option>cat</option><option>person</option><option>other</option></select>
  <label style="display:block;margin-top:10px">Photos (3–8 clear shots)</label>
  <input type="file" id="files" accept="image/*" multiple required>
  <div id="previews" class="row" style="flex-wrap:wrap;margin:8px 0"></div>
  <div id="hidden"></div>
  <button type="submit" id="subbtn" disabled>Add subject</button>
  <p class="muted">Photos are resized in your browser before upload.</p>
</form></div>
<script>
const files = document.getElementById('files');
files.addEventListener('change', async () => {
  const hidden = document.getElementById('hidden'), prev = document.getElementById('previews');
  hidden.innerHTML = ''; prev.innerHTML = '';
  const list = [...files.files].slice(0, 8);
  const scale = (img, max, q) => {
    const r = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  };
  for (let i = 0; i < list.length; i++) {
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.src = URL.createObjectURL(list[i]); });
    const photo = scale(img, 1024, 0.85);
    const inp = document.createElement('input');
    inp.type = 'hidden'; inp.name = 'photos'; inp.value = photo; hidden.appendChild(inp);
    const t = document.createElement('input');
    t.type = 'hidden'; t.name = 'thumbs'; t.value = scale(img, 96, 0.8); hidden.appendChild(t);
    const pv = document.createElement('img');
    pv.src = photo; pv.style.cssText = 'width:48px;height:48px;border-radius:8px;object-fit:cover';
    prev.appendChild(pv);
  }
  document.getElementById('subbtn').disabled = hidden.children.length === 0;
});
</script>`,
    ),
  );
});

/** Zip photos[] with their per-photo thumbs[] (parallel form arrays). */
function photosFromForm(form: FormData): SubjectPhoto[] {
  const thumbs = form.getAll("thumbs").map((t) => t.toString());
  return form
    .getAll("photos")
    .map((p, i) => {
      const photo = parseDataUri(p.toString());
      if (photo && thumbs[i]?.startsWith("data:image/")) photo.thumb = thumbs[i];
      return photo;
    })
    .filter((p): p is SubjectPhoto => p !== null);
}

app.post("/subjects/add", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const form = await c.req.formData();
  const name = form.get("name")?.toString().trim() ?? "";
  const species = form.get("species")?.toString().trim() || "other";
  const photos = photosFromForm(form);
  const thumb = photos[0]?.thumb ?? form.get("thumb")?.toString() ?? "";
  if (name && photos.length > 0) {
    await createSubject(c.env.VAULT_KV, user.id, { name, species, thumb, photos });
  }
  return c.redirect("/subjects");
});

// ---------- subject detail: per-photo gardening ----------

app.get("/subjects/:id", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const subject = await getSubject(c.env.VAULT_KV, user.id, c.req.param("id"));
  if (!subject) return c.redirect("/subjects");

  const tiles = subject.photos
    .map(
      (p, i) => `<div class="card" style="width:150px;padding:10px">
  <img src="${p.thumb ?? `data:${p.mime};base64,${p.b64}`}" alt="" ${p.thumb ? "" : `data-backfill="${p.id}"`} style="width:128px;height:128px;border-radius:8px;object-fit:cover">
  <div class="muted" style="margin:6px 0 8px">${i === 0 ? "★ primary" : i < 2 ? "reference" : `#${i + 1}`}</div>
  <div class="row">
    ${
      i === 0
        ? ""
        : `<form method="POST" action="/subjects/${subject.id}/photos/primary" style="display:inline">
      <input type="hidden" name="photoId" value="${p.id}"><button class="small ghost">Make primary</button>
    </form>`
    }
    <form method="POST" action="/subjects/${subject.id}/photos/delete" style="display:inline" onsubmit="return confirm('Delete this photo of ${esc(subject.name)}?')">
      <input type="hidden" name="photoId" value="${p.id}"><button class="small danger">Delete</button>
    </form>
  </div>
</div>`,
    )
    .join("");

  const canAdd = subject.photos.length < MAX_PHOTOS_PER_SUBJECT;
  return c.html(
    page(
      `${subject.name} — Helix`,
      `${await navFor(c, user)}<h1>${esc(subject.name)} <span class="muted" style="font-size:.6em">${esc(subject.species)}</span></h1>
<p class="muted">The first two photos are used as generation references, and the first is ${esc(subject.name)}'s face everywhere. Keep only clear photos with <em>just</em> ${esc(subject.name)} in frame — a bystander in a reference shows up in generated images.</p>
<div class="row" style="flex-wrap:wrap;align-items:flex-start;gap:12px">${tiles || `<p class="muted">No photos.</p>`}</div>
<h2>Add photos</h2>
${
  canAdd
    ? `<div class="card"><form method="POST" action="/subjects/${subject.id}/photos" id="subform">
  <input type="file" id="files" accept="image/*" multiple required>
  <div id="previews" class="row" style="flex-wrap:wrap;margin:8px 0"></div>
  <div id="hidden"></div>
  <button type="submit" id="subbtn" disabled>Add photos</button>
  <p class="muted">Up to ${MAX_PHOTOS_PER_SUBJECT} photos per subject. Resized in your browser before upload.</p>
</form></div>
<script>
const files = document.getElementById('files');
files.addEventListener('change', async () => {
  const hidden = document.getElementById('hidden'), prev = document.getElementById('previews');
  hidden.innerHTML = ''; prev.innerHTML = '';
  const list = [...files.files].slice(0, ${MAX_PHOTOS_PER_SUBJECT - subject.photos.length});
  const scale = (img, max, q) => {
    const r = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  };
  for (const f of list) {
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.src = URL.createObjectURL(f); });
    const inp = document.createElement('input');
    inp.type = 'hidden'; inp.name = 'photos'; inp.value = scale(img, 1024, 0.85); hidden.appendChild(inp);
    const t = document.createElement('input');
    t.type = 'hidden'; t.name = 'thumbs'; t.value = scale(img, 96, 0.8); hidden.appendChild(t);
    const pv = document.createElement('img');
    pv.src = t.value; pv.style.cssText = 'width:48px;height:48px;border-radius:8px;object-fit:cover';
    prev.appendChild(pv);
  }
  document.getElementById('subbtn').disabled = hidden.children.length === 0;
});
</script>`
    : `<p class="muted">Photo limit reached (${MAX_PHOTOS_PER_SUBJECT}). Delete a photo to add another.</p>`
}
<p><a href="/subjects">← All subjects</a></p>
<script>
// Self-healing: photos uploaded before per-photo thumbnails get one
// generated here (the only place with full photo + canvas) and saved.
document.querySelectorAll('img[data-backfill]').forEach((img) => {
  const make = () => {
    try {
      const r = Math.min(1, 96 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * r); cv.height = Math.round(img.naturalHeight * r);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const body = new URLSearchParams({ photoId: img.dataset.backfill, thumb: cv.toDataURL('image/jpeg', 0.8) });
      fetch(location.pathname + '/photos/thumb', { method: 'POST', body });
    } catch (e) { /* best effort */ }
  };
  if (img.complete) make(); else img.addEventListener('load', make);
});
</script>`,
    ),
  );
});

app.post("/subjects/:id/photos/thumb", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const form = await c.req.formData();
  const photoId = form.get("photoId")?.toString() ?? "";
  const thumb = form.get("thumb")?.toString() ?? "";
  if (photoId && thumb.startsWith("data:image/")) {
    await setPhotoThumb(c.env.VAULT_KV, user.id, c.req.param("id"), photoId, thumb);
  }
  return c.json({ ok: true });
});

app.post("/subjects/:id/photos", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const photos = photosFromForm(await c.req.formData());
  if (photos.length > 0) {
    await addPhotosToSubject(c.env.VAULT_KV, user.id, c.req.param("id"), photos);
  }
  return c.redirect(`/subjects/${c.req.param("id")}`);
});

app.post("/subjects/:id/photos/delete", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const photoId = (await c.req.formData()).get("photoId")?.toString() ?? "";
  if (photoId) await deletePhotoFromSubject(c.env.VAULT_KV, user.id, c.req.param("id"), photoId);
  return c.redirect(`/subjects/${c.req.param("id")}`);
});

app.post("/subjects/:id/photos/primary", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const photoId = (await c.req.formData()).get("photoId")?.toString() ?? "";
  if (photoId) await makePhotoPrimary(c.env.VAULT_KV, user.id, c.req.param("id"), photoId);
  return c.redirect(`/subjects/${c.req.param("id")}`);
});

app.post("/subjects/delete", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const id = (await c.req.formData()).get("id")?.toString() ?? "";
  if (id) await deleteSubject(c.env.VAULT_KV, user.id, id);
  return c.redirect("/subjects");
});

// ---------- generated-image links (1-hour capability URLs) ----------

app.get("/i/:token", async (c) => {
  const img = await readGeneratedImage(c.env.VAULT_KV, c.req.param("token"));
  if (!img) {
    return c.html(
      page("Expired — Helix", `<h1>Link expired</h1><p class="muted">Generated images are available for 24 hours. Ask your AI app to generate it again.</p>`),
      404,
    );
  }
  const bytes = Uint8Array.from(atob(img.b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "Content-Type": img.mime,
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename=helix-${img.mime.startsWith("audio/") ? "audio.mp3" : "image.png"}`,
    },
  });
});

// ---------- policies, security posture, account deletion ----------

const UPDATED = "August 2026";

app.get("/privacy", async (c) =>
  c.html(
    page(
      "Privacy — Helix",
      `${await navFor(c, await sessionUser(c))}<div class="legal"><h1>Privacy</h1>
<p class="muted">Last updated ${UPDATED}. Helix is operated by HelixAI, LLC. Plain language, because a privacy product with an unreadable privacy policy is a contradiction.</p>

<h2>What we hold</h2>
<p>Only what you put in your vault, plus what's needed to run it: your name, email, a hash of your passphrase (never the passphrase), the facts you write or approve, photos and voice recordings you add as subjects, and the audit log of which apps read what.</p>

<h2>What we never do</h2>
<ul>
<li>We don't sell your data, and there are no ads in Helix.</li>
<li>We don't train models on your vault, and we don't let anyone else.</li>
<li>We don't read your vault for any purpose other than serving your own requests. See <a href="/security">Security</a> for what that means technically.</li>
<li>We don't give apps your source photos or voice recordings — ever. Apps receive names, thumbnails, and finished generations only.</li>
</ul>

<h2>Who else sees anything</h2>
<p>Apps you explicitly connect, limited to the categories you check on the consent screen. You can see every access on your audit page and cut any app off instantly from your connections page.</p>
<p>Two service providers process data on our behalf: <strong>Cloudflare</strong> (hosting and storage) and, only when you generate an image or speech, the <strong>image or voice provider named on that request</strong> (currently OpenAI and ElevenLabs), which receives the reference material for that single request. Transactional email goes through <strong>Resend</strong>.</p>

<h2>Your controls</h2>
<ul>
<li><strong>See everything:</strong> your whole vault is on one page, and the preview shows exactly what an app receives.</li>
<li><strong>Approve everything:</strong> nothing an app proposes enters your vault without you saying yes.</li>
<li><strong>Revoke anything:</strong> one click kills an app's access immediately.</li>
<li><strong>Leave with everything:</strong> export your entire vault in one request.</li>
<li><strong>Delete everything:</strong> <a href="/account">delete your vault</a> yourself, at any time, without asking us.</li>
</ul>

<h2>Retention</h2>
<p>Vault contents stay until you delete them. Generated images and audio expire after 24 hours. The audit log keeps the most recent 200 events. Deleting your account removes all of it, including generated media, and cannot be undone.</p>

<h2>Children</h2>
<p>Helix isn't for people under 16. Subjects you add who are minors are your responsibility as their parent or guardian.</p>

<h2>Contact</h2>
<p>Questions, requests, or complaints: <a href="mailto:hello@helix.ai">hello@helix.ai</a>.</p></div>`,
    ),
  ),
);

app.get("/terms", async (c) =>
  c.html(
    page(
      "Terms — Helix",
      `${await navFor(c, await sessionUser(c))}<div class="legal"><h1>Terms</h1>
<p class="muted">Last updated ${UPDATED}. Short, because the deal is simple.</p>

<h2>The deal</h2>
<p>Helix stores personal context you choose to give it and shares it only with apps you authorize. Helix is free during the beta. Your vault is yours: you can export it or delete it at any time.</p>

<h2>Your side</h2>
<ul>
<li>Add likeness only for yourself, for people who have agreed, or for those you're the parent or guardian of. Don't vault someone else's face or voice without their consent.</li>
<li>Don't use Helix to impersonate anyone, to make misleading media of real people, or for anything illegal.</li>
<li>Keep your passphrase to yourself. We can't recover it, though you can reset it by email.</li>
<li>Don't attack the service or try to reach other people's vaults.</li>
</ul>

<h2>Our side</h2>
<p>We run the service with care but make no warranty — this is a beta, and you shouldn't put anything in your vault that you can't afford to lose. Keep your own copies of photos and recordings that matter. Our liability is limited to what you've paid us, which during the beta is nothing.</p>
<p>We may suspend accounts that abuse the service or violate the rules above. If we ever shut the service down, we'll give notice and an export window.</p>

<h2>Changes</h2>
<p>If these terms change materially, we'll email you before the change takes effect.</p></div>`,
    ),
  ),
);

app.get("/security", async (c) =>
  c.html(
    page(
      "Security — Helix",
      `${await navFor(c, await sessionUser(c))}<div class="legal"><h1>Security</h1>
<p class="muted">Last updated ${UPDATED}. Including the parts that aren't flattering, because you should decide what to trust us with based on what's actually true.</p>

<h2>What protects your vault</h2>
<ul>
<li>Passphrases are hashed with PBKDF2-SHA256 (100,000 iterations). We never store or see the passphrase itself.</li>
<li>Everything is encrypted in transit, and encrypted at rest by Cloudflare.</li>
<li>Apps authenticate with OAuth 2.1 and PKCE, and receive only the categories you check. Revocation kills their tokens immediately, mid-session.</li>
<li>Every read, proposal, write, and generation is written to an audit log only you can see.</li>
<li>That log is <strong>hash-chained</strong>: each entry carries the fingerprint of the one before it, so editing, reordering, or removing an entry breaks every link after it. Your audit page checks the chain each time you open it and tells you if it doesn't hold. What this proves is that the entries you can see haven't been rewritten — it does not prove that the operator never deleted a stretch of log wholesale. Self-hosting is the answer if that distinction matters to you.</li>
<li>Owner devices (your phone) authenticate with your passphrase, not with an app scope — no third-party app can ever obtain approval powers.</li>
</ul>

<h2>What is <em>not</em> true yet</h2>
<p><strong>Helix is not end-to-end encrypted.</strong> Your vault is encrypted at rest, but we hold the keys, which means the operator could technically read your vault contents. We don't, and the audit log is designed so misuse would be visible — but "we choose not to" is a weaker promise than "we cannot," and you deserve the distinction stated plainly.</p>
<p>The honest reason: an assistant that answers questions from your context needs that context in readable form at request time. End-to-end encryption with client-side decryption is on the roadmap, and the self-hosted option below is available today for anyone who wants the stronger guarantee now.</p>

<h2>Media and generation</h2>
<p>Your source photos and voice recordings are never sent to apps. When you ask for a generated image or speech, the vault sends the reference material directly to the named provider for that one request and returns the finished result on a link that expires in 24 hours. The provider is disclosed on the consent screen and named in your audit log.</p>

<h2>If you want stronger guarantees</h2>
<p>Helix's vault server is open source and self-hostable — run it on your own Cloudflare account and the operator is you. Nothing in the protocol depends on us.</p>

<h2>Reporting a vulnerability</h2>
<p>Email <a href="mailto:hello@helix.ai">hello@helix.ai</a> with "security" in the subject. We'll respond within 72 hours, we won't pursue good-faith researchers, and we'll credit you if you'd like.</p></div>`,
    ),
  ),
);

/** Remove every key belonging to a user, plus their app grants. */
async function purgeUser(c: Ctx, user: User): Promise<void> {
  const kv = c.env.VAULT_KV;
  const { items: grants } = await c.env.OAUTH_PROVIDER.listUserGrants(user.id);
  for (const g of grants) await c.env.OAUTH_PROVIDER.revokeGrant(g.id, user.id);

  const subjects = await listSubjects(kv, user.id);
  const devices = await listDevices(kv, user.id);
  const month = new Date().toISOString().slice(0, 7);

  await Promise.all([
    ...subjects.map((s) => kv.delete(`subject:${user.id}:${s.id}`)),
    ...devices.map((d) => kv.delete(`device:${d.tokenHash}`)),
    kv.delete(`subjectindex:${user.id}`),
    kv.delete(`devices:${user.id}`),
    kv.delete(`voice:${user.id}`),
    kv.delete(`usage:${user.id}:${month}`),
    kv.delete(`limits:${user.id}`),
    kv.delete(`labels:${user.id}`),
    kv.delete(`auditmeta:${user.id}`),
  ]);
  await deleteUser(kv, user); // user, email index, vault, pending, audit
}

app.get("/account", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  return c.html(
    page(
      "Account — Helix",
      `${await navFor(c, user)}<h1>Account</h1>
<div class="card">
  <p><strong>${esc(user.name)}</strong><br><span class="muted">${esc(user.email)}</span></p>
  <p class="muted">Vault id <code>${esc(user.id)}</code> · created ${esc(user.createdAt.slice(0, 10))}</p>
</div>

<h2>Take it with you</h2>
<p class="muted">Your whole vault — facts, subjects, photos, voice takes, pending items and audit log — in one file. No support ticket, no waiting.</p>
<p><a href="/account/export">Download my vault (JSON) →</a></p>

<h2>Bring a vault in</h2>
<div class="card">
  <p class="muted">Load a Helix export — from another vault, a self-hosted one, or your own backup. It <strong>merges</strong>: nothing already here is overwritten, and importing the same file twice changes nothing.</p>
  <p class="muted">Audit history and app connections stay behind by design; they belong to the server that issued them.</p>
  <form method="POST" action="/account/import" enctype="multipart/form-data">
    <label>Export file (.json)</label>
    <input type="file" name="file" accept="application/json,.json" required>
    <button>Import into my vault</button>
  </form>
</div>

<h2>Delete everything</h2>
<div class="card">
  <p>This removes your vault, subjects and their photos, voice recordings, audit log, and connected apps. It happens immediately and cannot be undone.</p>
  <form method="POST" action="/account/delete" onsubmit="return confirm('Delete your vault and everything in it? This cannot be undone.')">
    <label>Confirm your passphrase</label>
    <input type="password" name="passphrase" required>
    <button class="danger">Delete my vault permanently</button>
  </form>
</div>`,
    ),
  );
});

/** The whole vault as one portable document. Exit rights as code. */
export async function buildExport(c: Ctx, user: User): Promise<Record<string, unknown>> {
  const kv = c.env.VAULT_KV;
  const [vault, refs, voice, pending, audit, labelDoc] = await Promise.all([
    loadVault(kv, user.id, { name: user.name, email: user.email }),
    listSubjects(kv, user.id),
    loadVoice(kv, user.id),
    listPending(kv, user.id),
    readAudit(kv, user.id),
    loadLabels(kv, user.id),
  ]);
  const subjects = [];
  for (const r of refs) {
    const s = await getSubject(kv, user.id, r.id);
    if (s) subjects.push(s);
  }
  const { items: grants } = await c.env.OAUTH_PROVIDER.listUserGrants(user.id);
  return {
    format: "helix-export/v1",
    exported_at: new Date().toISOString(),
    user: { id: user.id, name: user.name, email: user.email, created_at: user.createdAt },
    vault,
    subjects,
    voice: { verified_at: voice.verifiedAt ?? null, takes: voice.takes },
    // Keyed by entry id, which is a pure function of category + list + text —
    // so the same entry gets the same id in any vault, and these marks land
    // on the right entries after an import. Without this section, importing
    // would silently un-private everything you'd hidden.
    marks: { labels: labelDoc.labels, private: labelDoc.private },
    pending,
    audit,
    connected_apps: grants.map((g) => ({
      app: ((g.metadata as { label?: string } | undefined)?.label ?? g.clientId).split(" → ")[0],
      scopes: g.scope ?? [],
    })),
  };
}

app.get("/account/export", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const payload = await buildExport(c, user);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="helix-vault-${user.id}-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});

/** Import's mirror. Owner-only: apps propose, owners load documents. */
app.post("/account/import", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const file = (await c.req.formData()).get("file");
  const nav = await navFor(c, user);
  const back = `<p><a href="/account">← Back to account</a></p>`;
  const fail = (msg: string) =>
    c.html(page("Import — Helix", `${nav}<h1>Import</h1><div class="card"><p>${esc(msg)}</p>${back}</div>`), 400);

  if (!(file instanceof File)) return fail("No file was attached.");
  if (file.size > MAX_IMPORT_BYTES)
    return fail(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB. If it's photo-heavy, import the vault first and move subjects across separately.`,
    );

  let doc: unknown;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    return fail("That file isn't valid JSON. A Helix export is the .json file from “Download my vault”.");
  }
  const problem = checkExport(doc);
  if (problem) return fail(problem);

  const r = await importExport(c.env.VAULT_KV, user.id, doc);
  await appendAudit(c.env.VAULT_KV, user.id, {
    client: "Helix (owner)",
    action: "write",
    detail: importSummary(r),
  });

  const notes = r.notes.length
    ? `<h2>Worth knowing</h2>${r.notes.map((n) => `<p class="muted">${esc(n)}</p>`).join("")}`
    : "";
  return c.html(
    page(
      "Import — Helix",
      `${nav}<h1>Import complete</h1>
<div class="card">
  <p><strong>${r.facts}</strong> fact${r.facts === 1 ? "" : "s"}, <strong>${r.subjects}</strong> subject${r.subjects === 1 ? "" : "s"}, <strong>${r.photos}</strong> photo${r.photos === 1 ? "" : "s"} and <strong>${r.takes}</strong> voice take${r.takes === 1 ? "" : "s"} were added.</p>
  <p class="muted">Anything already in your vault was left alone, so importing this file again would add nothing.</p>
  <p><a href="/vault">Review your vault →</a></p>
</div>
${notes}
${back}`,
    ),
  );
});

app.post("/account/delete", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const passphrase = (await c.req.formData()).get("passphrase")?.toString() ?? "";
  if (!(await verifyPassphrase(passphrase, user.passHash))) {
    return c.html(
      page(
        "Account — Helix",
        `${await navFor(c, user)}<h1>Account</h1><p class="muted">That passphrase didn't match — nothing was deleted. <a href="/account">Try again</a>.</p>`,
      ),
      401,
    );
  }
  await purgeUser(c, user);
  c.header("Set-Cookie", CLEAR_SESSION_COOKIE);
  return c.html(
    page(
      "Deleted — Helix",
      `<h1>Your vault is gone</h1>
<p class="muted">Everything has been deleted and connected apps have been cut off. Thanks for trying Helix — if you'd tell us what didn't work, <a href="mailto:hello@helix.ai">hello@helix.ai</a> reaches a human.</p>`,
    ),
  );
});

// ---------- voice (owner-only likeness, strict tier) ----------

app.get("/voice", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const profile = await loadVoice(c.env.VAULT_KV, user.id);

  const takesHtml = profile.takes
    .map(
      (t) => `<div class="fact">
  <div class="reader fact-text">
    <div>${t.isPhrase ? "★ verification phrase" : esc(t.style)} <span class="muted">· ${esc(t.recordedAt.slice(0, 16).replace("T", " "))}</span></div>
    <audio controls preload="none" src="data:${esc(t.mime)};base64,${t.b64}" style="width:100%;max-width:320px;margin-top:6px"></audio>
  </div>
  <form method="POST" action="/voice/takes/delete" onsubmit="return confirm('Delete this take?')">
    <input type="hidden" name="takeId" value="${t.id}"><button class="small danger">Delete</button>
  </form>
</div>`,
    )
    .join("");

  const status = profile.takes.length === 0
    ? `<p class="muted">No voice recorded yet.</p>`
    : profile.verifiedAt
      ? `<p><span class="badge">script-verified</span> <span class="muted">${profile.takes.length} take${profile.takes.length === 1 ? "" : "s"} in the vault. Apps never receive these — they send text, your vault returns finished audio.</span></p>`
      : `<p class="muted">${profile.takes.length} take(s) — <strong>not yet verified</strong>: record a session that includes the verification phrase card.</p>`;

  const cards = [
    ...VOICE_CARDS.map((card, i) => ({ ...card, isPhrase: false, n: i + 1 })),
    { style: "phrase", direction: "Clearly and naturally — this proves the voice is yours, recorded now", text: profile.phrase.text, isPhrase: true, n: VOICE_CARDS.length + 1 },
  ];

  return c.html(
    page(
      "Voice — Helix",
      `${await navFor(c, user)}<h1>Your voice</h1>
<p class="muted">The strictest thing your vault can hold. Record a short reading session — different inflections make your voice sound like <em>you</em>, not your voicemail. The final card is a verification phrase that didn't exist before this page loaded: it proves the voice being vaulted is yours, recorded live.</p>
${status}
${takesHtml}
<h2>Record a session</h2>
<p class="muted">Quiet room, phone or mic at chest height. Six short cards, about 90 seconds total. You can redo any card before saving.</p>
<div id="cards">
${cards
  .map(
    (card) => `<div class="card" data-style="${card.style}" data-phrase="${card.isPhrase ? "1" : "0"}">
  <p class="muted">Card ${card.n} of ${cards.length} — <strong>${card.isPhrase ? "Verification" : esc(card.style)}</strong>: ${esc(card.direction)}</p>
  <p style="font-size:1.05em">&ldquo;${esc(card.text)}&rdquo;</p>
  <div class="row">
    <button type="button" class="small rec">● Record</button>
    <button type="button" class="small ghost stop" disabled>■ Stop</button>
    <span class="muted state"></span>
  </div>
  <div class="preview" style="margin-top:8px"></div>
</div>`,
  )
  .join("")}
</div>
<form method="POST" action="/voice/takes" id="voiceform">
  <div id="hidden"></div>
  <button type="submit" id="savebtn" disabled>Save session to vault</button>
  <p class="muted">Recorded takes stay on this page until you save. Saving replaces your provider compilation — it will be rebuilt from the new takes.</p>
</form>
<script>
let recorder = null, activeCard = null;
const hidden = document.getElementById('hidden');
const savebtn = document.getElementById('savebtn');
const takes = new Map();

function refreshSave() {
  savebtn.disabled = takes.size === 0;
  savebtn.textContent = takes.size === 0 ? 'Save session to vault'
    : 'Save ' + takes.size + ' take' + (takes.size === 1 ? '' : 's') + ' to vault';
}

document.querySelectorAll('#cards .card').forEach((card) => {
  const recBtn = card.querySelector('.rec'), stopBtn = card.querySelector('.stop');
  const state = card.querySelector('.state'), preview = card.querySelector('.preview');

  recBtn.addEventListener('click', async () => {
    if (recorder) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      activeCard = card;
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        recorder = null; activeCard = null;
        recBtn.disabled = false; stopBtn.disabled = true; state.textContent = '';
        if (blob.size < 4000) { state.textContent = 'Too short — try again.'; return; }
        if (blob.size > 2500000) { state.textContent = 'Too long — keep it under ~60s.'; return; }
        const b64 = await new Promise((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result.split(',')[1]);
          r.readAsDataURL(blob);
        });
        preview.innerHTML = '';
        const audio = document.createElement('audio');
        audio.controls = true; audio.src = URL.createObjectURL(blob);
        preview.appendChild(audio);
        takes.set(card, { style: card.dataset.style, isPhrase: card.dataset.phrase === '1', mime: blob.type, b64 });
        state.textContent = 'Kept — record again to replace.';
        refreshSave();
      };
      recorder.start();
      recBtn.disabled = true; stopBtn.disabled = false; state.textContent = 'Recording…';
    } catch (e) {
      state.textContent = 'Microphone blocked — allow access and retry.';
    }
  });
  stopBtn.addEventListener('click', () => { if (recorder && activeCard === card) recorder.stop(); });
});

document.getElementById('voiceform').addEventListener('submit', () => {
  hidden.innerHTML = '';
  for (const t of takes.values()) {
    for (const [k, v] of Object.entries({ styles: t.style, phrases: t.isPhrase ? '1' : '0', mimes: t.mime, takes: t.b64 })) {
      const inp = document.createElement('input');
      inp.type = 'hidden'; inp.name = k; inp.value = v; hidden.appendChild(inp);
    }
  }
});
</script>`,
    ),
  );
});

app.post("/voice/takes", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const form = await c.req.formData();
  const b64s = form.getAll("takes").map(String);
  const styles = form.getAll("styles").map(String);
  const mimes = form.getAll("mimes").map(String);
  const phrases = form.getAll("phrases").map(String);
  const takes = b64s
    .map((b64, i) => ({
      b64,
      style: (styles[i] ?? "neutral").slice(0, 20),
      mime: (mimes[i] ?? "audio/webm").slice(0, 40),
      isPhrase: phrases[i] === "1",
    }))
    .filter((t) => t.b64.length > 1000 && t.b64.length < 4_000_000 && t.mime.startsWith("audio/"));
  if (takes.length > 0) await addTakes(c.env.VAULT_KV, user.id, takes);
  return c.redirect("/voice");
});

app.post("/voice/takes/delete", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const takeId = (await c.req.formData()).get("takeId")?.toString() ?? "";
  if (takeId) await deleteTake(c.env.VAULT_KV, user.id, takeId);
  return c.redirect("/voice");
});

app.post("/voice/delete", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  await deleteVoice(c.env.VAULT_KV, user.id, c.env.ELEVENLABS_API_KEY);
  return c.redirect("/voice");
});

// ---------- owner devices (the OWNER door) ----------
// Passphrase-authenticated, long-lived device tokens for the owner's own
// apps (HelixVault iOS). Deliberately NOT an OAuth scope: no third-party
// app can request approval powers on a consent screen.

async function ownerFromBearer(c: Ctx) {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token ? getDeviceByToken(c.env.VAULT_KV, token) : null;
}

app.post("/owner/login", async (c) => {
  if (!(await rateLimit(c.env.VAULT_KV, "ownerlogin", clientId(c.req.raw), 20, 900))) {
    return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
  }
  const body = (await c.req.json().catch(() => null)) as {
    email?: string;
    passphrase?: string;
    deviceName?: string;
  } | null;
  const user = body?.email ? await getUserByEmail(c.env.VAULT_KV, body.email) : null;
  if (!user || !body?.passphrase || !(await verifyPassphrase(body.passphrase, user.passHash))) {
    return c.json({ error: "Wrong email or passphrase." }, 401);
  }
  const token = await createDevice(c.env.VAULT_KV, user.id, body.deviceName ?? "iOS device");
  return c.json({ token, name: user.name });
});

app.get("/owner/pending", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const pending = await listPending(c.env.VAULT_KV, device.userId);
  return c.json({ pending });
});

app.post("/owner/decide", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { id?: string; action?: string } | null;
  if (!body?.id) return c.json({ error: "id required" }, 400);
  const action = body.action === "approve" ? "approve" : "reject";
  const decided = await decidePending(c.env.VAULT_KV, device.userId, body.id, action);
  const verb = action === "approve" ? "approved" : "rejected";
  if (decided) {
    await appendAudit(c.env.VAULT_KV, device.userId, {
      client: `You (${device.deviceName})`,
      action: "write",
      detail:
        decided.kind === "labels"
          ? `${verb} labels ${(decided.labels ?? []).join(", ")} proposed by ${decided.client}`
          : `${verb} "${decided.fact.slice(0, 80)}" proposed by ${decided.client}`,
    });
  }
  const pending = await listPending(c.env.VAULT_KV, device.userId);
  return c.json({ ok: decided !== null, pending_count: pending.length });
});

app.post("/owner/push/register", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { apnsToken?: string } | null;
  if (!body?.apnsToken) return c.json({ error: "apnsToken required" }, 400);
  await setDevicePushToken(c.env.VAULT_KV, device.tokenHash, body.apnsToken);
  return c.json({ ok: true });
});

// Owner vault facts — the gardening surface, phone-native. Entries are
// addressed by their content-hash ids (same ids apps see in get_context).

app.get("/owner/vault", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const owner = await getUser(c.env.VAULT_KV, device.userId);
  const vault = await loadVault(c.env.VAULT_KV, device.userId, {
    name: owner?.name,
    email: owner?.email,
  });
  return c.json({
    categories: CATEGORIES.map((cat) => ({
      key: cat,
      label: CATEGORY_META[cat].label,
      hint: CATEGORY_META[cat].hint,
      placeholder: CATEGORY_META[cat].ph,
      base: vault[cat].base.map((text) => ({ id: entryIdOf(cat, "base", text), text })),
      learned: vault[cat].learned.map((l) => ({
        id: entryIdOf(cat, "learned", l.fact),
        fact: l.fact,
        source: l.source,
        date: l.date,
      })),
    })),
  });
});

app.post("/owner/vault/add", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { category?: string; text?: string } | null;
  const category = body?.category as Category | undefined;
  const text = body?.text?.trim() ?? "";
  if (!category || !CATEGORIES.includes(category) || !text)
    return c.json({ error: "category and text required" }, 400);
  const vault = await loadVault(c.env.VAULT_KV, device.userId);
  vault[category].base.push(text.slice(0, 500));
  await saveVault(c.env.VAULT_KV, device.userId, vault);
  await appendAudit(c.env.VAULT_KV, device.userId, {
    client: `You (${device.deviceName})`,
    action: "write",
    detail: `added to ${category}: "${text.slice(0, 80)}"`,
  });
  return c.json({ ok: true });
});

app.post("/owner/vault/update", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { id?: string; text?: string } | null;
  const text = body?.text?.trim() ?? "";
  if (!body?.id || !text) return c.json({ error: "id and text required" }, 400);
  const vault = await loadVault(c.env.VAULT_KV, device.userId);
  const hit = findEntry(vault, body.id);
  if (!hit) return c.json({ error: "entry not found (it may have changed — refresh)" }, 404);
  if (hit.list === "base") vault[hit.category].base[hit.index] = text.slice(0, 500);
  else vault[hit.category].learned[hit.index].fact = text.slice(0, 500);
  await saveVault(c.env.VAULT_KV, device.userId, vault);
  await relabelEntry(c.env.VAULT_KV, device.userId, body.id, entryIdOf(hit.category, hit.list, text.slice(0, 500)));
  await appendAudit(c.env.VAULT_KV, device.userId, {
    client: `You (${device.deviceName})`,
    action: "write",
    detail: `edited a ${hit.category} entry`,
  });
  return c.json({ ok: true });
});

app.post("/owner/vault/delete", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return c.json({ error: "id required" }, 400);
  const vault = await loadVault(c.env.VAULT_KV, device.userId);
  const hit = findEntry(vault, body.id);
  if (!hit) return c.json({ error: "entry not found (it may have changed — refresh)" }, 404);
  if (hit.list === "base") vault[hit.category].base.splice(hit.index, 1);
  else vault[hit.category].learned.splice(hit.index, 1);
  await saveVault(c.env.VAULT_KV, device.userId, vault);
  await pruneLabels(c.env.VAULT_KV, device.userId, vault);
  // Deliberately no text: the audit log is append-only and hash-chained, so
  // echoing a deleted entry into it would mean deletion didn't delete.
  await appendAudit(c.env.VAULT_KV, device.userId, {
    client: `You (${device.deviceName})`,
    action: "write",
    detail: `deleted a ${hit.category} entry`,
  });
  return c.json({ ok: true });
});

// Owner subject management — mirrors the /api door so the owner's own
// app needs exactly ONE sign-in. Same trust invariant: thumbnails out,
// never full-res.

app.get("/owner/subjects", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const refs = await listSubjects(c.env.VAULT_KV, device.userId);
  const subjects = [];
  for (const r of refs) {
    const s = await getSubject(c.env.VAULT_KV, device.userId, r.id);
    subjects.push({
      id: r.id,
      name: r.name,
      species: r.species,
      photo_count: r.photoCount,
      thumb: s?.thumb ?? "",
    });
  }
  return c.json({ subjects });
});

app.get("/owner/subjects/:id", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const s = await getSubject(c.env.VAULT_KV, device.userId, c.req.param("id"));
  if (!s) return c.json({ error: "unknown subject" }, 404);
  return c.json({
    subject: {
      id: s.id,
      name: s.name,
      species: s.species,
      thumb: s.thumb,
      max_photos: MAX_PHOTOS_PER_SUBJECT,
      photos: s.photos.map((ph, i) => ({
        id: ph.id,
        thumb: ph.thumb ?? "",
        is_primary: i === 0,
        is_reference: i < 2,
      })),
    },
  });
});

app.post("/owner/subjects", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    species?: string;
    photos?: string[];
    thumbs?: string[];
  } | null;
  const photos = zipPhotos(body?.photos, body?.thumbs);
  if (!body?.name?.trim() || photos.length === 0)
    return c.json({ error: "name and photos[] required" }, 400);
  const existing = await listSubjects(c.env.VAULT_KV, device.userId);
  if (existing.length >= 20) return c.json({ error: "subject limit reached (20)" }, 409);
  const subject = await createSubject(c.env.VAULT_KV, device.userId, {
    name: body.name.trim().slice(0, 60),
    species: (body.species?.trim() || "other").slice(0, 30),
    thumb: photos[0]?.thumb ?? "",
    photos,
  });
  return c.json(
    {
      subject: {
        id: subject.id,
        name: subject.name,
        species: subject.species,
        photo_count: subject.photos.length,
        thumb: subject.thumb,
      },
    },
    201,
  );
});

app.delete("/owner/subjects/:id", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  await deleteSubject(c.env.VAULT_KV, device.userId, c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/owner/subjects/:id/photos", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    photos?: string[];
    thumbs?: string[];
  } | null;
  const photos = zipPhotos(body?.photos, body?.thumbs);
  if (photos.length === 0) return c.json({ error: "photos[] required" }, 400);
  const updated = await addPhotosToSubject(c.env.VAULT_KV, device.userId, c.req.param("id"), photos);
  if (!updated) return c.json({ error: "unknown subject" }, 404);
  return c.json({ photo_count: updated.photos.length });
});

app.delete("/owner/subjects/:id/photos/:photoId", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const updated = await deletePhotoFromSubject(
    c.env.VAULT_KV,
    device.userId,
    c.req.param("id"),
    c.req.param("photoId"),
  );
  if (!updated) return c.json({ error: "unknown subject" }, 404);
  return c.json({ photo_count: updated.photos.length });
});

app.post("/owner/subjects/:id/photos/:photoId/primary", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const updated = await makePhotoPrimary(
    c.env.VAULT_KV,
    device.userId,
    c.req.param("id"),
    c.req.param("photoId"),
  );
  if (!updated) return c.json({ error: "unknown subject" }, 404);
  return c.json({ ok: true });
});

// Owner voice — the capture ceremony, phone-native. Cards and the
// verification phrase are served by the vault so every surface reads
// the same session.

app.get("/owner/voice", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const p = await loadVoice(c.env.VAULT_KV, device.userId);
  return c.json({
    verified_at: p.verifiedAt ?? null,
    cards: [
      ...VOICE_CARDS.map((card) => ({ ...card, is_phrase: false })),
      {
        style: "phrase",
        direction: "Clearly and naturally — this proves the voice is yours, recorded now",
        text: p.phrase.text,
        is_phrase: true,
      },
    ],
    takes: p.takes.map((t) => ({
      id: t.id,
      style: t.style,
      is_phrase: t.isPhrase,
      mime: t.mime,
      b64: t.b64,
      recorded_at: t.recordedAt,
    })),
  });
});

app.post("/owner/voice/takes", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    takes?: { style?: string; mime?: string; b64?: string; is_phrase?: boolean }[];
  } | null;
  const takes = (body?.takes ?? [])
    .map((t) => ({
      style: (t.style ?? "neutral").slice(0, 20),
      mime: (t.mime ?? "audio/mp4").slice(0, 40),
      b64: t.b64 ?? "",
      isPhrase: t.is_phrase === true,
    }))
    .filter((t) => t.b64.length > 1000 && t.b64.length < 4_000_000 && t.mime.startsWith("audio/"));
  if (takes.length === 0) return c.json({ error: "no valid takes" }, 400);
  const p = await addTakes(c.env.VAULT_KV, device.userId, takes);
  return c.json({ take_count: p.takes.length, verified_at: p.verifiedAt ?? null });
});

app.delete("/owner/voice/takes/:id", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const p = await deleteTake(c.env.VAULT_KV, device.userId, c.req.param("id"));
  return c.json({ take_count: p.takes.length, verified_at: p.verifiedAt ?? null });
});

app.delete("/owner/voice", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  await deleteVoice(c.env.VAULT_KV, device.userId, c.env.ELEVENLABS_API_KEY);
  return c.json({ ok: true });
});

/** Exit rights from the phone: the same complete document as the web
 * download, so leaving never requires a laptop or a support ticket. */
app.get("/owner/export", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const user = await getUser(c.env.VAULT_KV, device.userId);
  if (!user) return c.json({ error: "unknown user" }, 404);
  return c.json(await buildExport(c, user));
});

/** …and the way back in. Same merge rules as the web door. */
app.post("/owner/import", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  let doc: unknown;
  try {
    doc = await c.req.json();
  } catch {
    return c.json({ error: "body must be a Helix export document" }, 400);
  }
  const problem = checkExport(doc);
  if (problem) return c.json({ error: problem }, 400);
  const r = await importExport(c.env.VAULT_KV, device.userId, doc);
  await appendAudit(c.env.VAULT_KV, device.userId, {
    client: `Helix (${device.deviceName})`,
    action: "write",
    detail: importSummary(r),
  });
  return c.json(r);
});

app.get("/owner/audit", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const audit = await readAudit(c.env.VAULT_KV, device.userId);
  // The phone gets the same verdict as the web page — a trust claim that only
  // holds on one screen isn't one.
  return c.json({ audit: audit.slice(0, 100), chain: await verifyAuditChain(audit) });
});

app.get("/owner/connections", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const [{ items: grants }, audit, devices] = await Promise.all([
    c.env.OAUTH_PROVIDER.listUserGrants(device.userId),
    readAudit(c.env.VAULT_KV, device.userId),
    listDevices(c.env.VAULT_KV, device.userId),
  ]);
  return c.json({
    grants: grants.map((g) => {
      const label = (g.metadata as { label?: string } | undefined)?.label ?? g.clientId;
      const app = label.split(" → ")[0];
      const lastRead = audit.find((a) => a.client === app && a.action === "read");
      return { id: g.id, app, scopes: g.scope ?? [], last_read: lastRead?.at ?? null };
    }),
    devices: devices.map((d) => ({
      token_hash: d.tokenHash,
      name: d.deviceName,
      created_at: d.createdAt,
      has_push: d.hasPush,
      is_current: d.tokenHash === device.tokenHash,
    })),
  });
});

app.post("/owner/connections/revoke", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { grantId?: string } | null;
  if (!body?.grantId) return c.json({ error: "grantId required" }, 400);
  await c.env.OAUTH_PROVIDER.revokeGrant(body.grantId, device.userId);
  return c.json({ ok: true });
});

app.post("/owner/devices/revoke", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { tokenHash?: string } | null;
  if (!body?.tokenHash) return c.json({ error: "tokenHash required" }, 400);
  await revokeDevice(c.env.VAULT_KV, device.userId, body.tokenHash);
  return c.json({ ok: true });
});

app.post("/owner/logout", async (c) => {
  const device = await ownerFromBearer(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  await revokeDevice(c.env.VAULT_KV, device.userId, device.tokenHash);
  return c.json({ ok: true });
});

app.post("/connections/devices/revoke", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");
  const tokenHash = (await c.req.formData()).get("tokenHash")?.toString() ?? "";
  if (tokenHash) await revokeDevice(c.env.VAULT_KV, user.id, tokenHash);
  return c.redirect("/connections");
});


export { entryId, normalizeVault } from "./vault";
export { verifyAuditChain, auditHash, appendAudit } from "./vault";
export * as labels from "./labels";
export * as toolsig from "./toolsig";
export * as activity from "./activity";
export { compileError as compileErrorForTest } from "./voice";
export { runBackup } from "./backup";
export default app;
