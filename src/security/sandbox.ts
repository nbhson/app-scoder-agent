/**
 * G4: Sandbox layer cho run_command (pattern từ opencode environment drivers —
 * detection-first, không hard-depend).
 *
 * Profiles:
 *  - "readonly"        — đọc mọi nơi, KHÔNG ghi được ở đâu (deny file-write*)
 *  - "workspace-write" — ghi trong workspace (+/tmp), đọc vẫn mở, mạng vẫn mở
 *
 * Có wrapper binary (sandbox-exec / bwrap / docker) → wrap lệnh. Wrapper thiếu
 * mà user đã BẬT sandbox một cách tường minh → fail CLOSED (từ chối chạy):
 * "sandbox bật" là một security promise, âm thầm chạy trần là promise giả.
 * Opt-out tường minh: sandbox.strict=false (warn + chạy trực tiếp như cũ).
 * ponytail: docker wrap chỉ build args cơ bản (volume workspace, không network
 * flag) — nâng cấp image/network khi có nhu cầu thực.
 */

export type SandboxProfile = "readonly" | "workspace-write";
export type SandboxWrapper = "sandbox-exec" | "bwrap" | "docker";

export interface SandboxPlan {
  wrapper: SandboxWrapper;
  /** Full argv: [wrapperBinary, ...wrapperArgs, "/bin/sh", "-c", command]. */
  argv: (string | SandboxProfile)[];
  profile: SandboxProfile;
}

export interface SandboxConfig {
  /** Force a wrapper; omit → auto-detect theo platform. */
  wrapper?: SandboxWrapper;
  /** "off" disables sandboxing entirely (default khi không set). */
  mode?: "readonly" | "workspace-write" | "off";
  /**
   * When a mode is explicitly on but its wrapper is missing: refuse to run the
   * command (default). Set false to warn and run unsandboxed instead.
   */
  strict?: boolean;
}

/** Workspace + temp dirs a command may always touch. */
export function sandboxWritePaths(workdir: string): string[] {
  return [workdir, "/tmp", "/private/tmp"];
}

/** Build the wrapper argv for a profile. Pure — unit-test được. */
export function buildSandboxArgv(
  wrapper: SandboxWrapper,
  profile: SandboxProfile,
  workdir: string,
  command: string,
): string[] {
  const writes = sandboxWritePaths(workdir);
  if (wrapper === "sandbox-exec") {
    // macOS Seatbelt: một profile string param, readonly chặn file-write-*.
    // Seatbelt đánh giá theo resolved path — /var/folders là symlink của
    // /private/var/folders, nên subpath phải phủ cả hai dạng.
    // P-perf (item 24): workdir realpath qua memo dùng chung với safePath —
    // lệnh sandboxed thứ N từng tự trả một syscall chain cho cùng workdir.
    let realWs = workdir;
    try { realWs = realWorkdirOf(workdir); } catch { /* nonexistent — raw path đủ */ }
    const escapeSbp = (p: string) => p.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const wsSubpaths = [...new Set([workdir, realWs])]
      .map((p) => `(subpath "${escapeSbp(p)}/")`)
      .join(" ");
    const allowWrites = profile === "workspace-write"
      ? `(allow file-write* ${wsSubpaths} (subpath "/tmp") (subpath "/private/tmp"))`
      : `(deny file-write*)`;
    const profileSbp = `(version 1)(deny default)(allow process*)(allow system-socket)(allow file-read*)(allow network*)(allow mach-lookup)(allow sysctl-read)${allowWrites}`;
    return [
      "sandbox-exec",
      "-p", profileSbp,
      "/bin/sh", "-c", command,
    ];
  }
  if (wrapper === "bwrap") {
    // bubblewrap: bind ro toàn hệ thống, rw workspace; unshare all để isolate.
    const args = [
      "bwrap",
      "--dev-bind", "/", "/", // giữ root — sandbox theo write-permission, không chroot
      "--ro-bind", "/", "/", // override: mọi mount ro
    ];
    if (profile === "workspace-write") {
      for (const w of writes) args.push("--bind", w, w);
    }
    args.push("--", "/bin/sh", "-c", command);
    return args;
  }
  // docker: volume workspace rw/ro, mount proc, no network isolation flag
  // (network giữ mở — nâng cấp khi cần).
  const roFlag = profile === "readonly" ? ":ro" : "";
  return [
    "docker", "run", "--rm",
    "-v", `${workdir}:/workspace${roFlag}`,
    "-w", "/workspace",
    "--entrypoint", "/bin/sh",
    "node:22-alpine",
    "-c", command,
  ];
}

/**
 * Detect available wrapper và trả plan, hoặc null khi không bật sandbox
 * (mode off/không set). Wrapper thiếu được xử ở resolveSandbox (fail closed).
 */
export function planSandbox(cfg: SandboxConfig, workdir: string, command: string): SandboxPlan | null {
  const mode = cfg.mode ?? "off";
  if (mode === "off") return null;
  const wrapper = cfg.wrapper ?? (process.platform === "darwin" ? "sandbox-exec" : "bwrap");
  return { wrapper, profile: mode, argv: buildSandboxArgv(wrapper, mode, workdir, command) };
}

/**
 * Spawn argv qua sandbox khi có plan; wrapper binary thiếu trên máy →
 * argv null + failClosed (mode được bật tường minh → caller phải từ chối
 * chạy; strict:false → warn-and-run như trước).
 */
// P-perf (item 24): wrapper presence is a machine property, not a command
// property — `spawnSync which` used to launch a child process (5–20 ms) on
// EVERY sandboxed run_command. Probe once per wrapper for the process life.
const wrapperPresent = new Map<SandboxWrapper, boolean>();

export async function resolveSandbox(
  cfg: SandboxConfig,
  workdir: string,
  command: string,
): Promise<
  | { argv: string[]; wrapper: SandboxWrapper; failClosed: false }
  | { argv: null; wrapper: null; reason: string; failClosed: boolean }
> {
  const plan = planSandbox(cfg, workdir, command);
  if (!plan) return { argv: null, wrapper: null, reason: "sandbox off", failClosed: false };
  let present = wrapperPresent.get(plan.wrapper);
  if (present === undefined) {
    // `which` không có trên Windows — dùng `where`.
    const check = spawnSync(process.platform === "win32" ? "where" : "which", [plan.wrapper], { encoding: "utf8" });
    present = check.status === 0;
    wrapperPresent.set(plan.wrapper, present);
  }
  if (!present) {
    // P0-sandbox: an explicitly-requested sandbox that silently vanishes is a
    // false promise — fail closed unless the user opted out via strict:false.
    const failClosed = cfg.strict !== false;
    return {
      argv: null,
      wrapper: null,
      reason: failClosed
        ? `${plan.wrapper} not found — refusing to run unsandboxed (sandbox.strict=false to override)`
        : `${plan.wrapper} not found — running unsandboxed`,
      failClosed,
    };
  }
  return { argv: plan.argv.map(String), wrapper: plan.wrapper, failClosed: false };
}

import { spawnSync } from "node:child_process";
import { realWorkdirOf } from "../tools/path-safety.js";
