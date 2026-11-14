import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRcFile } from "../config/config.js";
import { resolveSandbox, type SandboxConfig } from "../security/sandbox.js";
import { consoleReporter } from "../io/console-reporter.js";
import { clamp, MAX_OUTPUT_CHARS } from "./path-safety.js";
import type { ToolResult } from "./types.js";
import { redactSecrets } from "../llm/llm.js";

// ── G3: child env allowlist ─────────────────────────────────────────────────
// spawn /bin/sh -c with the FULL process.env leaks every secret in the shell's
// environment (API keys, tokens) to any command the model runs — and thus to
// the conversation/log via `env` or a misbehaving tool. Allowlist instead.

/** Always passed through — minimum for node/python/git builds to work. */
const BASE_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  // Windows essentiels — cmd.exe/npm.cmd cần SystemRoot/ComSpec/PATHEXT để chạy;
  // Node trên Windows tra env key không phân biệt hoa thường nên viết hoa cũng khớp.
  "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PUBLIC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
];

/**
 * G3: build the child env. Base keys + SCODER_* config + explicit extras from
 * the rc (`shellEnvAllow`), resolved from process.env. Missing keys are absent
 * (not empty) so tools detect them correctly.
 */
export function buildChildEnv(workdir: string, extraKeys?: string[]): Record<string, string> {
  const rc = loadRcFile(workdir) as { shellEnvAllow?: string[] };
  const allow = [...BASE_ENV_KEYS, ...(rc.shellEnvAllow ?? []), ...(extraKeys ?? [])];
  const out: Record<string, string> = {};
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  // Windows + Git Bash: không có HOME — git/bash đọc config từ ~ (.gitconfig,
  // ssh keys). Map HOME → USERPROFILE để git hoạt động đúng user hiện tại.
  if (process.platform === "win32" && out.HOME === undefined && out.USERPROFILE) {
    out.HOME = out.USERPROFILE;
  }
  return out;
}

/**
 * Shell mặc định theo platform:
 * - Unix → /bin/sh -c.
 * - Windows → Git Bash nếu tìm thấy (model hay emit cú pháp POSIX: pipes, grep,
 *   rm -rf — cmd.exe không chạy được), fallback cmd.exe /d /c.
 *   KHÔNG dùng `where bash` — System32\bash.exe là WSL (sai filesystem).
 */
export function defaultShellArgv(command: string): string[] {
  if (process.platform === "win32") {
    const bash = findGitBash();
    if (bash) return [bash, "-c", command];
    return [process.env.ComSpec || process.env.COMSPEC || "cmd.exe", "/d", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}

/** Locate Git for Windows' bash.exe (cached); null when not installed. */
let gitBashCache: string | null | undefined;
function findGitBash(): string | null {
  if (gitBashCache !== undefined) return gitBashCache;
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    join(pf, "Git", "bin", "bash.exe"),
    join(pf86, "Git", "bin", "bash.exe"),
    ...(local ? [join(local, "Programs", "Git", "bin", "bash.exe")] : []),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      gitBashCache = c;
      return c;
    }
  }
  gitBashCache = null;
  return null;
}

/**
 * Run a shell command asynchronously (async spawn keeps the event loop free,
 * so streaming output renders and SIGINT is handled promptly).
 * Kills the child on timeout or external abort (SIGINT via ctx.signal).
 * When `onOutput` is provided, stdout/stderr chunks are forwarded live as they
 * arrive (in addition to being collected into the final ToolResult).
 * G3: output is redacted (secret shapes) before it enters the conversation,
 * the live stream, or the JSONL log.
 */
