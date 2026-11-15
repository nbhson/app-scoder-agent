/**
 * Single source of truth for the package version and client name.
 * Reads package.json at runtime (works both from src/ during dev and from
 * dist/ in the published build), falling back to "0.0.0" for bundled builds.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

export const CLIENT_NAME = "app-scoder-agent";

// P-perf: memoized — chrome.tsx renders the version on every sidebar/build-rail
// re-render; the file never changes inside a process.
let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    cachedVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
