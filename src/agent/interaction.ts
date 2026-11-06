import type { AskUserRequest } from "../tools.js";
import type { AgentEvent } from "./types.js";
import type { PermissionAnswer, PermissionRequest } from "../permissions.js";
import type { JsonlLogger } from "../logger.js";

export interface InteractionRuntime {
  logger: JsonlLogger;
  emit: (event: AgentEvent) => void;
  hasEventSink: () => boolean;
}

export class InteractionBroker {
  private readonly pendingPermissions = new Map<string, (answer: PermissionAnswer) => void>();
  private questionHandler: ((request: AskUserRequest & { id: string }) => Promise<string | null>) | null = null;
  private permissionSequence = 0;
  private questionSequence = 0;

  setQuestionHandler(fn: ((request: AskUserRequest & { id: string }) => Promise<string | null>) | null): void {
    this.questionHandler = fn;
  }

  ask(runtime: InteractionRuntime, request: AskUserRequest): Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string } {
    const handler = this.questionHandler;
    if (!handler) {
      return {
        ok: false,
        output: "ERROR: ask_user is unavailable — non-interactive session. Proceed with your best judgment or stop and report.",
      };
    }
    const id = `q${Date.now()}_${++this.questionSequence}`;
    runtime.emit({ type: "question_request", id, question: request.question, options: request.options, multiple: request.multiple, timeoutSecs: request.timeoutSecs ?? 120 });
    return this.awaitQuestion(runtime, request, id, handler);
  }

  private async awaitQuestion(
    runtime: InteractionRuntime,
    request: AskUserRequest,
    id: string,
    handler: (request: AskUserRequest & { id: string }) => Promise<string | null>,
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const timeoutMs = (request.timeoutSecs ?? 120) * 1000;
      const answer = await Promise.race([
        handler({ ...request, id }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (answer == null || (typeof answer === "string" && !answer.trim())) {
        return { ok: false, output: "ERROR: ask_user timed out or was cancelled." };
      }
      runtime.logger.log({ type: "ask_user", question: request.question, answer: String(answer).slice(0, 500) });
      return { ok: true, output: `User answered: ${answer}` };
    } catch (err) {
      return { ok: false, output: `ERROR: ask_user failed: ${(err as Error).message.slice(0, 200)}` };
    }
  }

  permissionPrompt(runtime: InteractionRuntime, request: PermissionRequest): Promise<PermissionAnswer> {
    if (!runtime.hasEventSink()) return Promise.resolve("no");
    const id = `perm-${++this.permissionSequence}`;
    return new Promise<PermissionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingPermissions.delete(id)) resolve("no");
      }, request.timeoutSecs * 1000);
      this.pendingPermissions.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      runtime.emit({
        type: "permission_request",
        id,
        kind: request.kind,
        label: request.label,
        ...(request.command !== undefined ? { command: request.command } : {}),
        ...(request.diff !== undefined ? { diff: request.diff } : {}),
        ...(request.alwaysAllowPrefix !== undefined ? { alwaysAllowPrefix: request.alwaysAllowPrefix } : {}),
        timeoutSecs: request.timeoutSecs,
      });
    });
  }

  resolvePermission(id: string, answer: PermissionAnswer): void {
    const resolver = this.pendingPermissions.get(id);
    if (resolver) {
      this.pendingPermissions.delete(id);
      resolver(answer);
    }
  }
}
