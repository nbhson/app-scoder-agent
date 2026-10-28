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
  "../package.json",
);

export const CLIENT_NAME = "app-scoder-agent";

export function getVersion(): string {
  try {
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
