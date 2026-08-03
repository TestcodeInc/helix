#!/usr/bin/env node
/**
 * Restore keys from a Helix backup into Workers KV.
 *
 * A backup nobody has restored is a file, not a backup. This is the other
 * half — and it is deliberately a local script rather than an admin button,
 * because the failure mode of a mis-click here is overwriting live vaults.
 *
 * Defaults are the cautious ones:
 *   - dry run unless you pass --write
 *   - skips keys that already exist unless you pass --overwrite
 *   - can be narrowed to a single user, which is the realistic disaster
 *     ("Dave deleted his vault by accident"), not the theatrical one
 *
 * Usage:
 *   npx wrangler r2 object get helix-storage/backups/2026-08-03.json \
 *     --remote --file /tmp/backup.json
 *
 *   node scripts/restore.mjs /tmp/backup.json                  # dry run, everything
 *   node scripts/restore.mjs /tmp/backup.json --user dave      # dry run, one user
 *   node scripts/restore.mjs /tmp/backup.json --user dave --write
 *   node scripts/restore.mjs /tmp/backup.json --user dave --write --overwrite
 *
 * Reads and writes go through `wrangler kv key`, so it uses whatever
 * credentials your wrangler session already has.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

if (!file) {
  console.error("usage: node scripts/restore.mjs <backup.json> [--user <id>] [--write] [--overwrite]");
  process.exit(1);
}

const BINDING = "VAULT_KV";
const write = flag("write");
const overwrite = flag("overwrite");
const onlyUser = value("user");

const backup = JSON.parse(readFileSync(resolve(file), "utf8"));
if (backup.format !== "helix-backup/v1") {
  console.error(`✗ not a Helix backup (format: ${JSON.stringify(backup.format)})`);
  process.exit(1);
}

/**
 * Every key shape that belongs to one user. Keep in step with purgeUser.
 *
 * Note `useremail:<email>` — it is keyed by EMAIL, not by user id, so it
 * can't be matched by name. It's matched by value below. Miss it and the
 * restored account exists but cannot be signed into, because the login
 * lookup has nothing to resolve. (Found the hard way, during a rehearsal,
 * which is the argument for rehearsing.)
 */
const belongsTo = (key, val, user) =>
  (key.startsWith("useremail:") && val === user) ||
  [
    `vault:${user}`,
    `pending:${user}`,
    `audit:${user}`,
    `auditmeta:${user}`,
    `labels:${user}`,
    `user:${user}`,
    `subjectindex:${user}`,
    `voice:${user}`,
    `devices:${user}`,
    `limits:${user}`,
  ].includes(key) ||
  key.startsWith(`subject:${user}:`) ||
  key.startsWith(`usage:${user}:`);

const all = Object.entries(backup.keys ?? {});
const selected = onlyUser ? all.filter(([k, v]) => belongsTo(k, v, onlyUser)) : all;

if (onlyUser && !selected.some(([k]) => k.startsWith("useremail:"))) {
  console.warn(
    `⚠ no useremail: key for "${onlyUser}" in this backup — the restored account may not be able to sign in.\n`,
  );
}

if (!selected.length) {
  console.error(onlyUser ? `✗ nothing in this backup for user "${onlyUser}"` : "✗ backup is empty");
  process.exit(1);
}

console.log(`${backup.format} taken ${backup.taken_at} · ${all.length} keys`);
console.log(`restoring ${selected.length}${onlyUser ? ` for user "${onlyUser}"` : ""}${write ? "" : "  (DRY RUN)"}\n`);

const wrangler = (cmdArgs) =>
  execFileSync("npx", ["wrangler", ...cmdArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const exists = (key) => {
  try {
    wrangler(["kv", "key", "get", key, "--binding", BINDING, "--remote"]);
    return true;
  } catch {
    return false; // wrangler exits non-zero when the key is absent
  }
};

const staging = mkdtempSync(join(tmpdir(), "helix-restore-"));
let written = 0;
let skipped = 0;

try {
  for (const [key, val] of selected) {
    const present = exists(key);
    if (present && !overwrite) {
      console.log(`  skip     ${key}  (already present — pass --overwrite to replace)`);
      skipped++;
      continue;
    }
    const verb = present ? "OVERWRITE" : "restore  ";
    console.log(`  ${verb}${present ? " " : ""}${key}  (${val.length} bytes)`);
    if (write) {
      // Via file: values contain JSON, quotes and newlines that don't
      // survive a shell argument reliably.
      const tmp = join(staging, "value.json");
      writeFileSync(tmp, val);
      wrangler(["kv", "key", "put", key, "--path", tmp, "--binding", BINDING, "--remote"]);
      written++;
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(
  write
    ? `\n✓ wrote ${written} key${written === 1 ? "" : "s"}, skipped ${skipped}`
    : `\nDry run — nothing written. Re-run with --write to apply.`,
);
