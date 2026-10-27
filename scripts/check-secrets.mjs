#!/usr/bin/env node
/**
 * Secrets check — chạy trong git pre-commit hook.
 * Exit 1 nếu .coderrc.json / .coderrc đã staged và chứa apiKey.
 *
 * Cài đặt hook:
 *   mkdir -p .git/hooks
 *   cp scripts/check-secrets.mjs .git/hooks/pre-commit  (hoặc dùng husky)
 *   chmod +x .git/hooks/pre-commit
 */
import { execFileSync } from "node:child_process";

function stagedFiles() {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const files = stagedFiles().filter((f) => f.endsWith(".coderrc.json") || f.endsWith(".coderrc"));
if (files.length === 0) process.exit(0);

let failed = false;
for (const f of stagedFiles()) {
  if (!f.endsWith(".coderrc.json") && !f.endsWith(".coderrc")) continue;
  try {
    const content = execFileSync("git", ["show", `:0:${f}`], { encoding: "utf8" });
    if (/["']?apiKey["']?\s*:\s*["'][^"']{8,}/.test(content)) {
      console.error(`\n✗ BLOCKED: ${f} contains an apiKey and is staged for commit.`);
      console.error(`   Use CODER_API_KEY env var instead. Remove the key, then re-commit.`);
      failed = true;
    }
  } catch {
    // file not in index
  }
}

process.exit(failed ? 1 : 0);
