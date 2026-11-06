/**
 * Phase 7 — TUI transcript helpers.
 * Pure functions: no React/Ink dependency, fully unit-testable.
 */
import type { TranscriptItem } from "./types.js";

// ── Export ────────────────────────────────────────────────────────────────────

/** Render a TranscriptItem to its plain-text representation for export. */
export function itemToText(item: TranscriptItem): string {
  switch (item.kind) {
    case "user":       return `## you\n\n${item.text}`;
    case "assistant":  return `## agent\n\n${item.text}`;
    case "thinking":   return `## thinking\n\n${item.text}`;
    case "tool": {
      const args = Object.entries(item.args).map(([k, v]) => `  ${k}=${JSON.stringify(v)}`).join("\n");
      const elapsed = item.durationMs != null ? ` (${item.durationMs}ms)` : "";
      const status = item.ok === null ? "running" : item.ok ? "ok" : "FAILED";
      return `## tool: ${item.name}${elapsed}\n\n${status}${args ? "\n" + args : ""}\n\n${item.output}`;
    }
    case "diff":
      return `## diff: ${item.path} (+${item.added}/-${item.removed})\n\n${item.text}`;
    case "build":
      return `## build: ${item.command}\n\n${item.success ? "✓ passed" : "✗ FAILED"}`;
    case "todo": {
      const rows = item.items.map((t) => `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`);
      return `## plan\n\n${rows.join("\n")}`;
    }
    case "compaction":
      return `## compacted (${item.tokensBefore} → ${item.tokensAfter} tokens)${item.manual ? " [manual]" : ""}`;
    case "notice":
      return `${item.level === "error" ? "✗" : item.level === "warn" ? "⚠" : ""} ${item.text}`;
  }
}

/** Format a chat item as Markdown (GitHub-flavored). */
export function itemToMarkdown(item: TranscriptItem): string {
  const ts = item.kind === "tool" ? `[${item.step.toString().padStart(2, "0")}]` : "";
  switch (item.kind) {
    case "user":
      return `## you\n\n> ${item.text}`;
    case "assistant":
      return `## agent\n\n${item.text}`;
    case "thinking":
      return `> ⊙ ${item.text.split("\n").slice(-4).join(" | ")}`;
    case "tool": {
      const elapsed = item.durationMs != null ? ` — ${(item.durationMs / 1000).toFixed(1)}s` : "";
      const ok = item.ok === null ? "⏳ running" : item.ok ? "✅" : "❌";
      const args = Object.keys(item.args).length > 0
        ? `\`${item.name}(${Object.entries(item.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})\``
        : `\`${item.name}\``;
      return `${ts} ${ok} **${args}**${elapsed}\n\n\`\`\`\n${item.output}\n\`\`\``;
    }
    case "diff":
      return `${ts} ✎ \`${item.path}\` \`+${item.added}/-${item.removed}\`\n\`\`\`diff\n${item.text}\n\`\`\``;
    case "build":
      return `${item.success ? "✅" : "❌"} **build**: \`${item.command}\``;
    case "todo": {
      const rows = item.items.map((t) =>
        `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`
      );
      return `## plan\n\n${rows.join("\n")}`;
    }
    case "compaction":
      return `\n---\n*compacted: ${item.tokensBefore} → ${item.tokensAfter} tokens*${item.manual ? " (manual)" : ""}\n---\n`;
    case "notice":
      return `${item.level === "error" ? "> ❌" : item.level === "warn" ? "> ⚠" : ">"} ${item.text}`;
  }
}

/** Export transcript to the requested format. */
export function exportTranscript(
  items: TranscriptItem[],
  format: "md" | "json" = "md",
): string {
  if (format === "json") {
    return JSON.stringify(items, null, 2);
  }
  return items.map(itemToMarkdown).join("\n\n");
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface TranscriptMatch {
  index: number;
  kind: TranscriptItem["kind"];
  /** The matched text snippet (up to 120 chars, context-padded). */
  snippet: string;
}

/** Case-insensitive search over transcript items.
 *  Returns all items whose text representation matches `query`.
 *  Searches: assistant/thinking text, tool name+output, diff path+text, notice text.
 */
export function findInTranscript(items: TranscriptItem[], query: string): TranscriptMatch[] {
  if (!query.trim()) return [];
  const lc = query.toLowerCase();
  const results: TranscriptMatch[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const matched = (text: string): boolean => text.toLowerCase().includes(lc);
    let hit = false;
    let snippet = "";
    switch (item.kind) {
      case "assistant":
      case "thinking":
        if (matched(item.text)) { hit = true; snippet = snippetOf(item.text, query); }
        break;
      case "tool":
        if (matched(item.name) || matched(item.output) || matched(JSON.stringify(item.args))) {
          hit = true;
          snippet = snippetOf(`${item.name}: ${item.output}`, query);
        }
        break;
      case "diff":
        if (matched(item.path) || matched(item.text)) { hit = true; snippet = snippetOf(`${item.path} · ${item.text}`, query); }
        break;
      case "user":
        if (matched(item.text)) { hit = true; snippet = snippetOf(item.text, query); }
        break;
      case "notice":
        if (matched(item.text)) { hit = true; snippet = snippetOf(item.text, query); }
        break;
      case "build":
        if (matched(item.command)) { hit = true; snippet = snippetOf(item.command, query); }
        break;
      default:
        break;
    }
    if (hit) results.push({ index: i, kind: item.kind, snippet });
  }
  return results;
}

/** Return a ~120-char snippet around the first occurrence of `query` in `text`. */
function snippetOf(text: string, query: string): string {
  const pos = text.toLowerCase().indexOf(query.toLowerCase());
  if (pos === -1) return text.slice(0, 120);
  const start = Math.max(0, pos - 40);
  const end = Math.min(text.length, pos + query.length + 80);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/** Return the copyable text for a chat item (for clipboard). */
export function copyTextForItem(item: TranscriptItem): string {
  switch (item.kind) {
    case "diff":    return item.text;
    case "tool":    return item.output;
    case "assistant": return item.text;
    default:        return itemToText(item);
  }
}
