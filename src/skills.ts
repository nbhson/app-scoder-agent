/**
 * Skill discovery & loading for scoder.
 *
 * A skill is a directory containing a SKILL.md file with YAML-lite frontmatter:
 *
 *   ---
 *   name: code-review
 *   description: Review code for bugs, security issues, and style
 *   ---
 *   (markdown instructions the agent follows)
 *
 * Discovery order (later wins on name conflict):
 *   1. ~/.scoder/skills/<name>/SKILL.md   (global, user-level)
 *   2. <workdir>/.scoder/skills/<name>/SKILL.md (project-local)
 *
 * Skills are advertised to the model in the system prompt (name + description)
 * so it can request one explicitly; users can also load one directly via
 * `/skill <name>`. Inspired by the SKILL.md convention, implemented from
 * scratch — no external dependencies.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Skill {
  /** Frontmatter name (defaults to directory name). */
  name: string;
  /** One-line description shown in listings and the system prompt. */
  description: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** Whether it came from the project (.scoder/skills) or the home dir. */
  scope: "project" | "global";
  /** Markdown body (everything after the frontmatter). */
  body: string;
}

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_BODY_CHARS = 20_000;

/** Parse a minimal YAML-lite frontmatter (key: value lines). */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

/** Read one SKILL.md into a Skill record (null when the file is malformed). */
export function loadSkillFile(path: string, scope: Skill["scope"]): Skill | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const name = (meta.name || "").trim() || null;
  if (!name) return null; // a skill without a usable name is not discoverable
  return {
    name,
    description: (meta.description || "").trim(),
    path,
    scope,
    body: body.length > MAX_SKILL_BODY_CHARS ? body.slice(0, MAX_SKILL_BODY_CHARS) + "\n… [truncated]" : body,
  };
}

/** Collect SKILL.md files from one skills root (one level of directories). */
function scanRoot(root: string, scope: Skill["scope"]): Skill[] {
  if (!existsSync(root)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, SKILL_FILE);
    if (!existsSync(file)) continue;
    const skill = loadSkillFile(file, scope);
    if (skill) out.push(skill);
  }
  return out;
}

/** Discover all skills visible to a project: global first, project overrides. */
export function discoverSkills(workdir: string): Skill[] {
  const global = scanRoot(join(homedir(), ".scoder", "skills"), "global");
  const project = scanRoot(join(workdir, ".scoder", "skills"), "project");
  const byName = new Map<string, Skill>();
  for (const s of [...global, ...project]) byName.set(s.name, s); // project wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Find one skill by (case-insensitive) name, or null. */
export function findSkill(workdir: string, name: string): Skill | null {
  const wanted = name.toLowerCase();
  return discoverSkills(workdir).find((s) => s.name.toLowerCase() === wanted) ?? null;
}

/**
 * One-line-per-skill advertisement for the system prompt — the model sees
 * names + descriptions and can ask to load a skill, or the user invokes
 * `/skill <name>` directly.
 */
export function formatSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n");
}
