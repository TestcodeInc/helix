# Helix — the vault

*AI knows everything. Helix knows you.*

A portable, user-owned context vault, exposed as a remote MCP server on
Cloudflare Workers. Any MCP client connects over OAuth 2.1 (self-issued,
dynamic client registration, PKCE). Every grant is scoped per vault
category, every read is audit-logged, and every fact an AI proposes goes
through the owner's review queue before it exists.

**Hosted:** [vault.helix.ai](https://vault.helix.ai) ·
**Docs:** [helix.ai/docs](https://helix.ai/docs) ·
**Spec:** [helix.ai/docs/spec](https://helix.ai/docs/spec)

## What's open and what isn't

Single-player open, multiplayer commercial.

Open (AGPL-3.0): the vault, the MCP server, the consent and audit screens,
the owner door, the iOS and Android apps. Everything one person needs to
own their context by themselves. Clone it and it's yours, forever.

Not open: the developer platform — the third-party app door (`/api/*`),
app registration, billing and the partner console. Building a business on
other people's vaults runs through the hosted service, and that is how
Helix pays for itself.

Self-hosting guide: [helix.ai/docs/self-host](https://helix.ai/docs/self-host).

### Publishing the open repo

This repo is private and is the source of truth — you develop here and deploy
from here. The public repo is generated from it:

```sh
npm run publish-open -- ../helix --commit
```

The script exports the tracked tree, drops `src/api.ts`, removes every region
marked `COMMERCIAL-ONLY-START` … `COMMERCIAL-ONLY-END`, and refuses to write
anything if a stray `./api` import survived. It never pushes — review the diff
first. **If you add code that touches the app door, wrap it in those markers**,
or the next publish will stop and tell you.

## Layout

| File | What it does |
| --- | --- |
| `index.ts` | MCP server (`McpAgent` Durable Object), tool registration, OAuth wiring, cron entry |
| `app.ts` | Everything with a UI: signup, vault editor, review, audit, connections, account, admin, policies |
| `api.ts` | REST app door — *commercial; excluded from the public repo* |
| `auth.ts` | Passphrase hashing (PBKDF2-SHA256), signed session cookies |
| `users.ts` | Accounts, invites, verification |
| `vault.ts` | Facts: six categories, content-addressed entry ids, supersession |
| `subjects.ts` | Likeness: subjects, photos, thumbnails. Source photos never cross the app door |
| `voice.ts` | Voice takes, live-phrase verification, provider voice compilation |
| `devices.ts` | Owner-door device tokens (hashed) and APNs registration |
| `pairing.ts` | Short-lived single-use codes so a phone can be paired without typing the passphrase |
| `usage.ts` | Monthly generation caps; per-user overrides in KV |
| `ratelimit.ts` | IP buckets and Turnstile |
| `email.ts` | Transactional mail (Resend); optional |
| `importer.ts` | Loads a `helix-export/v1` document back in: merge-only, idempotent, refuses to import history |
| `labels.ts` | Labels and the private flag — the one place that decides what an app may see |
| `backup.ts` | Nightly KV → R2 dump, 30-day retention (restore via `scripts/restore.mjs`) |
| `push.ts` | APNs (ES256 via WebCrypto) |

## Develop

```sh
npm install
npm start          # wrangler dev
npm run typecheck  # tsc --noEmit
npm test           # bundle src/app.ts, then run it against a mocked KV
```

`npm test` bundles `src/app.ts` with esbuild and drives it under Node with
an in-memory KV — no network, no Cloudflare. It's the fastest way to know
you haven't broken a flow; add an assertion with every behaviour change.
Running `node uxtest.mjs` on its own is fine, but it refuses to start
against a bundle older than `src/` rather than pass you a stale result.

## Deploy

```sh
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create VAULT_KV
npx wrangler secret put COOKIE_SECRET
npx wrangler deploy
```

Then set `PUBLIC_ORIGIN` in `wrangler.jsonc` to the deployed origin and
deploy again — OAuth discovery metadata is absolute, and a wrong origin
fails the handshake in ways that are tedious to debug.

Optional secrets — omit any and that feature stays off:
`OPENAI_API_KEY` (images), `ELEVENLABS_API_KEY` (speech),
`RESEND_API_KEY` (email), `TURNSTILE_SECRET_KEY`, `ADMIN_PASSWORD`.

## The invariants

An implementation that breaks one of these isn't Helix:

- Apps never write facts directly — proposals go to the owner's queue. So do
  labels, because labels decide what other apps can see.
- Labels only ever narrow. A label-restricted grant sees the intersection of
  its categories and its labels, never a category it wasn't granted.
- Private entries leave through no app door, whatever was granted.
- Source media never crosses the app door.
- Every read, proposal, write and generation is logged where the owner
  can see it, in a hash-chained log that shows if an entry was altered.
- Revocation takes effect immediately, including mid-session.
- Generation names its downstream provider on the consent screen and in
  the audit entry.
- The owner can export everything, import it elsewhere, and delete
  everything — alone.
- History doesn't travel. An imported audit log is refused: the log records
  what this server did, and a document must not be able to dictate that.

## Licence

Copyright © 2026 James Rhodes. Licensed under AGPL-3.0-only; see `LICENSE`.

Running a vault for yourself, your family or your company triggers no
obligation. Running a *modified* Helix as a service for other people means
those people are entitled to your modified source — which is the point:
nobody gets to quietly remove the audit log or the consent gate and still
call it Helix.

Spec text at `helix.ai/docs/spec` is CC BY 4.0.
