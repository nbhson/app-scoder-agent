/** Parse a single SSE block (blank-line-separated events) into one JSON-RPC message.
 *  Normalizes CRLF → LF before splitting on the event separator. */
export function parseSseEvent(block: string): Record<string, unknown> | null {
  const data = block
    .replace(/\r\n/g, "\n")
    .split(/\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
  if (!data) return null;
  try { return JSON.parse(data) as Record<string, unknown>; } catch { return null; }
}

/** Parse SSE text (legacy buffer-based) thành JSON-RPC messages. */
export function parseSseMessages(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const m = parseSseEvent(block);
    if (m) out.push(m);
  }
  return out;
}
