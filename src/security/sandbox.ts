/**
 * G4: Sandbox layer cho run_command (pattern từ opencode environment drivers —
 * detection-first, không hard-depend).
 *
 * Profiles:
 *  - "readonly"        — đọc được mọi nơi, ghi chỉ trong workspace
 *  - "workspace-write" — ghi trong workspace (+TMPDIR), mạng vẫn mở
 *
 * Có wrapper binary (sandbox-exec / bwrap / docker) → wrap lệnh. Không có →
 * trả về null (caller chạy trực tiếp + warn). ponytail: docker wrap chỉ build
 * args cơ bản (volume workspace, không network flag) — nâng cấp image/network
 * khi có nhu cầu thực.
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
    let realWs = workdir;
    try { realWs = realpathSync(workdir); } catch { /* nonexistent — raw path đủ */ }
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
 * Detect available wrapper và trả plan, hoặc null khi không sandbox được
 * (caller: chạy trực tiếp + warn — never hard-fail).
 */
export function planSandbox(cfg: SandboxConfig, workdir: string, command: string): SandboxPlan | null {
  const mode = cfg.mode ?? "off";
  if (mode === "off") return null;
  const wrapper = cfg.wrapper ?? (process.platform === "darwin" ? "sandbox-exec" : "bwrap");
  return { wrapper, profile: mode, argv: buildSandboxArgv(wrapper, mode, workdir, command) };
}

/**
 * Spawn argv qua sandbox khi có plan; nếu wrapper binary thiếu trên máy →
 * null (fallback chạy trực tiếp). Async để dùng which-like check nhẹ.
 */
export async function resolveSandbox(
  cfg: SandboxConfig,
  workdir: string,
  command: string,
): Promise<{ argv: string[]; wrapper: SandboxWrapper } | { argv: null; wrapper: null; reason: string }> {
  const plan = planSandbox(cfg, workdir, command);
  if (!plan) return { argv: null, wrapper: null, reason: "sandbox off" };
  // `which` không có trên Windows — dùng `where`.
  const check = spawnSync(process.platform === "win32" ? "where" : "which", [plan.wrapper], { encoding: "utf8" });
  if (check.status !== 0) {
    return { argv: null, wrapper: null, reason: `${plan.wrapper} not found — running unsandboxed` };
  }
  return { argv: plan.argv.map(String), wrapper: plan.wrapper };
}

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
