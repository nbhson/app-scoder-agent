# shared/ — common utilities

**Responsibility:** constants (`constants.ts`), version + client name
(`version.ts`, reads `package.json` two levels up), JSON schema helpers
(`json-schema.ts`).

**Allowed imports:** none from other domains (leaf).

**Anti-patterns:** adding domain logic here.
