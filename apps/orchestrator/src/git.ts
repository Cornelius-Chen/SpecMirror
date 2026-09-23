import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", root, ...args], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface MergeGateInput {
  expectedStartSha: string;
  currentMainSha: string;
  regressionPassed: boolean;
  reviewerApproved: boolean;
  scopeClean: boolean;
  sharedContractsUnchanged: boolean;
  hasMergeConflicts: boolean;
}

export function mergeGateFailures(input: MergeGateInput): string[] {
  const failures: string[] = [];
  if (input.currentMainSha !== input.expectedStartSha) failures.push("main_sha_changed");
  if (!input.regressionPassed) failures.push("regression_failed");
  if (!input.reviewerApproved) failures.push("review_rejected");
  if (!input.scopeClean) failures.push("scope_violation");
  if (!input.sharedContractsUnchanged) failures.push("shared_contract_changed");
  if (input.hasMergeConflicts) failures.push("merge_conflict");
  return failures;
}

export class GitController {
  constructor(readonly root: string) {}

  head(ref = "HEAD") { return git(this.root, ["rev-parse", ref]); }
  currentBranch() { return git(this.root, ["branch", "--show-current"]); }
  changedFiles(base: string, head = "HEAD") { return git(this.root, ["diff", "--name-only", `${base}...${head}`]).split(/\r?\n/).filter(Boolean); }

  goalWorktreePath(goalId: string) {
    return join(resolve(this.root, "..", `${this.#safeRepoName()}-worktrees`), goalId);
  }

  allChangedFiles(base: string) {
    const tracked = git(this.root, ["diff", "--name-only", base]).split(/\r?\n/).filter(Boolean);
    const untracked = git(this.root, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
    return [...new Set([...tracked, ...untracked].map((path) => path.replaceAll("\\", "/")))].sort();
  }

  commitAll(message: string) {
    const dirty = git(this.root, ["status", "--porcelain"]);
    if (!dirty) return this.head();
    git(this.root, ["add", "-A"]);
    git(this.root, ["commit", "-m", message]);
    return this.head();
  }

  createGoalWorktree(goalId: string, startSha: string) {
    const parent = resolve(this.root, "..", `${this.#safeRepoName()}-worktrees`);
    mkdirSync(parent, { recursive: true });
    const path = this.goalWorktreePath(goalId);
    const branch = `codex/goal/${goalId}`;
    if (existsSync(path)) {
      const registered = git(this.root, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .some((line) => line === `worktree ${path}` || line === `worktree ${path.replaceAll("\\", "/")}`);
      if (!registered) throw new Error(`unmanaged_worktree_path_exists: ${path}`);
      return { path, branch };
    }
    if (gitSucceeds(this.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
      git(this.root, ["worktree", "add", path, branch]);
    } else {
      git(this.root, ["worktree", "add", "-b", branch, path, startSha]);
    }
    return { path, branch };
  }

  mergeDependencies(branches: string[]) {
    for (const branch of branches) git(this.root, ["merge", "--no-ff", "--no-edit", branch]);
  }

  removeGoalWorktree(path: string) {
    const absolute = resolve(path);
    const allowedParent = resolve(this.root, "..", `${this.#safeRepoName()}-worktrees`);
    if (dirname(absolute) !== allowedParent) throw new Error("Refusing to remove worktree outside managed parent.");
    git(this.root, ["worktree", "remove", absolute]);
  }

  createCheckpoint(changeSetId: string, sha: string) {
    const branch = `codex/checkpoint/${changeSetId}`;
    if (gitSucceeds(this.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
      const existing = this.head(branch);
      if (existing !== sha) throw new Error(`checkpoint_mismatch: ${branch}`);
    } else {
      git(this.root, ["branch", branch, sha]);
    }
    return branch;
  }

  integrateBranches(options: {
    changeSetId: string;
    mainBranch: string;
    expectedStartSha: string;
    goalBranches: string[];
    runRegression: (worktreePath: string) => boolean;
  }) {
    this.assertMainUnchanged(options.expectedStartSha, options.mainBranch);
    if (this.currentBranch() !== options.mainBranch) throw new Error(`main_not_checked_out: ${options.mainBranch}`);
    const integrationBranch = `codex/integration/${options.changeSetId}`;
    const parent = resolve(this.root, "..", `${this.#safeRepoName()}-worktrees`);
    const integrationPath = join(parent, `integration-${options.changeSetId}`);
    mkdirSync(parent, { recursive: true });
    if (existsSync(integrationPath)) throw new Error(`integration_worktree_exists: ${integrationPath}`);
    if (gitSucceeds(this.root, ["show-ref", "--verify", "--quiet", `refs/heads/${integrationBranch}`])) {
      git(this.root, ["branch", "-f", integrationBranch, options.expectedStartSha]);
    } else git(this.root, ["branch", integrationBranch, options.expectedStartSha]);
    let worktreeAdded = false;
    let integrated = false;
    try {
      git(this.root, ["worktree", "add", integrationPath, integrationBranch]);
      worktreeAdded = true;
      for (const branch of options.goalBranches) git(integrationPath, ["merge", "--no-ff", "--no-edit", branch]);
      if (!options.runRegression(integrationPath)) throw new Error("regression_failed");
      this.assertMainUnchanged(options.expectedStartSha, options.mainBranch);
      const checkpoint = this.createCheckpoint(options.changeSetId, options.expectedStartSha);
      git(this.root, ["merge", "--ff-only", integrationBranch]);
      integrated = true;
      return { checkpoint, integrationBranch, mergedSha: this.head(options.mainBranch) };
    } finally {
      if (worktreeAdded) {
        try { git(this.root, ["worktree", "remove", "--force", integrationPath]); } catch { /* keep branch for recovery */ }
      }
      if (integrated) try { git(this.root, ["branch", "-D", integrationBranch]); } catch { /* merged branch is harmless */ }
    }
  }

  assertMainUnchanged(expectedSha: string, mainBranch: string) {
    const actual = this.head(mainBranch);
    if (actual !== expectedSha) throw new Error(`main_sha_changed: expected ${expectedSha}, received ${actual}`);
  }

  #safeRepoName() { return this.root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)!.replace(/[^a-zA-Z0-9._-]/g, "-"); }
}
