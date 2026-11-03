/**
 * M4: hot-reload — watch .scoderrc + .scoder/skills/ (fs.watch, debounce
 * 500ms). onChange(kind) — Agent quyết định hành động (reload skills /
 * restart MCP). Module thuần, không dependency.
 */
import { watch, existsSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

export type ReloadKind = "config" | "skills";

const DEBOUNCE_MS = 500;

export interface ReloadWatcher {
  close(): void;
}

/** Watch rc file + skills dir. Fire onChange(kind) debounced (giữa các burst). */
export function watchWorkdir(
  workdir: string,
  onChange: (kind: ReloadKind) => void,
): ReloadWatcher {
  const watchers: FSWatcher[] = [];
  const timers = new Map<ReloadKind, ReturnType<typeof setTimeout>>();

  const fire = (kind: ReloadKind): void => {
    const t = timers.get(kind);
    if (t) clearTimeout(t);
    timers.set(kind, setTimeout(() => {
      timers.delete(kind);
      onChange(kind);
    }, DEBOUNCE_MS));
  };

  // .scoderrc (hoặc .scoderrc.json) — config changes.
  for (const name of [".scoderrc.json", ".scoderrc"]) {
    const p = join(workdir, name);
    if (!existsSync(p)) continue;
    try {
      watchers.push(watch(p, () => fire("config")));
    } catch { /* race — file removed between existsSync and watch */ }
  }
  // .scoder/skills/ — skill files added/removed/edited.
  const skillsDir = join(workdir, ".scoder", "skills");
  if (existsSync(skillsDir)) {
    try {
      watchers.push(watch(skillsDir, { recursive: true }, () => fire("skills")));
    } catch { /* platform không hỗ trợ recursive (hiếm trên macOS/Windows OK) */ }
  }

  return {
    close(): void {
      for (const w of watchers) {
        try { w.close(); } catch { /* already closed */ }
      }
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
