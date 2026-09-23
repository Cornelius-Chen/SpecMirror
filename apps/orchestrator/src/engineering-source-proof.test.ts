import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureEngineeringSourceBaseline, freezeEngineeringSourceScope, verifyEngineeringSourceProof, type EngineeringSourceScope } from "./engineering-source-proof.ts";

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "mirror-source-proof-")); roots.push(root); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "one.js"), "export const value = 1;\n"); return root; };
const scope = (root: string, overrides: Partial<EngineeringSourceScope> = {}) => freezeEngineeringSourceScope({ root, allow: ["src/**"], deny: ["src/private/**"], checks: [{ id: "syntax", title: "实际检查 JavaScript 语法", program: "node", args: ["--check", "src/one.js"] }], ...overrides }, [root]);
afterEach(() => {
  for (const root of roots.splice(0)) {
    const full = resolve(root);
    if (!full.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_cleanup");
    rmSync(full, { recursive: true, force: true });
  }
});

describe("frozen working-tree source proof", () => {
  it("verifies allowed additions, edits and deletion against the actual starting files", async () => {
    const root = fixture(); writeFileSync(join(root, "src", "remove.js"), "export default 1;\n");
    const baseline = captureEngineeringSourceBaseline(scope(root));
    writeFileSync(join(root, "src", "one.js"), "export const value = 2;\n");
    writeFileSync(join(root, "src", "new.js"), "export default 2;\n");
    rmSync(join(root, "src", "remove.js"));
    const proof = await verifyEngineeringSourceProof(baseline, [root]);
    expect(proof).toMatchObject({ status: "passed", passed: true, source_changed_during_checks: false });
    expect(proof.changes.map(change => [change.path, change.kind, change.allowed])).toEqual([["src/new.js", "added", true], ["src/one.js", "modified", true], ["src/remove.js", "deleted", true]]);
    expect(proof.checks[0]).toMatchObject({ status: "passed", exit_code: 0, program: "node", error: null });
    expect(proof.checks[0].command_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.manifest.find(file => file.path === "src/one.js")?.sha256).toBe(proof.changes[1].before_sha256);
  });
  it("rejects an unapproved root and traversal patterns before any check runs", () => {
    const root = fixture(), outside = fixture();
    expect(() => freezeEngineeringSourceScope({ ...scope(root), root: outside }, [root])).toThrow("授权");
    expect(() => scope(root, { allow: ["../other/**"] })).toThrow("越界");
    expect(() => scope(root, { allow: ["C:/outside/**"] })).toThrow("越界");
    expect(() => scope(root, { checks: [] })).toThrow("至少");
  });
  it("fails denied and outside-allow changes, including deletions, without executing commands", async () => {
    const root = fixture(); mkdirSync(join(root, "src", "private"));
    writeFileSync(join(root, "src", "private", "secret.js"), "private original");
    writeFileSync(join(root, "README.md"), "original");
    const baseline = captureEngineeringSourceBaseline(scope(root));
    rmSync(join(root, "src", "private", "secret.js")); writeFileSync(join(root, "README.md"), "changed");
    const proof = await verifyEngineeringSourceProof(baseline, [root]);
    expect(proof.status).toBe("failed");
    expect(proof.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md", reason: "outside_allow", allowed: false }), expect.objectContaining({ path: "src/private/secret.js", kind: "deleted", reason: "denied", allowed: false })]));
    expect(proof.checks.every(check => check.status === "not_run")).toBe(true);
  });
  it("uses tracked plus untracked Git files and preserves existing uncommitted changes", async () => {
    const root = fixture();
    const git = (...args: string[]) => { const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, shell: false }); expect(result.status, result.stderr).toBe(0); return result.stdout; };
    git("init", "--quiet"); writeFileSync(join(root, ".gitignore"), "ignored/\ndist/\n"); git("add", ".");
    git("-c", "user.name=Mirror fixture", "-c", "user.email=fixture@localhost", "commit", "--quiet", "-m", "fixture baseline");
    writeFileSync(join(root, "src", "one.js"), "export const value = 'preexisting dirty';\n");
    writeFileSync(join(root, "src", "untracked.js"), "export const untracked = true;\n");
    mkdirSync(join(root, "ignored")); writeFileSync(join(root, "ignored", "private.txt"), "never hash ignored content");
    mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist", "bundle.js"), "generated");
    const baseline = captureEngineeringSourceBaseline(scope(root));
    expect(baseline.git).toMatchObject({ repository: true, head_sha: expect.stringMatching(/^[a-f0-9]{40,64}$/) });
    expect(baseline.manifest.map(file => file.path)).toContain("src/untracked.js");
    expect(baseline.git.preexisting_changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/one.js", status: " M" }), { path: "src/untracked.js", status: "??" }]));
    expect(baseline.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ path: "ignored/", reason: "git_ignored" }), expect.objectContaining({ path: "dist/", reason: "generated_or_runtime" })]));
    writeFileSync(join(root, "src", "untracked.js"), "export const untracked = 'this run';\n");
    const proof = await verifyEngineeringSourceProof(baseline, [root]);
    expect(proof.passed).toBe(true); expect(proof.changes.map(change => change.path)).toEqual(["src/untracked.js"]);
    expect(proof.preexisting_changes).toEqual(baseline.git.preexisting_changes);
    expect(readFileSync(join(root, "src", "one.js"), "utf8")).toContain("preexisting dirty");
  });
  it("does not traverse source symlinks or directory junctions", async () => {
    const root = fixture(), outside = fixture();
    const baseline = captureEngineeringSourceBaseline(scope(root));
    symlinkSync(join(outside, "src"), join(root, "src", "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(() => captureEngineeringSourceBaseline(scope(root))).toThrow("符号链接");
    const proof = await verifyEngineeringSourceProof(baseline, [root]);
    expect(proof).toMatchObject({ status: "blocked", passed: false });
    expect(proof.checks[0].status).toBe("not_run");
    expect(() => freezeEngineeringSourceScope({ ...scope(outside), root: join(root, "src", "escape") }, [root])).toThrow("符号链接");
  });
  it("records actual command failure and bounded redacted error instead of trusting a passed claim", async () => {
    const root = fixture();
    const frozen = scope(root, { checks: [{ id: "failing", title: "实际失败检查", program: "node", args: ["-e", "console.error('token=not-for-the-report'); process.exit(7)"] }] });
    const proof = await verifyEngineeringSourceProof(captureEngineeringSourceBaseline(frozen), [root]);
    expect(proof).toMatchObject({ status: "failed", passed: false });
    expect(proof.checks[0]).toMatchObject({ status: "failed", exit_code: 7 });
    expect(proof.checks[0].error).toContain("已脱敏");
    expect(JSON.stringify(proof)).not.toContain("not-for-the-report");
  });
  it("terminates a timed-out check and records its actual state", async () => {
    const root = fixture();
    const frozen = scope(root, { checks: [{ id: "timeout", title: "实际超时检查", program: "node", args: ["-e", "setInterval(()=>{},1000)"], timeout_ms: 80 }] });
    const proof = await verifyEngineeringSourceProof(captureEngineeringSourceBaseline(frozen), [root]);
    expect(proof).toMatchObject({ status: "failed", passed: false }); expect(proof.checks[0].status).toBe("timeout");
    expect(proof.checks[0].duration_ms).toBeLessThan(5000);
  });
  it("detects source mutation during the check and excludes generated output explicitly", async () => {
    const root = fixture(); mkdirSync(join(root, ".runtime")); writeFileSync(join(root, ".runtime", "cache.json"), "{}");
    const frozen = scope(root, { checks: [{ id: "mutating", title: "不得以改写后的检查冒充结果", program: "node", args: ["-e", "require('node:fs').writeFileSync('src/one.js','export const value = 3;')"] }] });
    const baseline = captureEngineeringSourceBaseline(frozen);
    expect(baseline.exclusions).toContainEqual({ path: ".runtime/", reason: "generated_or_runtime" });
    expect(baseline.manifest.some(file => file.path.startsWith(".runtime"))).toBe(false);
    const proof = await verifyEngineeringSourceProof(baseline, [root]);
    expect(proof).toMatchObject({ status: "failed", passed: false, source_changed_during_checks: true });
    expect(proof.checks[0].status).toBe("passed");
  });
  it("rejects changed baseline hashes or revoked source roots", async () => {
    const root = fixture(), outside = fixture(), baseline = captureEngineeringSourceBaseline(scope(root));
    const tampered = structuredClone(baseline); tampered.manifest[0].sha256 = "0".repeat(64);
    expect((await verifyEngineeringSourceProof(tampered, [root])).status).toBe("blocked");
    expect((await verifyEngineeringSourceProof(baseline, [outside])).status).toBe("blocked");
  });
  it("excludes only an explicitly registered external project link and freezes its registration evidence", async () => {
    const root = fixture(), outside = fixture(), project = join(root, "projects", "external");
    mkdirSync(join(project, ".project"), { recursive: true });
    writeFileSync(join(project, ".project", "project.yaml"), "schema_version: 1\nid: project-external\nrepository:\n  root: source\n");
    symlinkSync(outside, join(project, "source"), process.platform === "win32" ? "junction" : "dir");
    const baseline = captureEngineeringSourceBaseline(scope(root));
    expect(baseline.exclusions).toContainEqual({ path: "projects/external/source/", reason: "external_project_reference" });
    expect(baseline.exclusion_rules.some(rule => rule.includes("projects/external/.project/project.yaml; sha256="))).toBe(true);
    expect(baseline.manifest.some(file => file.path.includes("external/source"))).toBe(false);
    expect((await verifyEngineeringSourceProof(baseline, [root])).passed).toBe(true);
    writeFileSync(join(project, ".project", "project.yaml"), "schema_version: 1\nid: project-external\ntitle: Changed during run\nrepository:\n  root: source\n");
    const proof = await verifyEngineeringSourceProof(baseline, [root]);
    expect(proof.status).toBe("blocked"); expect(proof.error).toContain("排除规则");
    const unregistered = join(root, "projects", "unregistered"); mkdirSync(unregistered);
    symlinkSync(outside, join(unregistered, "source"), process.platform === "win32" ? "junction" : "dir");
    expect(() => captureEngineeringSourceBaseline(scope(root))).toThrow("符号链接");
  });
  it("rejects a broken Git repository instead of silently reporting a non-Git inventory", () => {
    const root = fixture(); writeFileSync(join(root, ".git"), "gitdir: missing-repository\n");
    expect(() => captureEngineeringSourceBaseline(scope(root))).toThrow("Git");
  });
  it("rejects shared hardlinks instead of claiming a directory-local change boundary", () => {
    const root = fixture(), outside = fixture(); linkSync(join(outside, "src", "one.js"), join(root, "src", "shared.js"));
    expect(() => captureEngineeringSourceBaseline(scope(root))).toThrow("共享硬链接");
  });
  it("cancels an actual running check, awaits process exit and never starts later checks", async () => {
    const root = fixture(); mkdirSync(join(root, ".runtime"));
    const frozen = scope(root, { checks: [
      { id: "long-running", title: "取消实际进程", program: "node", args: ["-e", "console.log('started');setTimeout(()=>require('node:fs').writeFileSync('.runtime/late.txt','must not appear'),1200);setInterval(()=>{},1000)"] },
      { id: "must-not-start", title: "取消后不再启动", program: "node", args: ["-e", "require('node:fs').writeFileSync('.runtime/second.txt','must not appear')"] }
    ] });
    const baseline = captureEngineeringSourceBaseline(frozen), controller = new AbortController();
    const pending = verifyEngineeringSourceProof(baseline, [root], { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 250);
    const proof = await pending; clearTimeout(timer);
    expect(proof).toMatchObject({ passed: false, status: "failed" });
    expect(proof.checks.map(check => check.status)).toEqual(["cancelled", "cancelled"]);
    expect(proof.checks[0].output_bytes).toBeGreaterThan(0); expect(proof.checks[1].duration_ms).toBe(0);
    await new Promise(done => setTimeout(done, 1300));
    expect(existsSync(join(root, ".runtime", "late.txt"))).toBe(false); expect(existsSync(join(root, ".runtime", "second.txt"))).toBe(false);
  });
});
