import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  VAULT_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  /** Optional: nightly vault backups land here. Absent on self-hosted
   * instances that haven't set up R2 — backup simply no-ops. */
  BACKUPS?: R2Bucket;
  /** Secret: admin passphrase for creating invites at /admin. */
  ADMIN_SECRET: string;
  /** Secret: random string used to sign session cookies. */
  COOKIE_SECRET: string;
  /** Secret (optional): enables /api/generate via OpenAI images. */
  OPENAI_API_KEY?: string;
  /** Public origin for building short-lived image links (wrangler var). */
  PUBLIC_ORIGIN?: string;
  /** Free-tier generation caps per user per month (wrangler vars).
   * -1 means unlimited; per-user overrides live in KV. */
  FREE_IMAGES_PER_MONTH?: string;
  FREE_SPEECH_PER_MONTH?: string;
  /** Secret (optional): transactional email via Resend. Without it,
   * self-serve signup shows the verification link on screen instead. */
  RESEND_API_KEY?: string;
  /** Var (optional): From header for transactional mail. */
  EMAIL_FROM?: string;
  /** Cloudflare Turnstile (optional — unconfigured means no challenge,
   * which is what self-hosted and local dev want). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Secret (optional): enables voice synthesis via ElevenLabs. */
  ELEVENLABS_API_KEY?: string;
  /** APNs push (all optional — push no-ops without them). */
  APNS_PRIVATE_KEY?: string; // secret: contents of the .p8 key file
  APNS_KEY_ID?: string; // secret: the key's 10-char id
  APNS_TEAM_ID?: string; // secret: Apple developer team id
  APNS_BUNDLE_ID?: string; // var: the iOS app's bundle identifier
  APNS_ENV?: string; // var: "sandbox" (default) | "production"
  /** Injected by workers-oauth-provider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Auth context attached to every MCP session token. */
export interface HelixProps extends Record<string, unknown> {
  userId: string;
  email: string;
  clientName: string;
  scopes: string[];
}
