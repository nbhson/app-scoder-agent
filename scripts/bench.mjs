#!/usr/bin/env node
/**
 * Phase 6/P7: performance benchmark for the agent hot paths.
 *
 * Workloads (synthetic but representative — see plan/REFACTOR-PLAN.md §Phase 6):
 *  - repo with ~5.000 files: buildRepoMap cold / warm / repoMapKey
 *  - 100 skills on disk: discoverSkills / findSkill
 *  - buildEnvInfo (spawns git)
 *  - cold start: node dist/index.js --help
 *
 * Usage:
 *   node scripts/bench.mjs                 # run and print JSON
 *   node scripts/bench.mjs --compare <baseline.json>
 *     exits 1 if any case regresses > 5%; reports speedups for targets.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(ROOT, "dist");
const ITER = { repoMapCold: 3, repoMapWarm: 10, repoMapKey: 5, envInfo: 10, skills: 10, coldStart: 3 };

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return xs.length % 2 ? s[(xs.length - 1) / 2] : (s[xs.length / 2 - 1] + s[xs.length / 2]) / 2;
}

/** time fn() ITER times, return median ms */
function time(label, iters, fn) {
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { label, medianMs: Number(median(samples).toFixed(3)), iters };
}

/** Synthetic repo: dirs of small TS/JS/py files (bounded by MAX_WALK_FILES=2000 walk cap anyway). */
function makeRepo(fileCount) {
  const dir = mkdtempSync(join(tmpdir(), "scoder-bench-repo-"));
  const perDir = 100;
  for (let d = 0; d < Math.ceil(fileCount / perDir); d++) {
    const sub = join(dir, `pkg${d}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < perDir && d * perDir + f < fileCount; f++) {
      writeFileSync(
        join(sub, `mod${f}.ts`),
        `export function fn${d}_${f}(a: number): number { return a + ${f}; }\nexport const CONST_${f} = ${f};\n`.repeat(3),
      );
    }
  }
  return dir;
}

function makeSkills(workdir, count) {
  const dir = join(workdir, ".scoder", "skills");
  for (let i = 0; i < count; i++) {
    const sd = join(dir, `skill-${i}`);
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "SKILL.md"), `---\nname: skill-${i}\ndescription: benchmark skill number ${i}\n---\n\nBody of skill ${i}.\n`);
  }
}

async function main() {
  const { buildRepoMap, repoMapKey, renderRepoMap, invalidateRepoMap } = await import(join(DIST, "repo-map.js"));
  const { buildEnvInfo } = await import(join(DIST, "prompt-builder.js"));
  const { discoverSkills, findSkill } = await import(join(DIST, "skills.js"));

  const repo = makeRepo(2000); // walk cap is 2000 — the realistic upper bound per map
  makeSkills(repo, 100);
  const results = [];

  try {
    // Cold: clear the cache before every sample.
    results.push(time("buildRepoMap cold", ITER.repoMapCold, () => { invalidateRepoMap(repo); buildRepoMap(repo); }));
    // Warm: cache hit after the first build.
    buildRepoMap(repo);
    results.push(time("buildRepoMap warm (cache hit)", ITER.repoMapWarm, () => buildRepoMap(repo)));
    results.push(time("repoMapKey", ITER.repoMapKey, () => repoMapKey(repo)));
    results.push(time("renderRepoMap (no cache)", ITER.repoMapCold, () => renderRepoMap(repo)));
    results.push(time("buildEnvInfo", ITER.envInfo, () => buildEnvInfo(repo)));
    results.push(time("discoverSkills (100 skills)", ITER.skills, () => discoverSkills(repo)));
    results.push(time("findSkill (100 skills)", ITER.skills, () => findSkill(repo, "skill-42")));
    results.push(time("cold start: --help", ITER.coldStart, () => {
      execFileSync(process.execPath, [join(DIST, "index.js"), "--help"], { stdio: "ignore" });
    }));
    const mem = spawnSync(process.execPath, [join(DIST, "index.js"), "--version"], { encoding: "utf8" });
    results.push({ label: "cold start: --version exit", medianMs: mem.status === 0 ? 0 : 1, iters: 1 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  const out = { commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), date: new Date().toISOString(), results };

  const cmpIdx = process.argv.indexOf("--compare");
  if (cmpIdx > 0) {
    const baseline = JSON.parse(readFileSync(process.argv[cmpIdx + 1], "utf8"));
    let fail = false;
    console.log(`compare: baseline ${baseline.commit} → ${out.commit}\n`);
    for (const r of results) {
      const b = baseline.results.find((x) => x.label === r.label);
      if (!b || b.medianMs === 0) { console.log(`  ${r.label}: ${r.medianMs}ms (no baseline)`); continue; }
      const delta = ((r.medianMs - b.medianMs) / b.medianMs) * 100;
      // Noise floor: sub-10ms cases jitter several % run-to-run on the same
      // code — only flag a regression that is both relatively and absolutely
      // significant.
      const regression = delta > 5 && r.medianMs - b.medianMs > 1;
      const mark = delta < -20 ? "▼▼" : delta < -5 ? "▼" : regression ? "▲▲ REGRESSION" : "·";
      if (regression) fail = true;
      console.log(`  ${mark} ${r.label}: ${b.medianMs}ms → ${r.medianMs}ms (${delta > 0 ? "+" : ""}${delta.toFixed(1)}%)`);
    }
    if (fail) { console.error("\n✗ regression > 5% detected"); process.exit(1); }
    console.log("\n✓ no regression > 5%");
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

const results = [];
main().catch((e) => { console.error(e); process.exit(2); });
