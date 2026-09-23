import { cpSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildApp } from "../src/app.ts";

const excluded = new Set([".runtime", "task-workspaces", "task-inbox"]);
const excludedPath = (path: string) => { const parts=path.split(/[\\/]/); return excluded.has(parts[0]) || parts[0]==="engineering" && parts[1]==="recursive"; };

/** Copy historical truth, never its live runtime or any external task association. */
export async function createArchiveBrowserServer(root: string, repo: string) {
  const source = join(repo, ".project");
  cpSync(source, join(root, ".project"), {recursive:true,filter:path => !excludedPath(relative(source,path))});
  cpSync(join(repo, "apps/web/dist"), join(root, "apps/web/dist"), {recursive:true});
  const before = archiveTruthHash(root);
  const app = await buildApp({
    root,
    gateway:"mock",
    readonlyLegacy:true,
    recoverInterrupted:false,
    humanApprovalVerifier: async (_request, requirement) => ({
      kind: "authenticated_human_approval",
      principalId: "isolated-archive-test-owner",
      approvalId: `archive-test-${randomUUID()}`,
      requestDigest: requirement.requestDigest,
      expiresAt: Date.now() + 60_000
    })
  });
  return {app,before};
}

export function archiveTruthHash(root: string) {
  const base = join(root, ".project"), hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path=join(directory,item.name), rel=relative(base,path);
      if (excludedPath(rel)) continue;
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) hash.update(rel.replaceAll("\\","/")).update(readFileSync(path));
    }
  };
  visit(base);return hash.digest("hex");
}