export async function toolRunCommand(
  workdir: string,
  args: { command: string; timeout_secs?: number },
  signal?: AbortSignal,
  onOutput?: (stream: "stdout" | "stderr", delta: string) => void,
  sandbox?: SandboxConfig,
  reporter = consoleReporter,
): Promise<ToolResult> {
  const timeoutMs = Math.min(Math.max(args.timeout_secs ?? 120, 1), 600) * 1000;
  // G3: the echoed command line itself may contain a secret (e.g. `curl -H
  // "Authorization: Bearer sk-..."`) — redact the echo, never run redacted
  // (the child gets the raw command).
  const echoLine = `$ ${redactSecrets(args.command)}`;

  // G4: sandbox wrap khi config bật. Wrapper thiếu → warn + chạy trực tiếp.
  const sandboxed = await resolveSandbox(sandbox ?? {}, workdir, args.command);
  if (sandboxed.argv) {
    reporter.info(`sandbox: ${sandboxed.wrapper} (${(sandbox ?? {}).mode})`);
  } else if ((sandbox ?? {}).mode && (sandbox ?? {}).mode !== "off") {
    reporter.warn(`sandbox: ${sandboxed.reason}`);
  }
  const spawnArgv = sandboxed.argv ?? defaultShellArgv(args.command);

  return new Promise<ToolResult>((resolve) => {
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const child = spawn(spawnArgv[0], spawnArgv.slice(1), {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(workdir), // G3: allowlist — không kế thừa full process.env
      // Own process group so killTree(-pid) can reap grandchildren (see killTree).
      detached: process.platform !== "win32",
    });

    let exited = false;
    let stdout = "";
    let stderr = "";
    let killedReason: "timeout" | "aborted" | null = null;

    // Linux/macOS: sh fork command con (sleep, make, npm…) rồi chết trước —
    // kill mỗi `child` để chúng mồ côi, còn giữ PIPE => 'close' không bao giờ
    // tới, tool treo, run không finish (fail CI serve-abort reproducibly).
    // detached:true cho child một process group riêng -> kill cả nhóm qua -pid.
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already dead / group gone */ }
    };

    const killChild = (reason: "timeout" | "aborted") => {
      killedReason = reason;
      killTree("SIGTERM");
      // SIGKILL escalation — sh chết nhưng GRANDCHILD ignore TERM thì group
      // vẫn sống; exitCode của bản thân sh không phản ánh điều đó, dùng `exited`.
      setTimeout(() => {
        if (!exited) killTree("SIGKILL");
      }, 5_000).unref();
    };

    const timer = setTimeout(() => killChild("timeout"), timeoutMs);

    const onAbort = () => killChild("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
       if (stdout.length < MAX_OUTPUT_CHARS) stdout += s.slice(0, MAX_OUTPUT_CHARS - stdout.length);
      onOutput?.("stdout", redactSecrets(s)); // G3
    });
    child.stderr?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
       if (stderr.length < MAX_OUTPUT_CHARS) stderr += s.slice(0, MAX_OUTPUT_CHARS - stderr.length);
      onOutput?.("stderr", redactSecrets(s)); // G3
    });

    child.on("error", (err) => {
      finish({ ok: false, output: clamp(`${echoLine}\n(spawn error) ${err.message}`) });
    });

    const buildResult = (code: number | null): ToolResult => {
      if (killedReason === "timeout") {
        return {
          ok: false,
          output: clamp(`${echoLine}\n(command timed out after ${Math.round(timeoutMs / 1000)}s and was killed)\n--- stdout ---\n${redactSecrets(stdout)}\n--- stderr ---\n${redactSecrets(stderr)}`),
        };
      }
      if (killedReason === "aborted") {
        return {
          ok: false,
          output: clamp(`${echoLine}\n(interrupted by user)\n--- stdout ---\n${redactSecrets(stdout)}\n--- stderr ---\n${redactSecrets(stderr)}`),
        };
      }
      const status = code ?? -1;
      // G3: redact trước khi output vào conversation/log/TUI.
      const redacted = redactSecrets(stdout);
      const redactedErr = redactSecrets(stderr);
      if (status === 0) {
        return { ok: true, output: clamp(`${echoLine}\n(exit 0)\n${redacted}`) };
      }
      return {
        ok: false,
        output: clamp(`${echoLine}\n(exit ${status})\n--- stdout ---\n${redacted}\n--- stderr ---\n${redactedErr}`),
      };
    };

    // 'close' chờ EOF của pipe; grandchild lì (khác process group — hiếm, hoặc
    // spawn của chính command) có thể giữ nó mở vĩnh viễn. Đã kill mà child
    // exit rồi thì resolve ngay trên 'exit', đừng đợi close.
    child.on("exit", (code) => {
      exited = true;
      if (killedReason) finish(buildResult(code));
    });

    child.on("close", (code) => {
      finish(buildResult(code));
    });
  });
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

