import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_SMOKE_RUN_MARKER,
  createManagedCodexSmokeRun,
  removeSuccessfulManagedCodexSmokeRun,
  validateManagedCodexSmokeRun
} from "./codex-smoke-paths.ts";

const TEST_ROOT_PREFIX = "epm-codex-smoke-paths-";
const cleanupRoots: string[] = [];

function testRoot() {
  const root = mkdtempSync(join(tmpdir(), TEST_ROOT_PREFIX));
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) safeRemoveTestRoot(root);
});

describe("managed Codex smoke run paths", () => {
  it("creates an owned run container and an empty direct-child repo under the source root", () => {
    const source = testRoot();
    const run = createManagedCodexSmokeRun(source);
    const marker = JSON.parse(readFileSync(run.markerPath, "utf8")) as Record<string, unknown>;

    expect(run.sourceRoot).toBe(resolve(source));
    expect(run.managedRoot).toBe(join(resolve(source), ".project", ".runtime", "codex-smoke-runs"));
    expect(run.runRoot).toBe(join(run.managedRoot, `run-${run.token}`));
    expect(run.repo).toBe(join(run.runRoot, "repo"));
    expect(readdirSync(run.runRoot).sort()).toEqual([CODEX_SMOKE_RUN_MARKER, "repo"].sort());
    expect(readdirSync(run.repo)).toEqual([]);
    expect(marker).toMatchObject({
      schema_version: 1,
      kind: "specmirror-codex-smoke-run",
      token: run.token,
      source_root: run.sourceRoot,
      run_root: run.runRoot,
      repo_root: run.repo
    });
    expect(validateManagedCodexSmokeRun(run)).toEqual(run);
  });

  it("deletes only the exact successful run and preserves sibling runs and the managed root", () => {
    const source = testRoot();
    const first = createManagedCodexSmokeRun(source);
    const second = createManagedCodexSmokeRun(source);
    mkdirSync(join(first.runRoot, "repo-worktrees"));
    writeFileSync(join(first.runRoot, "repo-worktrees", "completed.txt"), "completed", "utf8");
    writeFileSync(join(second.repo, "preserved.txt"), "preserved", "utf8");

    removeSuccessfulManagedCodexSmokeRun(first);

    expect(existsSync(first.runRoot)).toBe(false);
    expect(existsSync(first.managedRoot)).toBe(true);
    expect(existsSync(second.runRoot)).toBe(true);
    expect(readFileSync(join(second.repo, "preserved.txt"), "utf8")).toBe("preserved");
  });

  it("fails closed and retains the run when the ownership token is altered", () => {
    const run = createManagedCodexSmokeRun(testRoot());
    const marker = JSON.parse(readFileSync(run.markerPath, "utf8")) as Record<string, unknown>;
    marker.token = "00000000-0000-4000-8000-000000000000";
    writeFileSync(run.markerPath, `${JSON.stringify(marker)}\n`, "utf8");

    expect(() => removeSuccessfulManagedCodexSmokeRun(run)).toThrow("smoke_run_marker_mismatch");
    expect(existsSync(run.runRoot)).toBe(true);
    expect(existsSync(run.repo)).toBe(true);
  });

  it("fails closed and retains the run when an unowned top-level entry is present", () => {
    const run = createManagedCodexSmokeRun(testRoot());
    writeFileSync(join(run.runRoot, "unexpected.txt"), "retain this scene", "utf8");

    expect(() => removeSuccessfulManagedCodexSmokeRun(run)).toThrow("smoke_run_top_level_not_allowed:unexpected.txt");
    expect(existsSync(run.runRoot)).toBe(true);
    expect(readFileSync(join(run.runRoot, "unexpected.txt"), "utf8")).toBe("retain this scene");
  });

  it("rejects forged descendant records before deleting the original direct-child run", () => {
    const run = createManagedCodexSmokeRun(testRoot());
    const forged = { ...run, runRoot: join(run.runRoot, "nested") };

    expect(() => removeSuccessfulManagedCodexSmokeRun(forged)).toThrow("smoke_run_root_mismatch");
    expect(existsSync(run.runRoot)).toBe(true);
  });

  it("rejects a repo reparse point during cleanup without touching its target", () => {
    const run = createManagedCodexSmokeRun(testRoot());
    const external = testRoot();
    const sentinel = join(external, "sentinel.txt");
    writeFileSync(sentinel, "outside", "utf8");
    rmSync(run.repo, { recursive: true, force: false });
    symlinkSync(external, run.repo, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => removeSuccessfulManagedCodexSmokeRun(run)).toThrow(/reparse_or_symlink|reparse_rejected/);
      expect(readFileSync(sentinel, "utf8")).toBe("outside");
      expect(existsSync(run.runRoot)).toBe(true);
    } finally {
      if (existsSync(run.repo) && lstatSync(run.repo).isSymbolicLink()) unlinkSync(run.repo);
    }
  });

  it("rejects a reparse point in the managed path during creation", () => {
    const source = testRoot();
    const external = testRoot();
    const sentinel = join(external, "sentinel.txt");
    const projectLink = join(source, ".project");
    writeFileSync(sentinel, "outside", "utf8");
    symlinkSync(external, projectLink, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => createManagedCodexSmokeRun(source)).toThrow("smoke_path_reparse_or_non_directory:reparse_or_symlink");
      expect(readFileSync(sentinel, "utf8")).toBe("outside");
      expect(readdirSync(external).sort()).toEqual(["sentinel.txt"]);
    } finally {
      if (existsSync(projectLink) && lstatSync(projectLink).isSymbolicLink()) unlinkSync(projectLink);
    }
  });
});

function safeRemoveTestRoot(candidate: string) {
  const temp = resolve(tmpdir());
  const target = resolve(candidate);
  const child = relative(temp, target);
  if (!child || child.startsWith("..") || isAbsolute(child) || !basename(target).startsWith(TEST_ROOT_PREFIX)) {
    throw new Error("unsafe_codex_smoke_paths_test_cleanup");
  }
  if (!existsSync(target)) return;
  const entry = lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("unsafe_codex_smoke_paths_test_root");
  const canonical = realpathSync.native(target);
  const canonicalChild = relative(realpathSync.native(temp), canonical);
  if (!canonicalChild || canonicalChild.startsWith("..") || isAbsolute(canonicalChild)) {
    throw new Error("unsafe_codex_smoke_paths_test_realpath");
  }
  rmSync(target, { recursive: true, force: false });
}
