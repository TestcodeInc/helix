// UX smoke for the non-MCP routes: runs src/app.ts under Node with a mock KV.
//
// The bundle at /tmp/helix-app.mjs is built by `npm test`. Run this file
// directly and it will refuse to use a bundle older than src/ — a stale
// bundle means the suite passes against code you no longer have, which is
// worse than no suite at all.
import { statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const BUNDLE = "/tmp/helix-app.mjs";
const BUILD = "npx esbuild src/app.ts --bundle --format=esm --platform=neutral --outfile=/tmp/helix-app.mjs";
{
  if (!existsSync(BUNDLE)) {
    console.error(`✗ no bundle at ${BUNDLE}. Build it:\n    ${BUILD}\n  (or just run: npm test)`);
    process.exit(1);
  }
  const newest = (dir) =>
    readdirSync(dir).reduce((max, name) => {
      const p = join(dir, name);
      const s = statSync(p);
      return Math.max(max, s.isDirectory() ? newest(p) : s.mtimeMs);
    }, 0);
  if (statSync(BUNDLE).mtimeMs < newest("src")) {
    console.error(`✗ ${BUNDLE} is older than src/ — rebuild before trusting this run:\n    ${BUILD}\n  (or just run: npm test)`);
    process.exit(1);
  }
}

const { default: app } = await import(BUNDLE);

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

// ---- import: the round trip -------------------------------------------
// Dave's own export, loaded into an empty vault (Erin), must reproduce it.
const daveExport = await (await req("/owner/export", { headers: { Authorization: `Bearer ${devTok}` } })).json();
check("export carries facts and a subject to test with", daveExport.subjects.length > 0);

const { entryId: eidNow2 } = await import("/tmp/helix-app.mjs");
const sha256hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
await kv.put("user:erin", JSON.stringify({ id: "erin", name: "Erin", email: "erin@test.dev", passHash: "unused", createdAt: new Date().toISOString() }));
const erinTok = "e".repeat(64);
await kv.put(`device:${await sha256hex(erinTok)}`, JSON.stringify({ userId: "erin", deviceName: "Erin's phone", createdAt: new Date().toISOString() }));

r = await jpost("/owner/import", daveExport, erinTok);
j = await r.json();
check("import reports what it loaded", j.facts > 0 && j.subjects === daveExport.subjects.length);
const erinVault = JSON.parse(store.get("vault:erin"));
const daveIdentity = daveExport.vault.identity.base;
check("imported facts land in the right category", daveIdentity.every((t) => erinVault.identity.base.includes(t)));
const erinSubjects = JSON.parse(store.get("subjectindex:erin"));
check("imported subject keeps name and species", erinSubjects[0].name === daveExport.subjects[0].name && erinSubjects[0].species === daveExport.subjects[0].species);
check("imported photos travel with the subject", erinSubjects[0].photoCount === daveExport.subjects[0].photos.length);

// Idempotence: the same file again must change nothing.
r = await jpost("/owner/import", daveExport, erinTok);
j = await r.json();
check("re-importing the same export is a no-op", j.facts === 0 && j.subjects === 0 && j.photos === 0);

// Refusals: history and grants don't travel, and they're explained.
const withHistory = { ...daveExport, audit: [{ at: new Date().toISOString(), client: "Elsewhere", action: "read", detail: "identity" }], connected_apps: [{ app: "Somewhere", scopes: ["identity"] }] };
r = await jpost("/owner/import", withHistory, erinTok);
j = await r.json();
check("a foreign audit log is refused, with a reason", j.notes.some((n) => n.includes("audit")));
check("foreign app grants are refused too", j.notes.some((n) => n.includes("connected app")));
check("the foreign audit didn't land", !JSON.parse(store.get("audit:erin")).some((e) => e.client === "Elsewhere"));
check("the import itself is audited", JSON.parse(store.get("audit:erin")).some((e) => e.action === "write" && e.detail.startsWith("imported")));

// Envelope validation.
r = await jpost("/owner/import", { format: "someone-elses/v3", vault: {} }, erinTok);
check("an unknown format is rejected", r.status === 400 && (await r.json()).error.includes("helix-export/v1"));
r = await jpost("/owner/import", { format: "helix-export/v1" }, erinTok);
check("a truncated export is rejected", r.status === 400);
r = await jpost("/owner/import", daveExport);
check("import requires a device token", r.status === 401);

// Marks must survive the round trip. Without this, moving vaults would
// quietly un-private everything the owner had hidden.
const daveVault = JSON.parse(store.get("vault:dave"));
const privateFact = daveVault.identity.base[0];
const privateId = eidNow2("identity", "base", privateFact);
await kv.put("labels:dave", JSON.stringify({ labels: { [privateId]: ["helix"] }, private: [privateId] }));
const marked = await (await req("/owner/export", { headers: { Authorization: `Bearer ${devTok}` } })).json();
check("export carries labels and private flags", marked.marks.private.includes(privateId) && marked.marks.labels[privateId][0] === "helix");
await kv.delete("labels:erin");
r = await jpost("/owner/import", marked, erinTok);
j = await r.json();
const erinMarks = JSON.parse(store.get("labels:erin"));
check("import re-applies the private flag", erinMarks.private.includes(privateId));
check("import re-applies labels", erinMarks.labels[privateId]?.[0] === "helix");
check("marks are counted in the result", j.marks > 0);
// Content-hash ids are the mechanism: same text, same category, same id.
check("a mark lands on the right entry in the new vault", JSON.parse(store.get("vault:erin")).identity.base.includes(privateFact));
// A mark for an entry that isn't here is dropped rather than stored as junk.
r = await jpost("/owner/import", { ...marked, marks: { labels: { zzzzzzz: ["ghost"] }, private: ["zzzzzzz"] } }, erinTok);
check("marks for absent entries are ignored", !JSON.parse(store.get("labels:erin")).private.includes("zzzzzzz"));
await kv.delete("labels:dave");

// Voice verification is a live ceremony — it must not travel in a file.
await kv.put("voice:dave", JSON.stringify({ takes: [{ id: "t1", style: "phrase", mime: "audio/mp4", b64: "YXVkaW8=", isPhrase: true, recordedAt: new Date().toISOString() }], phrase: { text: "x", issuedAt: new Date().toISOString() }, verifiedAt: new Date().toISOString() }));
const voiced = await (await req("/owner/export", { headers: { Authorization: `Bearer ${devTok}` } })).json();
r = await jpost("/owner/import", voiced, erinTok);
j = await r.json();
check("voice takes import", j.takes === 1);
const erinVoice = JSON.parse(store.get("voice:erin"));
check("but verification does not travel", !erinVoice.verifiedAt && erinVoice.takes.every((t) => t.isPhrase === false));
check("and the reason is explained", j.notes.some((n) => n.includes("verified")));
await kv.delete("voice:dave"); // put Dave back as the voice section expects to find him

// The web door: same importer, reached with a file upload.
const upload = async (name, body, cookie = dcookie) => {
  const fd = new FormData();
  fd.append("file", new File([body], name, { type: "application/json" }));
  return req("/account/import", { method: "POST", headers: { Cookie: cookie }, body: fd });
};
r = await upload("notjson.json", "this is not json");
check("web import explains bad JSON in plain language", r.status === 400 && (await r.text()).includes("isn't valid JSON"));
r = await upload("vault.json", JSON.stringify(daveExport));
check("web import merges and reports", r.status === 200 && (await r.text()).includes("Import complete"));
const accountHtml = await (await req("/account", { headers: { Cookie: dcookie } })).text();
check("account page offers import", accountHtml.includes("/account/import") && accountHtml.includes("merges"));

// Seeded rather than assumed: without this the assertion silently depends on
// the REST section above, which the open build doesn't have.
await kv.put("audit:dave", JSON.stringify([
  { at: new Date().toISOString(), client: "Test", action: "read", detail: "identity" },
]));
r = await req("/owner/audit", { headers: { Authorization: `Bearer ${devTok}` } });
j = await r.json();
check("owner audit returns entries", Array.isArray(j.audit) && j.audit.length > 0);
// The apps decode `chain.status` as a non-optional string. Shipping the raw
// internal shape broke the whole response, list included — found on a real
// phone, so the contract gets asserted here from now on.
check("the chain verdict has the status string clients decode", typeof j.chain?.status === "string");
check("and a verified count", typeof j.chain?.verified === "number");
check("a log with no chained entries reads as unverified, not intact", j.chain.status === "unverified");
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

// 13b. private + labels over the owner door.
//
// These exist because the iOS app called three owner routes that were never
// built, and nothing here noticed. The point of this block is less to test
// the behaviour than to make the *absence* of a route fail the suite: every
// endpoint the app calls now has an assertion, so the next one that drifts
// shows up here rather than in App Review.
await jpost("/owner/vault/add", { category: "work", text: "Entry to garden" }, vTok);
j = await (await req("/owner/vault", { headers: { Authorization: `Bearer ${vTok}` } })).json();
const gardenId = j.categories.find((cAt) => cAt.key === "work").base.find((e) => e.text === "Entry to garden").id;

r = await jpost("/owner/vault/private", { id: gardenId, private: true }, vTok);
check("owner marks an entry private", r.status === 200 && (await r.json()).private === true);
check("private flag lands in the sidecar", JSON.parse(store.get("labels:dave")).private.includes(gardenId));

// Round trip. The write worked from day one; GET /owner/vault didn't return
// the sidecar, so the app set a flag it could never see again and the switch
// sprang back on reload. A control you can set but not read is worse than no
// control. Assert the flag comes home.
j = await (await req("/owner/vault", { headers: { Authorization: `Bearer ${vTok}` } })).json();
const gardenBack = () =>
  j.categories.find((cAt) => cAt.key === "work").base.find((e) => e.id === gardenId);
check("GET /owner/vault reports the private flag", gardenBack()?.priv === true);
await jpost("/owner/vault/labels", { id: gardenId, labels: ["clinic"] }, vTok);
j = await (await req("/owner/vault", { headers: { Authorization: `Bearer ${vTok}` } })).json();
check("GET /owner/vault reports labels", gardenBack()?.labels?.includes("clinic") === true);
check("entries with no marks still carry empty arrays, not undefined", Array.isArray(gardenBack()?.labels));

r = await jpost("/owner/vault/private", { id: gardenId, private: false }, vTok);
check("owner un-marks private", (await r.json()).private === false);
check("un-marking clears the sidecar", !JSON.parse(store.get("labels:dave")).private.includes(gardenId));

r = await jpost("/owner/vault/private", { id: "zzzzzzz", private: true }, vTok);
check("private on a missing entry is 404, not a silent flag", r.status === 404);
r = await jpost("/owner/vault/private", { id: gardenId }, vTok);
check("private requires a boolean", r.status === 400);
r = await jpost("/owner/vault/private", { id: gardenId, private: true });
check("private needs the owner token", r.status === 401);

// setLabels normalises and caps at MAX_LABELS_PER_ENTRY (6); the response
// must report what stuck, not what was asked for.
r = await jpost("/owner/vault/labels", { id: gardenId, labels: ["Work Stuff", "work stuff", "  ", "a", "b", "c", "d", "e"] }, vTok);
j = await r.json();
check("owner labels an entry", r.status === 200 && j.ok === true);
check("labels are normalised and deduped", j.labels.length <= 6 && new Set(j.labels).size === j.labels.length);
check("labels land in the sidecar", (JSON.parse(store.get("labels:dave")).labels[gardenId] ?? []).length === j.labels.length);

r = await jpost("/owner/vault/labels", { id: gardenId, labels: [] }, vTok);
check("empty labels clears the entry", (await r.json()).labels.length === 0);
r = await jpost("/owner/vault/labels", { id: "zzzzzzz", labels: ["x"] }, vTok);
check("labels on a missing entry is 404", r.status === 404);
r = await jpost("/owner/vault/labels", { id: gardenId, labels: "not-an-array" }, vTok);
check("labels must be an array", r.status === 400);

// Both actions are audited: an entry becoming visible again is exactly the
// event an owner would go looking for later.
const gardenAudit = JSON.parse(store.get("audit:dave"));
check("marking private is audited", gardenAudit.some((a) => a.detail.includes("marked a work entry private")));
check("un-marking private says it became readable", gardenAudit.some((a) => a.detail.includes("can now read it")));
check("labelling is audited", gardenAudit.some((a) => a.detail.startsWith("labelled a work entry")));
await jpost("/owner/vault/delete", { id: gardenId }, vTok);

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
await kv.put("labels:dave", JSON.stringify({ labels: { abc: ["helix"] }, private: ["abc"] }));
r = await post("/account/delete", { passphrase: "wrong-passphrase" }, dcookie);
check("delete requires the right passphrase", r.status === 401 && !!store.get("user:dave"));
r = await post("/account/delete", { passphrase: "brand-new-passphrase" }, dcookie);
check("delete needs the CURRENT passphrase (dave's is unchanged)", r.status === 401);
r = await post("/account/delete", { passphrase: "dave-pass-123" }, dcookie);
check("self-serve delete wipes the account", r.status === 200 && !store.get("user:dave") && !store.get("vault:dave") && !store.get("subjectindex:dave") && !store.get("voice:dave"));
check("delete leaves no label residue either", !store.get("labels:dave"));

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

// 17b. label narrowing on the consent screen
const invite2 = await post("/admin", { name: "Fay", email: "fay@test.dev", userId: "fay" }, acookie);
const fayToken = (await invite2.text()).match(/id="invite">([^<]+)</)[1].split("/invite/")[1];
const fcookie = cookieOf(await post(`/invite/${fayToken}`, { passphrase: "fay-pass-1234", passphrase2: "fay-pass-1234" }));
const fayVault = JSON.parse(store.get("vault:fay"));
const fayFirst = fayVault.identity.base[0];
const { entryId: eidNow } = await import("/tmp/helix-app.mjs");
await kv.put("labels:fay", JSON.stringify({ labels: { [eidNow("identity", "base", fayFirst)]: ["helix"] }, private: [] }));

aHtml = await (await req(authUrl("identity"), { headers: { Cookie: fcookie } })).text();
check("signed-in consent offers the labels in use", aHtml.includes('name="labels" value="helix"') && aHtml.includes("Limit this app to certain labels"));
check("consent warns unlabelled entries go dark", aHtml.includes("becomes invisible"));
const anonHtml = await (await req(authUrl("identity"))).text();
check("signed-out consent offers no label narrowing", !anonHtml.includes('name="labels"'));

let granted = null;
env.OAUTH_PROVIDER.completeAuthorization = async (args) => { granted = args; return { redirectTo: "http://localhost:9999/cb?code=1" }; };
await post("/authorize", { oauthreq: btoa(JSON.stringify({ clientId: "x" })), client_name: "Dog Photobooth", email: "fay@test.dev", passphrase: "fay-pass-1234", scopes: "identity", labels: "helix" }, fcookie);
check("the grant carries the label restriction in props", granted?.props?.labels?.[0] === "helix");
check("and in metadata, so /connections can show it", granted?.metadata?.labels?.[0] === "helix");
await post("/authorize", { oauthreq: btoa(JSON.stringify({ clientId: "x" })), client_name: "Dog Photobooth", email: "fay@test.dev", passphrase: "fay-pass-1234", scopes: "identity" }, fcookie);
check("no labels chosen means an unrestricted grant", Array.isArray(granted.props.labels) && granted.props.labels.length === 0);
// Reconnecting must REPLACE, not accumulate. Apps that disconnect on their
// own side never tell us, and dynamic client registration means a reconnect
// arrives with a new client_id — so without this the connections page lists
// the same app several times.
const revoked = [];
env.OAUTH_PROVIDER.revokeGrant = async (id) => { revoked.push(id); };
env.OAUTH_PROVIDER.listUserGrants = async () => ({
  items: [
    { id: "old-same-id", clientId: "x", scope: ["identity"], metadata: { label: "Dog Photobooth → fay@test.dev" } },
    { id: "old-same-name", clientId: "different-after-reregister", scope: ["identity"], metadata: { label: "Dog Photobooth → fay@test.dev" } },
    { id: "keep-me", clientId: "zzz", scope: ["identity"], metadata: { label: "Some Other App → fay@test.dev" } },
  ],
});
await post("/authorize", { oauthreq: btoa(JSON.stringify({ clientId: "x" })), client_name: "Dog Photobooth", email: "fay@test.dev", passphrase: "fay-pass-1234", scopes: "identity" }, fcookie);
check("reconnecting revokes the grant with the same client id", revoked.includes("old-same-id"));
check("and the one that re-registered under a new id", revoked.includes("old-same-name"));
check("but leaves other apps alone", !revoked.includes("keep-me"));
check("the replacement is audited", JSON.parse(store.get("audit:fay")).some((e) => e.detail.includes("replacing 2 earlier grants")));
env.OAUTH_PROVIDER.revokeGrant = async () => {};

env.OAUTH_PROVIDER.listUserGrants = async () => ({ items: [{ id: "g1", clientId: "x", scope: ["identity"], metadata: { label: "Dog Photobooth → fay@test.dev", labels: ["helix"] } }] });
const connHtml3 = await (await req("/connections", { headers: { Cookie: fcookie } })).text();
check("connections shows what the app is limited to", connHtml3.includes("limited to") && connHtml3.includes(">helix<"));
env.OAUTH_PROVIDER.listUserGrants = async () => ({ items: [] });

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

// ---- labels: the narrowing rules ---------------------------------------
// These decide what an app can see, so they get tested as logic, not as HTML.
const { labels: L, entryId: eid } = await import("/tmp/helix-app.mjs");
const lv = {
  identity: { base: ["Name: Dave", "Secret: has a tattoo"], learned: [] },
  work: { base: ["Founder"], learned: [{ fact: "Ships Helix", source: "Claude", date: "2026-08-01" }] },
  projects: { base: [], learned: [] },
  preferences: { base: [], learned: [] },
  relationships: { base: ["Tagged helix but personal"], learned: [] },
  "communication-style": { base: [], learned: [] },
};
const secretId = eid("identity", "base", "Secret: has a tattoo");
const shipsId = eid("work", "learned", "Ships Helix");
const crossId = eid("relationships", "base", "Tagged helix but personal");
const doc = { labels: { [shipsId]: ["helix"], [crossId]: ["helix"] }, private: [secretId] };

check("label normalising is strict", L.normalizeLabel("  Helix v0.7 ") === "helix-v0-7" && L.normalizeLabel("!!!") === null);

let seen = L.filterVault(lv, doc, {});
check("an unrestricted grant sees everything but private", seen.identity.base.length === 1 && seen.work.learned.length === 1);
check("private is withheld with no scope that can reveal it", !seen.identity.base.includes("Secret: has a tattoo"));

seen = L.filterVault(lv, doc, { grantLabels: ["helix"] });
check("a label-restricted grant sees only that label", seen.work.learned.length === 1 && seen.work.base.length === 0);
check("unlabelled entries are invisible to a restricted grant", seen.identity.base.length === 0);

// The escalation case: a `helix`-labelled entry lives in `relationships`
// too. An app granted only `work` must never receive it — the categories
// the caller passes are the ceiling, and labels only cut below it.
check(
  "a label cannot pull in a category the app wasn't granted",
  seen.work.learned.some((l) => l.fact === "Ships Helix") &&
    !["work", "identity", "projects", "preferences", "communication-style"].some((cat) =>
      seen[cat].base.includes("Tagged helix but personal"),
    ),
);

check("private stays hidden even when it carries the asked-for label", L.visibleTo({ labels: { [secretId]: ["helix"] }, private: [secretId] }, secretId, { askedLabels: ["helix"] }) === false);
check("asking for an unused label returns nothing", L.filterVault(lv, doc, { askedLabels: ["nope"] }).work.learned.length === 0);
check("the index counts only what the grant can see", JSON.stringify(L.labelIndex(lv, doc, ["work"])) === JSON.stringify([{ label: "helix", count: 1 }]));

// Editing an entry must carry its marks to the new id, or a typo fix
// silently un-privates it.
await kv.put("labels:dave", JSON.stringify({ labels: { abc1234: ["helix"] }, private: ["abc1234"] }));
await L.relabelEntry(kv, "dave", "abc1234", "def5678");
const moved = JSON.parse(store.get("labels:dave"));
check("edits carry labels to the new id", moved.labels.def5678?.[0] === "helix" && !moved.labels.abc1234);
check("edits carry the private flag too", moved.private.includes("def5678") && !moved.private.includes("abc1234"));
await kv.delete("labels:dave");

// ---- labels through the review queue -----------------------------------
// Tagging changes what apps can see, so it goes through approval like
// everything else an app wants.
const fVault = JSON.parse(store.get("vault:fay"));
const fFact = fVault.identity.base[0];
const fId = eidNow("identity", "base", fFact);
await kv.put("labels:fay", JSON.stringify({ labels: {}, private: [] }));
await kv.put("pending:fay", JSON.stringify([
  { id: "lb1", kind: "labels", category: "identity", fact: "Tag as helix", source: "conversation", client: "Claude", proposedAt: new Date().toISOString(), labels: ["helix"], targetId: fId, targetText: fFact },
]));
const reviewHtml2 = await (await req("/review", { headers: { Cookie: fcookie } })).text();
check("review reads a label proposal differently from a fact", reviewHtml2.includes("Tag an entry") && reviewHtml2.includes(">helix<"));
check("review explains what a label does", reviewHtml2.includes("this slice and nothing else"));
await post("/review/decide", { id: "lb1", action: "approve" }, fcookie);
check("approving a label proposal tags the entry", JSON.parse(store.get("labels:fay")).labels[fId]?.[0] === "helix");
check("and it leaves the text alone", JSON.parse(store.get("vault:fay")).identity.base[0] === fFact);

await kv.put("pending:fay", JSON.stringify([
  { id: "lb2", kind: "labels", category: "identity", fact: "Tag as private-stuff", source: "conversation", client: "Claude", proposedAt: new Date().toISOString(), labels: ["nope"], targetId: fId, targetText: fFact },
]));
await post("/review/decide", { id: "lb2", action: "reject" }, fcookie);
check("rejecting a label proposal changes nothing", !JSON.parse(store.get("labels:fay")).labels[fId].includes("nope"));

// A fact proposed with labels carries them through approval.
await kv.put("pending:fay", JSON.stringify([
  { id: "f9", category: "work", fact: "Ships Helix v0.7", source: "conversation", client: "Claude", proposedAt: new Date().toISOString(), labels: ["helix"] },
]));
await post("/review/decide", { id: "f9", action: "approve" }, fcookie);
check("an approved fact keeps the labels it was proposed with", JSON.parse(store.get("labels:fay")).labels[eidNow("work", "learned", "Ships Helix v0.7")]?.[0] === "helix");

// ---- the speech provider is disclosed, both places ---------------------
// Found by reading a real audit entry: image generation named its provider,
// speech didn't — and the consent screen claimed recordings are "never
// shared" when they do reach the speech provider.
const voiceConsent = await (await req(authUrl("likeness:voice"))).text();
check("consent names the speech provider", voiceConsent.includes("ElevenLabs"));
check("consent no longer claims recordings are never shared", !voiceConsent.includes("recordings are never shared"));
check("consent still promises the app never gets them", voiceConsent.includes("app never receives your recordings"));

// ---- provider failures are explained, not dumped -----------------------
// Found by running generate_speech against production: a free ElevenLabs
// plan can't clone voices, and the user saw raw provider JSON for a problem
// only the operator can fix.
const { compileErrorForTest } = await import("/tmp/helix-app.mjs");
const billing = compileErrorForTest(400, '{"detail":{"type":"payment_required","code":"paid_plan_required"}}');
check("a billing failure is named as the operator's problem", billing.includes("isn't something you can fix"));
check("and reassures the owner their recordings are fine", billing.includes("Nothing is wrong with your recordings"));
check("no raw provider JSON reaches the user", !billing.includes("paid_plan_required"));
check("bad credentials read as configuration, not user error", compileErrorForTest(401, "unauthorized").includes("configuration problem"));
check("rate limiting suggests waiting", compileErrorForTest(429, "slow down").includes("few minutes"));
check("short recordings are the one the owner CAN fix", compileErrorForTest(400, "voice_too_short").includes("/voice"));

// ---- vaults survive a new category being added -------------------------
// Categories are OAuth scopes, so they get added over time. A vault written
// before that has no key for the new one, and vault[newCat].base would throw
// on the next read. This is what makes adding a category a one-line change.
const { normalizeVault } = await import("/tmp/helix-app.mjs");
const old = { identity: { base: ["Name: Fay"], learned: [] } };
const filled = normalizeVault(old);
check("a missing category is filled in, not crashed on", Array.isArray(filled.work.base) && filled.work.base.length === 0);
check("existing content is untouched", filled.identity.base[0] === "Name: Fay");
check("a malformed section is repaired", Array.isArray(normalizeVault({ work: { base: "not an array" } }).work.base));
check("an empty vault normalises rather than throwing", Object.keys(normalizeVault(null)).length === 6);
// A vault from a newer version keeps its unknown categories on a round trip.
const future = normalizeVault({ identity: { base: [], learned: [] }, health: { base: ["Allergic to penicillin"], learned: [] } });
check("categories from a newer version aren't destroyed", future.health.base[0] === "Allergic to penicillin");

// An old-shaped vault must survive the real read paths, not just the helper.
await kv.put("vault:fay", JSON.stringify({ identity: { base: ["Name: Fay"], learned: [] } }));
const oldShape = await req("/vault", { headers: { Cookie: fcookie } });
check("the vault page renders an old-shaped vault", oldShape.status === 200);
const oldPreview = await (await req("/vault/preview", { headers: { Cookie: fcookie } })).text();
check("and so does what an app would see", oldPreview.includes("# work"));

// ---- double-clicking Approve ------------------------------------------
// KV is eventually consistent, so two clicks a moment apart can both read a
// pending list that still holds the item. Seen in production as one proposal
// with two approvals in the audit log.
await kv.put("vault:fay", JSON.stringify({
  identity: { base: [], learned: [] }, work: { base: [], learned: [] },
  projects: { base: [], learned: [] }, preferences: { base: [], learned: [] },
  relationships: { base: [], learned: [] }, "communication-style": { base: [], learned: [] },
}));
const dupe = { id: "dup1", category: "relationships", fact: "Fostering two puppies, Mochi and Nuri.", source: "s", client: "Claude", proposedAt: new Date().toISOString() };
await kv.put("pending:fay", JSON.stringify([dupe]));
const reviewForm = await (await req("/review", { headers: { Cookie: fcookie } })).text();
check("the form guards against a second submit", reviewForm.includes("dataset.sent"));
await post("/review/decide", { id: "dup1", action: "approve" }, fcookie);
// Simulate the stale read: the item is back in the list, as KV would serve it.
await kv.put("pending:fay", JSON.stringify([dupe]));
await post("/review/decide", { id: "dup1", action: "approve" }, fcookie);
const dupeVault = JSON.parse(store.get("vault:fay"));
check("approving twice adds the fact only once", dupeVault.relationships.learned.filter((l) => l.fact === dupe.fact).length === 1);

// ---- pairing a phone from an authenticated session ---------------------
// The passphrase never reaches the second device: the web session mints a
// short-lived, single-use code, and the phone trades it for a device token.
const pairHtml = await (await req("/connections/pair", { headers: { Cookie: fcookie } })).text();
const pairCode = (pairHtml.match(/letter-spacing:\.22em;margin:0">([A-Z0-9]{8})</) ?? [])[1];
check("pair page mints a code", !!pairCode);
check("pair page renders a QR alongside it", pairHtml.includes("qrcode.min.js") && pairHtml.includes("/p/" + pairCode));
check("and says the passphrase stays put", pairHtml.includes("passphrase never leaves"));
check("pairing needs a session", (await req("/connections/pair", { redirect: "manual" })).status === 302);

let st = await (await req(`/connections/pair/status?code=${pairCode}`, { headers: { Cookie: fcookie } })).json();
check("a fresh code reads as waiting", st.status === "waiting");

const jsonPost = (path, obj, token) =>
  req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(obj),
  });

r = await jsonPost("/owner/device/claim", { code: "AAAAAAAA", deviceName: "Attacker" });
check("an unknown code is refused", r.status === 401);

r = await jsonPost("/owner/device/claim", { code: pairCode.toLowerCase(), deviceName: "Fay's iPhone" });
j = await r.json();
check("a valid code mints a device token", typeof j.token === "string" && j.token.length === 64);
check("case and spacing are forgiven", j.name === "Fay");
const pairedTok = j.token;

r = await jsonPost("/owner/device/claim", { code: pairCode, deviceName: "Second phone" });
check("a code works exactly once", r.status === 401);

// A scanner hands over whatever the QR encoded — a URL, not a bare code.
// Recovering it server-side means every client works, not just ours.
const { pairing: PAIR } = await import("/tmp/helix-app.mjs");
check("a scanned URL yields the code", PAIR.normalizeCode("https://vault.helix.ai/p/ABCD2345") === "ABCD2345");
check("a typed code still works", PAIR.normalizeCode("abcd 2345") === "ABCD2345");
check("look-alike characters are forgiven", PAIR.normalizeCode("ABCDO23I") === "ABCD0231");

const scan = await (await req("/connections/pair", { headers: { Cookie: fcookie } })).text();
const scanCode = (scan.match(/letter-spacing:\.22em;margin:0">([A-Z0-9]{8})</) ?? [])[1];
r = await jsonPost("/owner/device/claim", { code: `https://vault.helix.ai/p/${scanCode}`, deviceName: "Scanned phone" });
check("claiming with the scanned URL works end to end", r.status === 200 && typeof (await r.json()).token === "string");

st = await (await req(`/connections/pair/status?code=${pairCode}`, { headers: { Cookie: fcookie } })).json();
check("the web page learns it was claimed", st.status === "claimed" && st.name === "Fay's iPhone");

r = await req("/owner/pending", { headers: { Authorization: `Bearer ${pairedTok}` } });
check("the paired token actually works", r.status === 200);
const connAfterPair = await (await req("/connections", { headers: { Cookie: fcookie } })).text();
check("the paired device is listed and revocable", connAfterPair.includes("Fay&#39;s iPhone") || connAfterPair.includes("Fay's iPhone"));
check("pairing is written to the audit log", JSON.parse(store.get("audit:fay")).some((e) => e.detail.includes("paired a new device")));

// ---- the owner's own actions are audited too ---------------------------
// Found by dogfooding: approvals were never logged, so the audit trail
// recorded what apps asked for but not what was allowed.
await kv.delete("audit:fay");
await kv.delete("auditmeta:fay");
await kv.put("pending:fay", JSON.stringify([
  { id: "aud1", category: "work", fact: "Audited approval", source: "s", client: "Claude", proposedAt: new Date().toISOString() },
  { id: "aud2", category: "work", fact: "Audited rejection", source: "s", client: "Claude", proposedAt: new Date().toISOString() },
]));
await post("/review/decide", { id: "aud1", action: "approve" }, fcookie);
await post("/review/decide", { id: "aud2", action: "reject" }, fcookie);
let fayAudit = JSON.parse(store.get("audit:fay"));
check("approving is written to the audit log", fayAudit.some((e) => e.action === "write" && e.detail.startsWith("approved") && e.client === "You (web)"));
check("rejecting is logged too", fayAudit.some((e) => e.detail.startsWith("rejected")));
check("the log names which app proposed it", fayAudit.some((e) => e.detail.includes("proposed by Claude")));

await post("/vault/add", { category: "work", text: "Typed by hand" }, fcookie);
fayAudit = JSON.parse(store.get("audit:fay"));
check("the owner's own additions are logged", fayAudit.some((e) => e.detail.includes('added to work: "Typed by hand"')));
await post("/vault/update", { category: "work", list: "base", index: "0", action: "delete", text: "" }, fcookie);
fayAudit = JSON.parse(store.get("audit:fay"));
check("deletions are logged", fayAudit.some((e) => e.detail === "deleted a work entry"));
check("but a deleted entry's text is never echoed into the log", !fayAudit.some((e) => e.detail.includes("Typed by hand") && e.detail.startsWith("deleted")));
check("owner actions extend the same hash chain", (await (await import("/tmp/helix-app.mjs")).verifyAuditChain(fayAudit)).ok === true);

// ---- owner-side supersession -------------------------------------------
// A fact proposed and approved in one conversation never gets an id the AI
// can see, so the AI can't ask to replace it later. The owner has to be able
// to say so at review time instead.
await kv.put("vault:fay", JSON.stringify({
  identity: { base: ["Based in Atlanta, Georgia."], learned: [] },
  work: { base: [], learned: [] }, projects: { base: [], learned: [] },
  preferences: { base: [], learned: [] }, relationships: { base: [], learned: [] },
  "communication-style": { base: [], learned: [] },
}));
const atlantaId = eidNow("identity", "base", "Based in Atlanta, Georgia.");
await kv.put("pending:fay", JSON.stringify([
  { id: "geo1", category: "identity", fact: "Lives in Rome, Georgia.", source: "conversation", client: "Claude", proposedAt: new Date().toISOString() },
]));
const revHtml = await (await req("/review", { headers: { Cookie: fcookie } })).text();
check("review offers to replace an existing entry", revHtml.includes("Replace an existing entry with this?") && revHtml.includes(atlantaId));
check("and explains what replacing does", revHtml.includes("removed on approval"));
check("adding as new is the default option", revHtml.includes("Add it as a new entry"));

await post("/review/decide", { id: "geo1", action: "approve", replaces: atlantaId }, fcookie);
const fayGeo = JSON.parse(store.get("vault:fay"));
check("approving with a replacement removes the old entry", !fayGeo.identity.base.includes("Based in Atlanta, Georgia."));
check("and the correction lands", fayGeo.identity.learned.some((l) => l.fact === "Lives in Rome, Georgia."));

// Choosing nothing still just adds, and a stale id can't do damage.
await kv.put("pending:fay", JSON.stringify([
  { id: "geo2", category: "identity", fact: "Grew up in Ohio.", source: "conversation", client: "Claude", proposedAt: new Date().toISOString() },
]));
await post("/review/decide", { id: "geo2", action: "approve", replaces: "zzzzzzz" }, fcookie);
const fayGeo2 = JSON.parse(store.get("vault:fay"));
check("an unknown replaces id degrades to a plain add", fayGeo2.identity.learned.some((l) => l.fact === "Grew up in Ohio.") && fayGeo2.identity.learned.some((l) => l.fact === "Lives in Rome, Georgia."));

// ---- admin activity signal ---------------------------------------------
// Counts and timestamps only. The states matter more than the numbers:
// they're what tells James who to chase after an invite.
const { activity: ACT } = await import("/tmp/helix-app.mjs");
const ago = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

const blank = { pending: 0, oldestPendingDays: null, lastRead: null, lastCurated: null, labelled: 0, private: 0, devices: 0, images: { used: 0, limit: 20 }, speech: { used: 0, limit: 20 }, events: 0 };
check("a user who never connected reads as cold", ACT.activitySummary({ ...blank }).state === "cold" && ACT.activitySummary({ ...blank }).text.includes("never connected"));
check("events but no reads is still cold", ACT.activitySummary({ ...blank, events: 3 }).text.includes("no app has read"));
check("a week-old queue is stuck", ACT.activitySummary({ ...blank, events: 9, pending: 4, oldestPendingDays: 9, lastRead: { at: ago(1), client: "Claude" } }).state === "stuck");
check("and the rot is named, not just flagged", ACT.activitySummary({ ...blank, events: 9, pending: 4, oldestPendingDays: 9, lastRead: { at: ago(1), client: "Claude" } }).text.includes("rotting"));
check("a fresh queue is not stuck", ACT.activitySummary({ ...blank, events: 9, pending: 2, oldestPendingDays: 1, lastRead: { at: ago(0), client: "Claude" }, lastCurated: ago(1) }).state === "warm");
check("two weeks silent goes cold again", ACT.activitySummary({ ...blank, events: 9, lastRead: { at: ago(20), client: "ChatGPT" } }).state === "cold");
check("reading without ever approving is called out", ACT.activitySummary({ ...blank, events: 5, lastRead: { at: ago(1), client: "Claude" } }).text.includes("never approved"));

await kv.put("audit:fay", JSON.stringify([
  { at: ago(2), client: "Claude", action: "read", detail: "identity", seq: 2, hash: "h2", prev: "h1" },
  { at: ago(3), client: "Helix (owner)", action: "write", detail: "approved", seq: 1, hash: "h1", prev: "" },
]));
await kv.put("pending:fay", JSON.stringify([{ id: "p1", category: "work", fact: "x", source: "s", client: "Claude", proposedAt: ago(11) }]));
const act = await ACT.userActivity(env, "fay");
check("activity reads the real audit log", act.events === 2 && act.lastRead.client === "Claude");
check("it finds the oldest pending item", act.oldestPendingDays === 11);
check("it separates curation from reading", act.lastCurated?.startsWith(ago(3).slice(0, 10)));

const adminHtml2 = await (await req("/admin", { headers: { Cookie: acookie } })).text();
check("admin shows the activity line", adminHtml2.includes("queue is rotting"));
check("admin says what it does not show", adminHtml2.includes("never vault contents"));
check("admin never renders vault text", !adminHtml2.includes("Push test") && !adminHtml2.includes("Ships Helix"));
await kv.delete("pending:fay");

// ---- hash-chained audit -------------------------------------------------
const { verifyAuditChain, appendAudit } = await import("/tmp/helix-app.mjs");
await kv.delete("audit:chainy");
await kv.delete("auditmeta:chainy");
for (const d of ["identity", "work", "projects"]) {
  await appendAudit(kv, "chainy", { client: "Claude", action: "read", detail: d });
}
let chainLog = JSON.parse(store.get("audit:chainy"));
check("entries are numbered and hashed", chainLog.length === 3 && chainLog[0].seq === 3 && !!chainLog[0].hash);
check("each entry points at the one before it", chainLog[0].prev === chainLog[1].hash && chainLog[2].prev === "");
check("an untouched chain verifies", (await verifyAuditChain(chainLog)).ok === true);

// Tamper: edit an entry's detail after the fact.
let tampered = JSON.parse(JSON.stringify(chainLog));
tampered[1].detail = "identity, relationships";
let verdict = await verifyAuditChain(tampered);
check("editing an entry breaks the chain", verdict.ok === false && verdict.reason === "entry was altered");
check("and it names where", verdict.brokenAt === 2);

// Tamper: remove an entry from the middle.
tampered = chainLog.filter((e) => e.seq !== 2);
verdict = await verifyAuditChain(tampered);
check("removing an entry is detected", verdict.ok === false && verdict.reason === "an entry is missing");

// Tamper: rewrite an entry AND its hash — the chain still catches it,
// because the next entry's prev no longer matches.
tampered = JSON.parse(JSON.stringify(chainLog));
tampered[1].detail = "everything";
tampered[1].hash = await (await import("/tmp/helix-app.mjs")).auditHash({ at: tampered[1].at, client: tampered[1].client, action: tampered[1].action, detail: "everything", seq: 2, prev: tampered[1].prev });
verdict = await verifyAuditChain(tampered);
check("re-hashing a forged entry doesn't help — the next link fails", verdict.ok === false);

// Pre-chain entries are unproven, not broken.
check("entries written before the chain are reported as unchecked", (await verifyAuditChain([{ at: "2026-01-01T00:00:00Z", client: "Old", action: "read", detail: "identity" }])).checked === 0);
check("an empty log verifies trivially", (await verifyAuditChain([])).ok === true);

// Frozen test vector for the canonical string.
//
// The fields are joined by U+001F, which is non-printing: the source reads
// `.join("")` in every editor and terminal that doesn't reveal control codes.
// A seed script reimplemented this "from the spec", got plain concatenation,
// and produced a log the server rejected. The published spec had the same
// omission, so it was inviting the mistake.
//
// The real danger is the other direction. Someone tidying that line into what
// it appears to say would invalidate every hash ever written — every existing
// user's audit page would read "Chain broken", on a screen whose whole job is
// to be believed. This assertion is the tripwire. If it fails, do not fix the
// test.
const { auditHash: AH } = await import("/tmp/helix-app.mjs");
check(
  "the audit canonical string is separator-joined (frozen vector)",
  (await AH({
    at: "2026-07-27T09:16:00.000Z",
    client: "You (web)",
    action: "write",
    detail: "created the vault",
    seq: 1,
    prev: "",
  })) === "0f00a168235b4fc4ebc52dd079f3737ee06b6a9343e13286d368f23f9abe151a",
);

// The owner's screens say so.
await kv.put("audit:fay", JSON.stringify(chainLog));
const auditHtml2 = await (await req("/audit", { headers: { Cookie: fcookie } })).text();
check("audit page reports the chain intact", auditHtml2.includes("Chain intact"));
check("and doesn't overclaim about deletion", auditHtml2.includes("deleted wholesale"));
await kv.put("audit:fay", JSON.stringify(tampered));
const auditHtml3 = await (await req("/audit", { headers: { Cookie: fcookie } })).text();
check("a broken chain is stated plainly", auditHtml3.includes("Chain broken at entry"));

// ---- tools/list_changed: announce only on a real change ----------------
const { toolsig: TS } = await import("/tmp/helix-app.mjs");
const sigA = TS.toolSignature(2, ["work", "identity", "propose"]);
check("the signature ignores scope order", sigA === TS.toolSignature(2, ["propose", "identity", "work"]));
check("a new toolset version is a new signature", sigA !== TS.toolSignature(3, ["work", "identity", "propose"]));
check("different scopes are a different signature", sigA !== TS.toolSignature(2, ["work"]));
check("a first-ever session announces nothing", TS.shouldAnnounce(undefined, sigA) === false);
check("an unchanged session announces nothing", TS.shouldAnnounce(sigA, sigA) === false);
check("a deploy that changes the toolset announces", TS.shouldAnnounce(TS.toolSignature(1, ["work"]), TS.toolSignature(2, ["work"])) === true);

// ---- owner-door vault destroy -------------------------------------------
//
// Last, and on a throwaway account, because it really does delete everything.
// App Store guideline 5.1.1(v) requires account deletion to be reachable in
// the app, so a reviewer WILL run this path. It shipped missing once.
await post("/signup", { name: "Zoe Gone", email: "zoe@test.dev", passphrase: "correct-horse-battery", passphrase2: "correct-horse-battery" });
const zoeVerify = [...store.keys()].filter((k) => k.startsWith("verify:")).pop().slice("verify:".length);
await req(`/verify/${zoeVerify}`, { redirect: "manual" });
const zoeId = await kv.get("useremail:zoe@test.dev");
r = await jpost("/owner/login", { email: "zoe@test.dev", passphrase: "correct-horse-battery", deviceName: "Zoe's iPhone" });
const zTok = (await r.json()).token;
await jpost("/owner/vault/add", { category: "work", text: "Something to lose" }, zTok);

r = await jpost("/owner/vault/destroy", { confirm: "yes" }, zTok);
check("destroy refuses anything but the exact word", r.status === 400);
check("and refusing left the vault alone", !!store.get(`vault:${zoeId}`));
r = await jpost("/owner/vault/destroy", { confirm: "DELETE" });
check("destroy needs the owner token", r.status === 401);

r = await jpost("/owner/vault/destroy", { confirm: "DELETE" }, zTok);
check("owner destroys the vault from a paired device", r.status === 200 && (await r.json()).ok === true);
check("the vault is gone", !store.get(`vault:${zoeId}`));
check("the user record is gone", !store.get(`user:${zoeId}`));
check("the email index is gone, so the address is free again", !store.get("useremail:zoe@test.dev"));
check("the audit log is gone", !store.get(`audit:${zoeId}`));

// The token was minted against a user that no longer exists. It must stop
// working — a device that outlives its vault would be a live credential
// pointing at nothing, and the next signup on that email would inherit it.
r = await req("/owner/vault", { headers: { Authorization: `Bearer ${zTok}` } });
check("the paired device's token dies with the vault", r.status === 401);

// Deleting twice is not an error. The caller asked for a state, not an action.
r = await jpost("/owner/vault/destroy", { confirm: "DELETE" }, zTok);
check("destroying an already-destroyed vault is unauthorized, not a crash", r.status === 401);

// 6. logged-out guard
const guard = await req("/vault", { redirect: "manual" });
check("logged-out vault redirects", guard.status === 302);

process.exit(failures ? 1 : 0);
