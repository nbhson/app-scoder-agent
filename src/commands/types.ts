/** UI-independent transcript model consumed by command helpers. */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "thinking"; text: string; streaming: boolean }
  | { kind: "tool"; name: string; args: Record<string, unknown>; callId?: string; ok: boolean | null; output: string; step: number; startedAt?: number; durationMs?: number; image?: string }
  | { kind: "notice"; text: string; level: "info" | "warn" | "error" }
  | { kind: "build"; success: boolean; command: string }
  | { kind: "compaction"; tokensBefore: number; tokensAfter: number; manual?: boolean }
  | { kind: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "diff"; path: string; text: string; added: number; removed: number; truncated: boolean; step: number };
