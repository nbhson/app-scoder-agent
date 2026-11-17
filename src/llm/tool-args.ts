/**
 * P-perf (round 2, item 4): one shared, WeakMap-memoized tool-arguments
 * parser. The same `tool_call` object is parsed 4–7× per run — pre-ask scan
 * and build-call detection in the run loop, the executor, working-memory
 * bookkeeping, compaction's summary digest, and the Anthropic serializer
 * (which re-reads the WHOLE history every request: write_file args contain
 * entire files, so the repeat parses dominated prompt prep). History is
 * append-only (P0-1): tool_call objects are created once and never mutated,
 * so identity-keyed memoization is exact. Validated against the `arguments`
 * string reference anyway, so a hypothetical in-place rewrite re-parses.
 *
 * Semantics are IDENTICAL to the inline `JSON.parse(...)` they replace:
 * throws SyntaxError on malformed JSON (callers keep their own handling),
 * returns `{}` for empty/missing arguments.
 */
const memo = new WeakMap<object, { raw: string; value: unknown }>();

export function parseToolArgsCached(tc: { arguments?: string }): Record<string, unknown> {
  const raw = tc.arguments ?? "";
  const hit = memo.get(tc);
  if (hit && hit.raw === raw) return hit.value as Record<string, unknown>;
  const value: unknown = raw ? JSON.parse(raw) : {}; // may throw — same as the callers' old inline parse
  try {
    memo.set(tc, { raw, value });
  } catch {
    /* non-extensible tool_call object — parse again next time, as before */
  }
  return value as Record<string, unknown>;
}
