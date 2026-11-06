# context/ — prompt & context window

**Responsibility:** system prompt assembly (`prompt.ts`, `prompt-builder.ts`),
history trim (`context.ts`), compaction (`compaction.ts`), repo map
(`repo-map.ts`), working memory (`memory.ts`), skills (`skills.ts`), agent
definitions/discovery (`agents.ts`, `agents-guide.ts`).

**Public API:** via root facades (`../prompt.ts`, `../skills.ts`, …).

**Allowed imports:** core domains; never `tui/`.

**Anti-patterns:** changing prompt text/ordering without a characterization
test — prompts are a compatibility surface.
