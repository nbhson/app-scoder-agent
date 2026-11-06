#!/usr/bin/env node
/**
 * Phase 10.3: docs freshness check — every `src/...` path mentioned in the
 * docs must exist (facades count: they are real files). Fails on stale paths
 * so docs cannot drift from the domain layout silently.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DOCS = ["README.md", "docs", "src/README.md"];

function* docFiles(entry) {
  const abs = join(ROOT, entry);
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    if (entry.includes("legacy")) return; // historical docs keep old paths
    for (const name of readdirSync(abs)) yield* docFiles(join(entry, name));
  } else if (entry.endsWith(".md")) {
    yield abs;
  }
}

function pathExists(srcPath) {
  const abs = join(ROOT, srcPath);
  if (existsSync(abs)) return true;
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    if (existsSync(abs.replace(/\.js$/, "") + ext) || existsSync(abs + ext)) return true;
  }
  return false;
}

// Real top-level entries under src/ (domains + facade base names). Only paths
// whose first segment matches one of these are validated — otherwise the path
// is almost certainly a user-facing example (e.g. "fix src/network.ts").
const REAL_SEGMENTS = new Set(
  readdirSync(join(ROOT, "src")).map((n) => n.replace(/\.(ts|tsx)$/, "")),
);

const stale = [];
const seen = new Set();
const docsDir = join(ROOT, "docs");
for (const entry of DOCS) {
  for (const file of docFiles(entry)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?<![\w/.-])((?:src|dist)\/[\w./-]+)/g)) {
      const p = m[1].replace(/[.,;:)]*$/, "");
      if (seen.has(p) || p.includes("*")) continue;
      seen.add(p);
      if (p.startsWith("src/") && !REAL_SEGMENTS.has(p.slice(4).split("/")[0])) continue;
      if (!pathExists(p)) stale.push(`${file.replace(ROOT + "/", "")}: ${p}`);
    }
    // Local markdown links must resolve relative to the containing file.
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)#\s]+)\)/g)) {
      const href = m[1];
      if (/^https?:/.test(href) || href.startsWith("mailto:")) continue;
      if (!existsSync(resolve(file, "..", href))) stale.push(`${file.replace(ROOT + "/", "")}: link ${href}`);
    }
  }
}

// Inventory: every docs/*.md must be linked from docs/README.md.
const docsIndex = readFileSync(join(docsDir, "README.md"), "utf8");
for (const name of readdirSync(docsDir)) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  if (!docsIndex.includes(`(${name})`)) stale.push(`docs/README.md: missing inventory entry for ${name}`);
}
for (const name of readdirSync(join(docsDir, "refactor"))) {
  if (name.endsWith(".md") && !docsIndex.includes(`(refactor/${name})`)) {
    stale.push(`docs/README.md: missing inventory entry for refactor/${name}`);
  }
}

// Stale historical numbers that must not describe the present.
const STALE_PATTERNS = [/\b104 unit tests\b/i, /15 modules TypeScript/i, /258\/258/, /90\.28%/];
for (const entry of DOCS) {
  for (const file of docFiles(entry)) {
    const text = readFileSync(file, "utf8");
    for (const pat of STALE_PATTERNS) {
      const m = text.match(pat);
      if (m) stale.push(`${file.replace(ROOT + "/", "")}: stale figure "${m[0]}"`);
    }
  }
}

if (stale.length > 0) {
  console.error("✗ stale paths in docs:");
  for (const s of stale) console.error(`  ${s}`);
  process.exit(1);
}
console.log(`✓ docs fresh (${seen.size} src/dist paths verified)`);
