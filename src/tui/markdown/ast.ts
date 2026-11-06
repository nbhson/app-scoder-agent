/**
 * Markdown block AST — output of parse.ts, input of render.tsx.
 * Pure data, zero Ink dependency, fully unit-testable.
 */

export type TableAlign = "left" | "center" | "right";

export interface ListItem {
  /** Nesting depth (0 = top level). */
  depth: number;
  /** Ordered list marker as written ("1."), or null for bullets. */
  marker: string | null;
  /** Task list checkbox: true = [x], false = [ ], undefined = not a task. */
  checked?: boolean;
  text: string;
}

export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "table"; header: string[]; align: TableAlign[]; rows: string[][] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "mermaid"; lines: string[] }
  | { kind: "chart"; lang: string; source: string }
  | { kind: "timeline"; source: string }
  | { kind: "spacer" };

// ── Inline tokens ────────────────────────────────────────────────────────────

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "strike"; text: string }
  | { type: "link"; text: string; url: string };
