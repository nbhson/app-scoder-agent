# Skills System

Skills are reusable instruction packs ("SKILL.md") that scoder loads into context when a task matches.

## File Structure

```
.scoder/skills/code-review/SKILL.md    # project-level
~/.scoder/skills/code-review/SKILL.md  # global
```

## SKILL.md Format

```markdown
---
name: code-review
description: Review code for bugs, security issues, and style
allowed-tools: read_file, grep
license: MIT
when-to-use: Run after any multi-file change before committing
---
Read the current diff. Check for: null derefs, injection risks, ...
```

## Metadata Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier |
| `description` | Yes | When/how the agent uses this skill |
| `allowed-tools` | No | Informational tool list |
| `license` | No | License for the skill content |
| `when-to-use` | No | Guidance on when to activate |

## Usage

**Advertised to the model** — every run's system prompt lists skill names + descriptions; the agent reads a matching `SKILL.md` itself via `read_file`.

**Explicit load** — stage a skill before your next task:

```bash
scoder
> /skill code-review
> fix the null pointer bug
```

**List available skills:**

```bash
> /skills
```

## Hot Reload

`.scoder/skills/` is watched (debounced 500ms). A skill added mid-session is advertised on the next turn — no restart needed.

## Validation

- Skills without `description` are skipped with a warning
- Duplicate names across scopes warn (project wins)