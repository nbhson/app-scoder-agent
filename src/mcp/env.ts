/** Expand {env:VAR} references in config env values. */
export function expandEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? "");
  }
  return out;
}
