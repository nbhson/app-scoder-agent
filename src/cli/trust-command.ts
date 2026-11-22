/**
 * `scoder trust` — one-time approval of a project directory's
 * configuration (.scoderrc.json sensitive fields, committed saved
 * approvals). See src/config/trust.ts for the policy this writes.
 */

export async function runTrustCommand(restArgs: string[], workdir: string): Promise<void> {
  const { trustProject, untrustProject, listTrustedProjects, trustFilePath } =
    await import("../config/trust.js");
  const { resolve } = await import("node:path");

  if (restArgs.includes("--list")) {
    const roots = listTrustedProjects();
    if (roots.length === 0) {
      console.log(`no trusted directories (${trustFilePath()})`);
      return;
    }
    console.log(`trusted project directories (${trustFilePath()}):`);
    for (const r of roots) console.log(`  ${r}`);
    return;
  }

  if (restArgs.includes("--revoke")) {
    const target = restArgs.find((a) => a !== "--revoke") ?? workdir;
    const removed = untrustProject(resolve(target));
    console.log(removed ? `revoked trust for ${resolve(target)}` : `${resolve(target)} was not trusted`);
    return;
  }

  const target = restArgs.find((a) => !a.startsWith("--")) ?? workdir;
  const trusted = trustProject(resolve(target));
  console.log(`trusted project directory: ${trusted}`);
  console.log(`  ${target === workdir || resolve(target) === resolve(workdir)
    ? "project settings in this directory now apply (stored in " + trustFilePath() + ")"
    : "run scoder from that directory, or its settings now apply to anything under it"}`);
}
