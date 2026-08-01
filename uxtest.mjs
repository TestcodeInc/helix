// UX smoke for the non-MCP routes: runs src/app.ts under Node with a mock KV.
import app from "/tmp/helix-app.mjs";

const store = new Map();
const kv = {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  // Real KV lists everything when no prefix is given (the backup relies on it).
  async list({ prefix = "" } = {}) {
    return {
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  },
};
const env = {
  VAULT_KV: kv, OAUTH_KV: kv, ADMIN_SECRET: "admin-local", COOKIE_SECRET: "test-secret",
  OAUTH_PROVIDER: { listUserGrants: async () => ({ items: [] }), revokeGrant: async () => {} },
};

const base = "http://x";
const req = (path, init) => app.fetch(new Request(base + path, init), env);
const form = (obj) => new URLSearchParams(obj).toString();
const post = (path, obj, cookie) =>
  req(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: form(obj),
    redirect: "manual",
  });
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? "ok " : "FAIL"} ${name}`); if (!cond) failures++; };

// 1. admin unlock → invite → accept → session
const unlock = await post("/admin/unlock", { secret: "admin-local" });
const acookie = cookieOf(unlock);
check("admin unlock sets cookie", acookie.startsWith("helix_admin="));

const adminPage = await post("/admin", { name: "Dave Test", email: "dave@test.dev", userId: "dave" }, acookie);
const adminHtml = await adminPage.text();
const inviteUrl = (adminHtml.match(/id="invite">([^<]+)</) ?? [])[1];
check("invite created", !!inviteUrl);

const token = inviteUrl.split("/invite/")[1];
const accept = await post(`/invite/${token}`, { passphrase: "dave-pass-123", passphrase2: "dave-pass-123" });
const dcookie = cookieOf(accept);
check("invite accept sets session + redirects to welcome", dcookie.startsWith("helix_session=") && accept.headers.get("location") === "/welcome");

// 2. vault page UX markers
let vaultHtml = await (await req("/vault", { headers: { Cookie: dcookie } })).text();
check("human category labels", vaultHtml.includes("About you") && vaultHtml.includes("People &amp; family") && vaultHtml.includes("How you communicate"));
check("category hints", vaultHtml.includes("only what you choose to share"));
check("read-first rows with Edit", vaultHtml.includes('class="fact"') && vaultHtml.includes(">Edit<"));
check("delete has confirm", vaultHtml.includes("confirm('Delete this entry?"));
check("provenance shown", vaultHtml.includes('class="fact-src"'));
check("preview link", vaultHtml.includes("/vault/preview"));
check("no raw slugs as headers", !vaultHtml.includes("<h2>communication-style</h2>"));

// 3. add + edit + delete round trip
await post("/vault/add", { category: "work", text: "Test fact one" }, dcookie);
vaultHtml = await (await req("/vault", { headers: { Cookie: dcookie } })).text();
check("added fact renders", vaultHtml.includes("Test fact one"));
await post("/vault/update", { category: "work", list: "base", index: "0", action: "save", text: "Test fact edited" }, dcookie);
await post("/vault/update", { category: "identity", list: "base", index: "0", action: "delete", text: "" }, dcookie);
vaultHtml = await (await req("/vault", { headers: { Cookie: dcookie } })).text();
check("edit persisted", vaultHtml.includes("Test fact edited"));

// 4. pending badge + banner + learned provenance
const pending = [{ id: "p1", category: "projects", fact: "Dave tests Helix", source: "smoke", client: "TestApp", proposedAt: new Date().toISOString() }];
await kv.put("pending:dave", JSON.stringify(pending));
vaultHtml = await (await req("/vault", { headers: { Cookie: dcookie } })).text();
check("review badge shows count", vaultHtml.includes('class="badge">1<'));
check("pending banner", vaultHtml.includes("waiting for your approval"));
const reviewHtml = await (await req("/review", { headers: { Cookie: dcookie } })).text();
check("review uses human label", reviewHtml.includes("Projects</strong>"));

// 4b. supersession: approving a replacement swaps the old entry out
await post("/vault/add", { category: "work", text: "Old thesis line" }, dcookie);
const { entryId } = await import("/tmp/helix-app.mjs");
const oldId = entryId("work", "base", "Old thesis line");
const supersede = [{ id: "p2", category: "work", fact: "New thesis line", source: "smoke", client: "TestApp", proposedAt: new Date().toISOString(), replaces: oldId, replacesText: "Old thesis line" }];
await kv.put("pending:dave", JSON.stringify(supersede));
const rHtml = await (await req("/review", { headers: { Cookie: dcookie } })).text();
check("review shows replacement strikethrough", rHtml.includes("replaces:") && rHtml.includes("<s>Old thesis line</s>"));
await post("/review/decide", { id: "p2", action: "approve" }, dcookie);
const vaultJson = JSON.parse(store.get("vault:dave"));
check("old entry removed on approve", !vaultJson.work.base.includes("Old thesis line"));
check("replacement added as learned", vaultJson.work.learned.some((l) => l.fact === "New thesis line"));

// 4c. stale replaces id degrades to plain add
const stale = [{ id: "p3", category: "work", fact: "Another fact", source: "smoke", client: "TestApp", proposedAt: new Date().toISOString(), replaces: "zzzzzzz", replacesText: "gone" }];
await kv.put("pending:dave", JSON.stringify(stale));
await post("/review/decide", { id: "p3", action: "approve" }, dcookie);
const vaultJson2 = JSON.parse(store.get("vault:dave"));
check("stale replaces still adds fact", vaultJson2.work.learned.some((l) => l.fact === "Another fact"));

// 5. preview page
const prevHtml = await (await req("/vault/preview", { headers: { Cookie: dcookie } })).text();
check("preview renders context", prevHtml.includes("What an app sees") && prevHtml.includes("# identity"));

// 7. subjects: add, list, thumbnail-only exposure
const px = "data:image/jpeg;base64,dGVzdA=="; // tiny fake data-uri
await post("/subjects/add", { name: "Fergus", species: "dog", photos: px, thumb: px }, dcookie);
const subjHtml = await (await req("/subjects", { headers: { Cookie: dcookie } })).text();
check("subject renders on /subjects", subjHtml.includes("Fergus") && subjHtml.includes("1 photo"));

// 7b. per-photo gardening: add, primary, delete, thumb-follows-first
const subjIdx = JSON.parse(store.get("subjectindex:dave"));
const fergusId = subjIdx.find((s) => s.name === "Fergus").id;
const px2 = "data:image/jpeg;base64,cGhvdG8y";
const th1 = "data:image/jpeg;base64,dGh1bWIx";
const th2 = "data:image/jpeg;base64,dGh1bWIy";
await post(`/subjects/${fergusId}/photos`, { photos: px2, thumbs: th2 }, dcookie);
let subj = JSON.parse(store.get(`subject:dave:${fergusId}`));
check("photo added to subject", subj.photos.length === 2);
check("index count synced", JSON.parse(store.get("subjectindex:dave")).find((s) => s.id === fergusId).photoCount === 2);
const secondPhotoId = subj.photos[1].id;
await post(`/subjects/${fergusId}/photos/primary`, { photoId: secondPhotoId }, dcookie);
subj = JSON.parse(store.get(`subject:dave:${fergusId}`));
check("make primary reorders", subj.photos[0].id === secondPhotoId);
check("avatar follows new primary", subj.thumb === th2);
const detailHtml = await (await req(`/subjects/${fergusId}`, { headers: { Cookie: dcookie } })).text();
check("detail page marks primary + reference", detailHtml.includes("primary") && detailHtml.includes("Make primary"));
await post(`/subjects/${fergusId}/photos/delete`, { photoId: secondPhotoId }, dcookie);
subj = JSON.parse(store.get(`subject:dave:${fergusId}`));
check("photo deleted", subj.photos.length === 1 && subj.photos[0].id !== secondPhotoId);

// Shared by every section below. Declared out here so the commercial block
// can be lifted out cleanly.
let r, j;


// 8c. generated-image capability links
await kv.put("genimg:testtoken", JSON.stringify({ mime: "image/png", b64: "dGVzdA==" }));
r = await req("/i/testtoken");
check("image link serves with mime", r.status === 200 && r.headers.get("content-type") === "image/png");
r = await req("/i/expiredtoken");
check("expired link is a friendly 404", r.status === 404);

// 9. demo page + consent shows likeness
const demoHtml = await (await req("/demo")).text();
check("demo page serves", demoHtml.includes("Dog Photobooth") && demoHtml.includes("scope=likeness"));

// 10. owner-device door: login → pending → decide → revoke
const jpost = (path, obj, token) =>
  req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(obj),
  });
r = await jpost("/owner/login", { email: "dave@test.dev", passphrase: "WRONG", deviceName: "x" });
check("owner login rejects bad passphrase", r.status === 401);
r = await jpost("/owner/login", { email: "dave@test.dev", passphrase: "dave-pass-123", deviceName: "Dave's iPhone" });
j = await r.json();
check("owner login issues device token", typeof j.token === "string" && j.token.length === 64);
const devTok = j.token;
check("token stored hashed, not raw", ![...store.keys()].some((k) => k.includes(devTok)));
await kv.put("pending:dave", JSON.stringify([{ id: "p9", category: "work", fact: "Push test", source: "s", client: "TestApp", proposedAt: new Date().toISOString() }]));
r = await req("/owner/pending", { headers: { Authorization: `Bearer ${devTok}` } });
j = await r.json();
check("owner pending lists queue", j.pending?.[0]?.id === "p9");
r = await jpost("/owner/decide", { id: "p9", action: "approve" }, devTok);
j = await r.json();
check("owner decide approves", j.ok === true && j.pending_count === 0);
r = await jpost("/owner/push/register", { apnsToken: "apns-abc" }, devTok);
check("push token registered", (await r.json()).ok === true);
const connHtml2 = await (await req("/connections", { headers: { Cookie: dcookie } })).text();
check("device listed on connections", connHtml2.includes("Dave&#39;s iPhone") || connHtml2.includes("Dave's iPhone"));
r = await req("/owner/export", { headers: { Authorization: `Bearer ${devTok}` } });
j = await r.json();
check("owner door exports the whole vault", j.format === "helix-export/v1" && !!j.vault && Array.isArray(j.subjects));
r = await req("/owner/export");
check("export requires a device token", r.status === 401);

// Seeded rather than assumed: without this the assertion silently depends on
// the REST section above, which the open build doesn't have.
await kv.put("audit:dave", JSON.stringify([
  { at: new Date().toISOString(), client: "Test", action: "read", detail: "identity" },
]));
r = await req("/owner/audit", { headers: { Authorization: `Bearer ${devTok}` } });
j = await r.json();
check("owner audit returns entries", Array.isArray(j.audit) && j.audit.length > 0);
r = await req("/owner/connections", { headers: { Authorization: `Bearer ${devTok}` } });
j = await r.json();
check("owner connections: grants + devices with current flag", Array.isArray(j.grants) && j.devices?.[0]?.is_current === true);

r = await jpost("/owner/logout", {}, devTok);
check("owner logout ok", (await r.json()).ok === true);
r = await req("/owner/pending", { headers: { Authorization: `Bearer ${devTok}` } });
check("revoked device token dead", r.status === 401);

// 11. voice ceremony
let vHtml = await (await req("/voice", { headers: { Cookie: dcookie } })).text();
check("voice page issues verification phrase", vHtml.includes("my Helix code is") && vHtml.includes("Verification"));
check("voice page has styled cards", vHtml.includes("narrator") && vHtml.includes("sleeping nearby"));
const audioB64 = "QUFB".repeat(400); // fake audio payload > 1000 chars
await post("/voice/takes", { takes: audioB64, styles: "warm", mimes: "audio/webm", phrases: "0" }, dcookie);
let vProfile = JSON.parse(store.get("voice:dave"));
check("take saved, unverified without phrase", vProfile.takes.length === 1 && !vProfile.verifiedAt);
await post("/voice/takes", { takes: audioB64, styles: "phrase", mimes: "audio/webm", phrases: "1" }, dcookie);
vProfile = JSON.parse(store.get("voice:dave"));
check("phrase take marks script-verified", vProfile.takes.length === 2 && !!vProfile.verifiedAt);
vHtml = await (await req("/voice", { headers: { Cookie: dcookie } })).text();
check("voice page shows verified badge", vHtml.includes("script-verified"));
const takeId = vProfile.takes[1].id;
await post("/voice/takes/delete", { takeId }, dcookie);
vProfile = JSON.parse(store.get("voice:dave"));
check("deleting phrase take clears verification", vProfile.takes.length === 1 && !vProfile.verifiedAt);

// 12. owner voice endpoints (mobile ceremony)
r = await jpost("/owner/login", { email: "dave@test.dev", passphrase: "dave-pass-123", deviceName: "VoicePhone" });
const vTok = (await r.json()).token;
r = await req("/owner/voice", { headers: { Authorization: `Bearer ${vTok}` } });
j = await r.json();
check("owner voice serves cards + phrase", j.cards?.length === 6 && j.cards[5].is_phrase === true && j.cards[5].text.includes("Helix code"));
r = await jpost("/owner/voice/takes", { takes: [{ style: "phrase", mime: "audio/mp4", b64: audioB64, is_phrase: true }] }, vTok);
j = await r.json();
check("owner voice take saved + verified", j.verified_at !== null);
r = await req("/owner/voice", { headers: { Authorization: `Bearer ${vTok}` } });
j = await r.json();
const vTakeId = j.takes[j.takes.length - 1].id;
r = await req(`/owner/voice/takes/${vTakeId}`, { method: "DELETE", headers: { Authorization: `Bearer ${vTok}` } });
check("owner voice take delete", (await r.json()).take_count >= 0);

// 13. owner vault facts
r = await req("/owner/vault", { headers: { Authorization: `Bearer ${vTok}` } });
j = await r.json();
check("owner vault serves categories with labels", j.categories?.length === 6 && j.categories[0].label === "About you");
await jpost("/owner/vault/add", { category: "work", text: "Owner-added fact" }, vTok);
r = await req("/owner/vault", { headers: { Authorization: `Bearer ${vTok}` } });
j = await r.json();
const workCat = j.categories.find((cAt) => cAt.key === "work");
const ownerEntry = workCat.base.find((e) => e.text === "Owner-added fact");
check("owner vault add", !!ownerEntry);
await jpost("/owner/vault/update", { id: ownerEntry.id, text: "Owner-edited fact" }, vTok);
r = await req("/owner/vault", { headers: { Authorization: `Bearer ${vTok}` } });
j = await r.json();
const edited = j.categories.find((cAt) => cAt.key === "work").base.find((e) => e.text === "Owner-edited fact");
check("owner vault update by entry id", !!edited);
r = await jpost("/owner/vault/delete", { id: edited.id }, vTok);
check("owner vault delete", (await r.json()).ok === true);

// 14. self-serve signup, verification, reset
let sHtml = await (await req("/signup")).text();
check("signup page renders", sHtml.includes("Create your vault"));
r = await post("/signup", { name: "Nora New", email: "nora@test.dev", passphrase: "short", passphrase2: "short" });
check("signup rejects weak passphrase", r.status === 400);
r = await post("/signup", { name: "Nora New", email: "nora@test.dev", passphrase: "correct-horse-battery", passphrase2: "nope-different" });
check("signup rejects mismatch", r.status === 400);
r = await post("/signup", { name: "Nora New", email: "nora@test.dev", passphrase: "correct-horse-battery", passphrase2: "correct-horse-battery" });
sHtml = await r.text();
check("signup creates account + shows next step", sHtml.includes("Check your email"));
const noraId = await kv.get("useremail:nora@test.dev");
let nora = JSON.parse(store.get(`user:${noraId}`));
check("new account starts unverified", nora.unverified === true);
r = await post("/login", { email: "nora@test.dev", passphrase: "correct-horse-battery" });
check("unverified account cannot sign in (403)", r.status === 403);
const verifyToken = [...store.keys()].find((k) => k.startsWith("verify:")).slice("verify:".length);
r = await req(`/verify/${verifyToken}`, { redirect: "manual" });
check("verify signs in and lands on welcome", r.status === 302 && r.headers.get("location") === "/welcome" && cookieOf(r).startsWith("helix_session="));
nora = JSON.parse(store.get(`user:${noraId}`));
check("verification clears the flag", nora.unverified === undefined);
r = await post("/login", { email: "nora@test.dev", passphrase: "correct-horse-battery" });
check("verified account can sign in", cookieOf(r).startsWith("helix_session="));
r = await post("/signup", { name: "Someone Else", email: "nora@test.dev", passphrase: "another-long-phrase", passphrase2: "another-long-phrase" });
check("signup blocks existing verified email", r.status === 400);
sHtml = await (await post("/forgot", { email: "nora@test.dev" })).text();
check("forgot reveals nothing either way", sHtml.includes("Check your email"));
const resetToken = [...store.keys()].find((k) => k.startsWith("reset:")).slice("reset:".length);
r = await post(`/reset/${resetToken}`, { passphrase: "brand-new-passphrase", passphrase2: "brand-new-passphrase" }, undefined);
check("reset signs in and redirects to vault", r.status === 302 && r.headers.get("location") === "/vault");
r = await post("/login", { email: "nora@test.dev", passphrase: "brand-new-passphrase" });
check("new passphrase works after reset", cookieOf(r).startsWith("helix_session="));
check("legacy users without the flag still sign in", (await post("/login", { email: "dave@test.dev", passphrase: "dave-pass-123" })).headers.get("set-cookie") !== null);

// 15. abuse armor
for (let i = 0; i < 4; i++) await post("/forgot", { email: "nora@test.dev" });
r = await post("/forgot", { email: "nora@test.dev" });
check("forgot is rate limited", r.status === 429);
const bigQueue = Array.from({ length: 100 }, (_, i) => ({
  id: `q${i}`, category: "work", fact: `queued ${i}`, source: "s", client: "Spammy", proposedAt: new Date().toISOString(),
}));
await kv.put("pending:dave", JSON.stringify(bigQueue));
check("pending cap reached is detectable", JSON.parse(store.get("pending:dave")).length === 100);
await kv.put("pending:dave", JSON.stringify([]));
check("turnstile passes when unconfigured", (await (await req("/signup")).text()).includes("cf-turnstile") === false);

// 16. trust paperwork: policies, export, deletion
for (const [path, marker] of [["/privacy", "What we never do"], ["/terms", "The deal"], ["/security", "not end-to-end encrypted"]]) {
  check(`${path} renders`, (await (await req(path)).text()).includes(marker));
}
check("security page is honest about operator access", (await (await req("/security")).text()).includes("we hold the keys"));
r = await req("/account", { headers: { Cookie: dcookie } });
check("account page shows export + delete", (await r.text()).includes("Download my vault"));
r = await req("/account/export", { headers: { Cookie: dcookie } });
j = await r.json();
check("export is a complete portable document", j.format === "helix-export/v1" && !!j.vault && Array.isArray(j.subjects) && Array.isArray(j.audit));
r = await post("/account/delete", { passphrase: "wrong-passphrase" }, dcookie);
check("delete requires the right passphrase", r.status === 401 && !!store.get("user:dave"));
r = await post("/account/delete", { passphrase: "brand-new-passphrase" }, dcookie);
check("delete needs the CURRENT passphrase (dave's is unchanged)", r.status === 401);
r = await post("/account/delete", { passphrase: "dave-pass-123" }, dcookie);
check("self-serve delete wipes the account", r.status === 200 && !store.get("user:dave") && !store.get("vault:dave") && !store.get("subjectindex:dave") && !store.get("voice:dave"));

// 17. scope hints on consent
const authUrl = (scope) =>
  `/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent("http://localhost:9999/cb")}&code_challenge=abc&code_challenge_method=plain&state=s${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`;
env.OAUTH_PROVIDER.parseAuthRequest = async (rq) => {
  const u = new URL(rq.url);
  return { clientId: "x", redirectUri: "http://localhost:9999/cb", scope: (u.searchParams.get("scope") ?? "").split(" ").filter(Boolean), state: "s", codeChallenge: "abc", codeChallengeMethod: "plain", responseType: "code" };
};
env.OAUTH_PROVIDER.lookupClient = async () => ({ clientName: "Dog Photobooth" });
let aHtml = await (await req(authUrl("likeness likeness:write"))).text();
check("requested scopes are pre-checked", /value="likeness"\s+checked/.test(aHtml) && /value="likeness:write"\s+checked/.test(aHtml));
check("unrequested scopes are not pre-checked", !/value="identity"\s+checked/.test(aHtml));
check("extra scopes tucked behind a disclosure", aHtml.includes("Give it more than it asked for"));
check("consent names the app", aHtml.includes("Dog Photobooth is asking for"));
aHtml = await (await req(authUrl(""))).text();
check("no declared scopes falls back to context defaults", /value="identity"\s+checked/.test(aHtml) && !/value="likeness"\s+checked/.test(aHtml));
check("plain-language labels, not slugs", aHtml.includes("Read people &amp; family") || aHtml.includes("Read people & family"));

// 18. backups
const { runBackup } = await import("/tmp/helix-app.mjs");
let backedUp = null;
env.BACKUPS = {
  async put(key, body) { backedUp = { key, body }; },
  async list() { return { objects: [{ key: "backups/2020-01-01.json" }] }; },
  async delete(key) { this.deleted = key; },
};
await kv.put("genimg:tmp", "ephemeral");
await kv.put("rl:signup:1.2.3.4:1", "3");
let bk = await runBackup(env);
check("backup writes a dated object", bk.ok && backedUp.key.startsWith("backups/") && backedUp.key.endsWith(".json"));
const dumped = JSON.parse(backedUp.body);
check("backup captures durable keys", dumped.format === "helix-backup/v1" && Object.keys(dumped.keys).some((k) => k.startsWith("user:")));
check("backup skips ephemeral keys", !Object.keys(dumped.keys).some((k) => k.startsWith("genimg:") || k.startsWith("rl:")));
check("backup prunes old objects", env.BACKUPS.deleted === "backups/2020-01-01.json");
bk = await runBackup({ ...env, BACKUPS: undefined });
check("backup no-ops without R2 (self-host safe)", bk.ok === false && bk.error.includes("R2"));

// 6. logged-out guard
const guard = await req("/vault", { redirect: "manual" });
check("logged-out vault redirects", guard.status === 302);

process.exit(failures ? 1 : 0);
