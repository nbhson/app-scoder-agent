import type { ToolSpec } from "../llm/llm.js";
import type { PermissionChecker, PermissionMode } from "../security/permissions.js";
import type { SandboxConfig } from "../security/sandbox.js";
import type { Reporter } from "../io/reporter.js";

export interface ToolDiff {
  path: string;
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  diff?: ToolDiff;
  image?: string;
  untrusted?: boolean;
}

export interface TodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  verify?: string;
  depends_on?: string[];
  files?: string[];
  acceptance?: string;
}

export interface AskUserRequest {
  question: string;
  options?: string[];
  multiple?: boolean;
  timeoutSecs?: number;
}

export interface TaskSpec {
  description: string;
  prompt: string;
  agent?: string;
}

export type CommandOutputListener = (stream: "stdout" | "stderr", delta: string) => void;

export interface ToolContext {
  workdir: string;
  permissions?: PermissionChecker;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  onToolOutput?: (name: string, stream: "stdout" | "stderr", delta: string) => void;
  plan?: { get(): TodoItem[]; set(items: TodoItem[]): void };
  formatter?: boolean | string;
  allowSubagents?: boolean;
  taskRunner?: TaskRunner;
  sandbox?: SandboxConfig;
  maxOutputChars?: number;
  askUser?: (req: AskUserRequest) => Promise<{ ok: boolean; output: string }>;
  reporter?: Reporter;
}

export type TaskRunner = (
  ctx: ToolContext,
  args: { description?: string; prompt?: string; agent?: string; tasks?: TaskSpec[] },
) => Promise<ToolResult>;

export interface AgentTool {
  spec: ToolSpec;
  run: (ctx: ToolContext, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}
