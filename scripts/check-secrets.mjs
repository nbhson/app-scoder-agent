#!/usr/bin/env node
/**
 * Git pre-commit hook: scan staged .scoderrc.json for hardcoded apiKey.
 * Usage: node scripts/check-secrets.mjs
 * Git hook: npx husky add .husky/pre-commit "node scripts/check-secrets.mjs"
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = ".scoderrc.json";
const CWD = process.cwd();

let foundSecret = false;

function checkRcFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return; // file doesn't exist — nothing to check
  }

  const secretPatterns = [
    { regex: /sk-[A-Za-z0-9_-]{16,}/g, name: "OpenAI/compatible API key" },
    { regex: /sk-ant-[A-Za-z0-9_-]{40,}/g, name: "Anthropic API key" },
    { regex: /"apiKey"\s*:\s*"[^"]+/g, name: "apiKey field in config" },
    { regex: /ghp_[A-Za-z0-9]{36}/g, name: "GitHub personal access token" },
    { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g, name: "Slack token" },
    { regex: /AIza[A-Za-z0-9_-]{35}/g, name: "Google API key" },
  ];

  for (const { regex, name } of secretPatterns) {
    if (regex.test(content)) {
      foundSecret = true;
      console.error(`\n  ERROR: Possible secret in ${filePath}:`);
      console.error(`         Found pattern matching: ${name}`);
      console.error(`         Remove apiKey from .scoderrc.json and use`);
      console.error(`         the SCODER_API_KEY environment variable instead.`);
      console.error(`         File: ${filePath}\n`);
    }
  }
}

checkRcFile(resolve(CWD, TARGET));

// Also check .env (if present)
const envPath = resolve(CWD, ".env");
try {
  const envContent = readFileSync(envPath, "utf8");
  const hasEnv = /SCODER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/.test(envContent);
  if (hasEnv) {
    console.log("  ⚠  .env file found with API keys — ensure it is in .gitignore");
  }
} catch {
  // .env doesn't exist — ok
}

if (foundSecret) {
  process.exit(1);
}

console.log("  ✓ No secrets detected in .scoderrc.json");
process.exit(0);
