/**
 * Inline markdown tokenizer — `code`, **bold**, *italic*, ~~strike~~,
 * [links](url), backslash escapes.
 *
 * Precedence (CommonMark-compatible):
 * 1. Backslash escapes are resolved first (\* → literal *).
 * 2. Code spans are extracted next — their content is NEVER parsed further
 *    (so `` `a|b` `` and `` `**x**` `` stay literal).
 * 3. Links (URL may contain one level of balanced parens).
 * 4. Bold / strike / italic, in that order; markers must be non-empty and
 *    single-line.
 */
import type { InlineToken } from "./ast.js";

/** Placeholder chars (private use area) for escaped punctuation. */
const ESCAPES: Record<string, string> = {
  "\\*": "\uE000", "\\_": "\uE001", "\\`": "\uE002", "\\~": "\uE003",
  "\\[": "\uE004", "\\]": "\uE005", "\\(": "\uE006", "\\)": "\uE007",
  "\\\\": "\uE008", "\\|": "\uE009",
};
const UNESCAPE = new Map(Object.entries(UNESCAPE_MAP()));

function UNESCAPE_MAP(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    "\uE000": "*", "\uE001": "_", "\uE002": "`", "\uE003": "~",
    "\uE004": "[", "\uE005": "]", "\uE006": "(", "\uE007": ")",
    "\uE008": "\\", "\uE009": "|",
  })) out[k] = v;
  return out;
}

/** Escape `\X` sequences so tokenizers don't see the marker chars. */
export function protectEscapes(text: string): string {
  let out = text;
  for (const [esc, placeholder] of Object.entries(ESCAPES)) {
    // replaceAll on literal backslash sequences
    out = out.split(esc).join(placeholder);
  }
  return out;
}

/** Restore placeholder chars to their literal punctuation. */
export function unprotect(text: string): string {
  let out = text;
  for (const [placeholder, literal] of UNESCAPE) {
    out = out.split(placeholder).join(literal);
  }
  return out;
}

/** Split text keeping code spans intact — returns raw segments for tables etc. */
export function splitOutsideCodeSpans(text: string, delimiter: string): string[] {
  const protected_ = protectEscapes(text);
  const out: string[] = [];
  let current = "";
  let inCode = false;
  for (const ch of protected_) {
    if (ch === "`") inCode = !inCode;
    if (ch === delimiter && !inCode) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map(unprotect);
}

/** Tokenize one line of inline markdown. */
export function tokenizeInline(text: string): InlineToken[] {
  const src = protectEscapes(text);
  const tokens: InlineToken[] = [];
  // Order matters: code spans → links → bold → strike → italic.
  const rx = /(`[^`\n]+`)|(\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))+\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  for (const m of src.matchAll(rx)) {
    if (m.index > last) tokens.push({ type: "text", text: unprotect(src.slice(last, m.index)) });
    const tok = m[0];
    if (m[1]) {
      tokens.push({ type: "code", text: unprotect(tok.slice(1, -1)) });
    } else if (m[2]) {
      const lm = /^\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)$/.exec(tok);
      tokens.push({ type: "link", text: unprotect(lm?.[1] ?? ""), url: unprotect(lm?.[2] ?? "") });
    } else if (m[3]) {
      tokens.push({ type: "bold", text: unprotect(tok.slice(2, -2)) });
    } else if (m[4]) {
      tokens.push({ type: "strike", text: unprotect(tok.slice(2, -2)) });
    } else if (m[5]) {
      tokens.push({ type: "italic", text: unprotect(tok.slice(1, -1)) });
    }
    last = m.index + tok.length;
  }
  if (last < src.length) tokens.push({ type: "text", text: unprotect(src.slice(last)) });
  return tokens.filter((t) => t.text !== "" || t.type === "link");
}

/** Plain-text content of inline markdown (markers stripped) — for measuring. */
export function inlineToPlain(text: string): string {
  return tokenizeInline(text)
    .map((t) => (t.type === "link" ? `${t.text} (${t.url})` : t.text))
    .join("");
}
