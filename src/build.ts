import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toolRunCommand } from "./tools.js";

export interface BuildResult {
  success: boolean;
  command: string;
  output: string;
}

/** Detect a sensible build command from project files in workdir. */
export function detectBuildCommand(workdir: string): string | null {
  const pkgPath = resolve(workdir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.build) return "npm run build";
    } catch (err) {
      // malformed package.json -> fall through to the other detectors
      console.error(`⚠  cannot parse package.json (${(err as Error).message}) — build command detection degraded`);
    }
  }
  if (existsSync(resolve(workdir, "Makefile"))) return "make";
  if (existsSync(resolve(workdir, "go.mod"))) return "go build ./...";
  if (existsSync(resolve(workdir, "Cargo.toml"))) return "cargo build";
  if (existsSync(resolve(workdir, "pyproject.toml"))) return "python -m compileall .";
  if (existsSync(resolve(workdir, "tsconfig.json"))) return "npx tsc --noEmit";
  return null;
}

/**
 * Run the build command. This is the agent's stop condition:
 * exit code 0 == task complete.
 */
export async function runBuild(workdir: string, command: string): Promise<BuildResult> {
  const res = await toolRunCommand(workdir, { command, timeout_secs: 600 });
  return {
    success: res.ok,
    command,
    output: res.output,
  };
}
