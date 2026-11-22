#!/usr/bin/env node
/**
 * Coverage GATE: run the suite with node's built-in coverage, parse the
 * `# all files` summary line, and fail below thresholds. Thresholds can be
 * overridden via SCODER_COVERAGE_MIN="<lines>,<branch>,<funcs>" for one-off
 * local runs; CI uses the defaults. Values are set a few points under the
 * measured baseline (91.97 lines at the time this gate landed) so ordinary
 * work passes while silent coverage collapse does not.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_MIN = { line: 88, branch: 78, funcs: 84 };

function parseEnvMin() {
  const raw = process.env.SCODER_COVERAGE_MIN;
  if (!raw) return DEFAULT_MIN;
  const [l, b, f] = raw.split(",").map((s) => Number(s.trim()));
  if (![l, b, f].every(Number.isFinite)) {
    console.error(`SCODER_COVERAGE_MIN must be "lines,branch,funcs" numbers (got "${raw}")`);
    process.exit(2);
  }
  return { line: l, branch: b, funcs: f };
}

const min = parseEnvMin();

const run = spawnSync("npm", ["run", "coverage"], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  cwd: process.cwd(),
});
if (run.status !== 0) {
  // The suite itself failed — surface the tail, let that failure stand.
  console.error((run.stdout || "").slice(-2000));
  console.error((run.stderr || "").slice(-2000));
  console.error(`coverage run exited ${run.status}`);
  process.exit(run.status ?? 1);
}

const out = run.stdout || "";
const line = out
  .split("\n")
  .map((l) => l.trim())
  .find((l) => /^#?\s*all files\s*\|/i.test(l));
if (!line) {
  console.error("Could not find the `all files` coverage summary — node test-coverage format changed?");
  process.exit(2);
}
const cols = line.split("|").map((c) => Number.parseFloat(c.trim()));
const [pctLine, pctBranch, pctFuncs] = cols.slice(1, 4);
if (![pctLine, pctBranch, pctFuncs].every(Number.isFinite)) {
  console.error(`Unparseable coverage summary: ${line}`);
  process.exit(2);
}

const rows = [
  ["lines  ", pctLine, min.line],
  ["branch ", pctBranch, min.branch],
  ["funcs  ", pctFuncs, min.funcs],
];
let failed = false;
for (const [name, got, need] of rows) {
  const ok = got >= need;
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${name} ${got.toFixed(2)}% (min ${need}%)`);
}
if (failed) {
  console.error("coverage below threshold — fix by testing more, not by lowering the gate (that is a review conversation)");
  process.exit(1);
}
console.log("✓ coverage gate passed");
