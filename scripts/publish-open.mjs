#!/usr/bin/env node
/**
 * Generate the public, AGPL copy of the vault from this private repo.
 *
 * This repo is the source of truth: you develop here, you deploy from here,
 * and it keeps the commercial developer platform. The public repo is a
 * *derivative* produced by this script, so the two can never drift and the
 * app door can never be published by accident.
 *
 * What comes out:
 *   - every tracked file, except src/api.ts
 *   - every region between COMMERCIAL-ONLY-START and COMMERCIAL-ONLY-END
 *     removed (three call sites in src/, one block in uxtest.mjs)
 *
 * Usage:
 *   node scripts/publish-open.mjs ../helix              # sync into a checkout
 *   node scripts/publish-open.mjs ../helix --commit     # ...and commit it
 *
 * It never pushes. Review the diff, then push yourself.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const START = "COMMERCIAL-ONLY-START";
const END = "COMMERCIAL-ONLY-END";
const EXCLUDE = ["src/api.ts"];

const dest = process.argv[2];
const doCommit = process.argv.includes("--commit");
if (!dest) {
  console.error("usage: node scripts/publish-open.mjs <path-to-public-checkout> [--commit]");
  process.exit(1);
}
const target = resolve(dest);
const root = resolve(import.meta.dirname, "..");
const sh = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();

/* A dirty tree means the export wouldn't match anything you can point at
 * later. Refuse rather than publish a snapshot that doesn't exist in history. */
if (sh("git", ["status", "--porcelain"])) {
  console.error("✗ working tree is dirty — commit first, so the public snapshot maps to a real commit");
  process.exit(1);
}
if (!existsSync(join(target, ".git"))) {
  console.error(`✗ ${target} is not a git checkout.
  Create the public repo on GitHub, clone it next to this one, then re-run.`);
  process.exit(1);
}

const sourceCommit = sh("git", ["rev-parse", "--short", "HEAD"]);
const staging = mkdtempSync(join(tmpdir(), "helix-open-"));

try {
  // git archive gives us tracked files only — no .dev.vars, no node_modules,
  // no .wrangler state, nothing that was merely sitting in the directory.
  execFileSync("sh", ["-c", `git archive HEAD | tar -x -C '${staging}'`], { cwd: root });

  for (const rel of EXCLUDE) rmSync(join(staging, rel), { force: true });

  /** Drop every START..END region, inclusive of the marker lines. */
  const strip = (text, rel) => {
    const out = [];
    let depth = 0;
    let removed = 0;
    for (const line of text.split("\n")) {
      // A fence is one marker on its own line. A line naming both is prose
      // about the markers (the README does exactly this) — leave it alone.
      if (line.includes(START) && line.includes(END)) { out.push(line); continue; }
      if (line.includes(START)) { depth++; continue; }
      if (line.includes(END)) {
        if (depth === 0) throw new Error(`${rel}: ${END} without a matching ${START}`);
        depth--; removed++; continue;
      }
      if (depth === 0) out.push(line);
    }
    if (depth !== 0) throw new Error(`${rel}: unclosed ${START}`);
    return { text: out.join("\n"), removed };
  };

  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

  // This file talks *about* the markers, so it must never be scanned for them.
  const isSelf = (p) => p.endsWith("publish-open.mjs");

  let regions = 0;
  for (const abs of walk(staging)) {
    if (isSelf(abs) || !/\.(ts|tsx|js|mjs|json|jsonc|sh|md)$/.test(abs)) continue;
    const before = readFileSync(abs, "utf8");
    if (!before.includes(START)) continue;
    const rel = abs.slice(staging.length + 1);
    const { text, removed } = strip(before, rel);
    writeFileSync(abs, text);
    regions += removed;
    console.log(`  stripped ${removed} region${removed === 1 ? "" : "s"} from ${rel}`);
  }

  /* The whole point of this script. If a reference survived, something was
   * added without a marker — stop loudly rather than publish it. */
  const leaks = walk(staging)
    .filter((p) => !isSelf(p) && /\.(ts|tsx|js|mjs)$/.test(p))
    .filter((p) => /from ["']\.\/api["']|require\(["']\.\/api["']\)/.test(readFileSync(p, "utf8")))
    .map((p) => p.slice(staging.length + 1));
  if (leaks.length) {
    console.error(`✗ these still import ./api — wrap the new reference in ${START}/${END}:`);
    leaks.forEach((f) => console.error(`    ${f}`));
    process.exit(1);
  }
  if (regions === 0) {
    console.error(`✗ no ${START} regions found — the markers were probably lost in a refactor`);
    process.exit(1);
  }

  if (!existsSync(join(target, "LICENSE")) && !existsSync(join(staging, "LICENSE"))) {
    console.log("\n⚠  no LICENSE in either tree. Add the AGPL-3.0 text before you push:");
    console.log("   GitHub → Add file → Create new file → name it LICENSE → choose a license template → GNU AGPLv3\n");
  }

  // Mirror: delete everything in the target except .git, then copy the tree
  // in. Deletions in this repo therefore propagate, which is the point.
  for (const name of readdirSync(target)) {
    if (name === ".git" || name === "LICENSE") continue;
    rmSync(join(target, name), { recursive: true, force: true });
  }
  cpSync(staging, target, { recursive: true });

  console.log(`\n✓ public tree written to ${target} (from ${sourceCommit})`);

  if (doCommit) {
    execFileSync("git", ["add", "-A"], { cwd: target });
    const pending = execFileSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }).trim();
    if (!pending) {
      console.log("  nothing changed since the last publish");
    } else {
      execFileSync("git", ["commit", "-m", `Sync from helix-mcp ${sourceCommit}`], { cwd: target });
      console.log(`  committed. Review with 'git -C ${target} show', then push.`);
    }
  } else {
    console.log(`  review with 'git -C ${target} status', then commit and push.`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
