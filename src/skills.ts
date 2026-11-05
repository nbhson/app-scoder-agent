/**
 * Skill discovery & loading for scoder.
 *
 * A skill is a directory containing a SKILL.md file with YAML-lite frontmatter.
 * Skills 2.0: supports array/nested frontmatter (version, tags, references),
 * progressive disclosure (index → body → references/*.md), allowed-tools
 * enforcement, auto-match scoring, and compat with Claude/OpenCode skill dirs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname } from "node:path";

export interface Skill {
  name: string;
  description: string;
  path: string;
  scope: "project" | "global";
  body: string;
  allowedTools?: string[];
  license?: string;
  whenToUse?: string;
  version?: string;
  tags?: string[];
  /** Reference file names/paths relative to the skill dir (progressive disclosure). */
  references?: string[];
  /** Directory containing SKILL.md (for resolving references). */
  dir?: string;
}

export interface SkillWarning {
  path: string;
  message: string;
}

const MAX_SKILL_BODY_CHARS = 20_000;

export const skillWarnings: SkillWarning[] = [];

/** Minimal YAML-lite parser supporting scalars, flow arrays, block arrays, nested. */
export function parseFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = parseYamlLite(m[1]);
  return { meta, body: m[2].trim() };
}

function parseYamlLite(src: string): Record<string, any> {
  const lines = src.split(/\r?\n/);
  const out: Record<string, any> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const kv = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) { i++; continue; }
    const key = kv[1].toLowerCase();
    const raw = kv[2].trim();
    if (raw === "") {
      // block array or nested
      const items: any[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        const item = lines[j].trim().replace(/^-\s+/, "").trim();
        items.push(stripQuotes(item));
        j++;
      }
      if (items.length > 0) { out[key] = items; i = j; continue; }
      out[key] = "";
      i++;
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1).trim();
      out[key] = inner === "" ? [] : inner.split(",").map((s) => stripQuotes(s.trim())).filter((s) => s !== "");
      i++;
      continue;
    }
    out[key] = stripQuotes(raw);
    i++;
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

export function loadSkillFile(path: string, scope: Skill["scope"]): Skill | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const { meta, body } = parseFrontmatter(text);
  const name = String(meta.name || "").trim() || null;
  if (!name) return null;
  const description = String(meta.description || "").trim();
  if (!description) {
    skillWarnings.push({ path, message: `skill "${name}" thiếu description — bỏ qua` });
    return null;
  }
  const allowedToolsRaw = meta["allowed-tools"] ?? meta.allowedtools ?? meta.allowed_tools;
  const allowedTools = Array.isArray(allowedToolsRaw)
    ? allowedToolsRaw.map(String)
    : (typeof allowedToolsRaw === "string" && allowedToolsRaw.trim()
        ? String(allowedToolsRaw).split(",").map((t) => t.trim()).filter(Boolean)
        : undefined);
  const tagsRaw = meta.tags;
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String) : (typeof tagsRaw === "string" && tagsRaw.trim() ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined);
  const referencesRaw = meta.references;
  const references = Array.isArray(referencesRaw) ? referencesRaw.map(String) : (typeof referencesRaw === "string" && referencesRaw.trim() ? referencesRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined);
  const dir = path.replace(/[\\/]SKILL\.md$/i, "");
  // discover reference files in references/ subdir
  const refDir = join(dir, "references");
  const refFiles: string[] = [];
  if (existsSync(refDir)) {
    try {
      for (const f of readdirSync(refDir)) {
        if (extname(f).toLowerCase() === ".md") refFiles.push(f);
      }
    } catch { /* ignore */ }
  }
  const allRefs = [...(references ?? []), ...refFiles.filter((f) => !(references ?? []).includes(f))];
  return {
    name,
    description,
    path,
    scope,
    body: body.length > MAX_SKILL_BODY_CHARS ? body.slice(0, MAX_SKILL_BODY_CHARS) + "\n… [truncated]" : body,
    dir,
    ...(allowedTools && allowedTools.length ? { allowedTools } : {}),
    ...(meta.license ? { license: String(meta.license) } : {}),
    ...(meta["when-to-use"] || meta.whentouse ? { whenToUse: String(meta["when-to-use"] || meta.whentouse) } : {}),
    ...(meta.version ? { version: String(meta.version) } : {}),
    ...(tags ? { tags } : {}),
    ...(allRefs.length ? { references: allRefs } : {}),
  };
}

function globalSkillsRoots(): string[] {
  const roots = [];
  const base = process.env.SCODER_SKILLS || join(homedir(), ".scoder", "skills");
  roots.push(base);
  // compat: Claude / OpenCode skill dirs
  roots.push(join(homedir(), ".claude", "skills"));
  roots.push(join(homedir(), ".opencode", "skills"));
  return roots;
}

function projectSkillsRoots(workdir: string): string[] {
  return [
    join(workdir, ".scoder", "skills"),
    join(workdir, ".claude", "skills"),
    join(workdir, ".opencode", "skills"),
  ];
}

function scanRoot(root: string, scope: Skill["scope"]): Skill[] {
  if (!existsSync(root)) return [];
  const out: Skill[] = [];
  // Skills may be <root>/<name>/SKILL.md OR <root>/*.md (flat) for compat.
  // First: directory form.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const file = join(root, entry.name, "SKILL.md");
      if (existsSync(file)) {
        const skill = loadSkillFile(file, scope);
        if (skill) out.push(skill);
      }
      // also nested references not skills
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "skill.md") {
      // flat skill file: name from frontmatter or filename
      const skill = loadSkillFile(join(root, entry.name), scope);
      if (skill) out.push(skill);
    }
  }
  // If root itself contains SKILL.md
  const self = join(root, "SKILL.md");
  if (existsSync(self)) {
    const skill = loadSkillFile(self, scope);
    if (skill) out.push(skill);
  }
  return out;
}

export function discoverSkills(workdir: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of [...globalSkillsRoots(), ...projectSkillsRoots(workdir)]) {
    const scope: Skill["scope"] = root.includes(workdir) ? "project" : "global";
    for (const s of scanRoot(root, scope)) {
      if (byName.has(s.name)) {
        skillWarnings.push({ path: s.path, message: `skill "${s.name}" trùng tên (${s.scope} overrides ${byName.get(s.name)?.scope})` });
      }
      byName.set(s.name, s);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(workdir: string, name: string): Skill | null {
  const wanted = name.toLowerCase();
  return discoverSkills(workdir).find((s) => s.name.toLowerCase() === wanted) ?? null;
}

export function formatSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return skills.map((s) => {
    const tags = s.tags?.length ? ` [${s.tags.join(",")}]` : "";
    return `- ${s.name}: ${s.description || "(no description)"}${tags}`;
  }).join("\n");
}

/** Progressive disclosure: read a reference file's content. */
export function readSkillReference(skill: Skill, ref: string): string | null {
  if (!skill.dir) return null;
  const candidates = [join(skill.dir, ref), join(skill.dir, "references", ref)];
  for (const c of candidates) {
    try { if (existsSync(c)) return readFileSync(c, "utf8"); } catch { /* ignore */ }
  }
  return null;
}

/** Load a section of a skill body by heading name (case-insensitive). */
export function loadSkillSection(skill: Skill, section?: string): string {
  if (!section) return skill.body;
  const lines = skill.body.split(/\r?\n/);
  const target = section.toLowerCase().trim();
  let collecting = false;
  const out: string[] = [];
  for (const line of lines) {
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      if (collecting) break;
      if (hm[2].toLowerCase().trim() === target) { collecting = true; continue; }
      continue;
    }
    if (collecting) out.push(line);
  }
  return collecting ? out.join("\n").trim() : skill.body;
}

/** Auto-match scoring: rank skills by keyword overlap with task text. */
export function scoreSkills(task: string, skills: Skill[]): Array<{ skill: Skill; score: number }> {
  const tokens = new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  return skills.map((s) => {
    const haystack = `${s.name} ${s.description} ${s.whenToUse ?? ""} ${(s.tags ?? []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (haystack.includes(t)) score += 1;
    // name match bonus
    if (tokens.has(s.name.toLowerCase())) score += 3;
    return { skill: s, score };
  }).sort((a, b) => b.score - a.score);
}

/** Filter tool specs by an allowed-tools list (glob-ish names). */
export function filterToolsByAllowed(specs: ToolSpecLike[], allowed: string[]): ToolSpecLike[] {
  if (!allowed || allowed.length === 0) return specs;
  const set = new Set(allowed.map((a) => a.toLowerCase()));
  return specs.filter((s) => set.has(String(s.name ?? s.function?.name ?? "").toLowerCase()));
}

interface ToolSpecLike { name?: string; function?: { name?: string } }
