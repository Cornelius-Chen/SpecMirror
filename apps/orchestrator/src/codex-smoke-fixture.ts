import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ChangeSet, GoalContract, Project } from "@epm/domain";
import { atomicWriteYaml, loadProject, readIndexEntityIds, rebuildIndex } from "@epm/spec-io";

export const CODEX_SMOKE_GOAL_ID = "goal-real-codex-smoke";
export const CODEX_SMOKE_CHANGE_ID = "change-real-codex-smoke";
export const CODEX_SMOKE_BASELINE_ID = "baseline-real-codex-smoke";
export const CODEX_SMOKE_MARKER = "SMOKE_OK";
export const CODEX_SMOKE_INITIAL_README = "# SpecMirror Codex smoke\n\n等待真实 Agent 写入验收标记。\n";
export const CODEX_SMOKE_EXPECTED_README = `${CODEX_SMOKE_INITIAL_README}${CODEX_SMOKE_MARKER}\n`;
const expectedReadmeBase64 = Buffer.from(CODEX_SMOKE_EXPECTED_README, "utf8").toString("base64");
export const CODEX_SMOKE_ACCEPTANCE_COMMAND = `node -e "const fs=require('node:fs');const actual=fs.readFileSync('README.md','utf8').replace(/\\r\\n/g,'\\n');const expected=Buffer.from('${expectedReadmeBase64}','base64').toString('utf8');process.exit(actual===expected?0:1)"`;

export interface CodexSmokeFixture {
  repo: string;
  mainBranch: string;
  startSha: string;
  goal: GoalContract;
  change: ChangeSet;
}

/**
 * Creates the complete disposable repository used by the real App Server smoke.
 * The production .project tree and AGENTS.md are deliberately not inputs: copying
 * either can put unrelated contracts in the Worker's committed worktree.
 */
export function createCodexSmokeFixture(
  repo: string,
  boundary: { allowedParent?: string; exactName?: string } = {}
): CodexSmokeFixture {
  const target = assertSafeEmptySmokeRoot(repo, boundary);
  git(target, ["init"]);
  git(target, ["config", "user.email", "specmirror-smoke@local.invalid"]);
  git(target, ["config", "user.name", "SpecMirror Smoke"]);
  const mainBranch = git(target, ["branch", "--show-current"]);

  writeFileSync(join(target, ".gitignore"), [
    ".project/.runtime/",
    ".project/changes/",
    ".project/goals/",
    ".project/runs/",
    ".project/reviews/",
    ".project/proposals/",
    ""
  ].join("\n"), "utf8");
  writeFileSync(join(target, "README.md"), CODEX_SMOKE_INITIAL_README, "utf8");
  writeFileSync(join(target, "AGENTS.md"), smokeAgentInstructions(), "utf8");
  atomicWriteYaml(join(target, ".project", "project.yaml"), smokeProject(mainBranch));
  atomicWriteYaml(join(target, ".project", "trace.yaml"), { schema_version: 1, edges: [], bindings: [] });
  git(target, ["add", "."]);
  git(target, ["commit", "-m", "smoke: isolated starting point"]);
  const startSha = git(target, ["rev-parse", "HEAD"]);

  // Runtime contracts are controller state rather than product history. Creating
  // them after the product commit gives ChangeSet an exact base SHA while Worker
  // and Reviewer receive the frozen Goal through the gateway prompts.
  const goal = smokeGoal();
  const change = smokeChange(startSha);
  atomicWriteYaml(join(target, ".project", "goals", `${goal.id}.yaml`), goal);
  atomicWriteYaml(join(target, ".project", "changes", `${change.id}.yaml`), change);
  assertSingleSmokeContract(target);
  rebuildIndex(target);
  assertMinimalIndex(target);
  if (git(target, ["status", "--porcelain"])) throw new Error("smoke_fixture_git_state_not_clean");
  return { repo: target, mainBranch, startSha, goal, change };
}

function smokeProject(mainBranch: string): Project {
  return {
    schema_version: 1,
    id: "project-real-codex-smoke",
    title: "SpecMirror Codex smoke fixture",
    description: "Disposable repository for one signed App Server execution path.",
    repository: { main_branch: mainBranch, root: "." },
    runtime: {
      max_workers: 1,
      goal_timeout_minutes: 10,
      max_fix_retries: 1,
      max_execution_turns: 7,
      gateway: "codex-app-server"
    },
    baselines: [{
      id: CODEX_SMOKE_BASELINE_ID,
      title: "Isolated smoke starting point",
      status: "guarded",
      progress: 100,
      atom_ids: []
    }],
    frontier: {
      id: "frontier-real-codex-smoke",
      title: "One-file smoke change",
      status: "active",
      progress: 0,
      reason: "Validate the real gateway without touching the production repository."
    },
    next_best_action: {
      title: `Append ${CODEX_SMOKE_MARKER} to README.md`,
      reason: "This is the only authorized product-file change in the disposable repository."
    }
  };
}

function smokeGoal(): GoalContract {
  return {
    schema_version: 1,
    id: CODEX_SMOKE_GOAL_ID,
    change_set_id: CODEX_SMOKE_CHANGE_ID,
    title: "真实 Codex 最小烟雾测试",
    outcome: `保留 README.md 原有内容，仅在文末追加一行 ${CODEX_SMOKE_MARKER} 和行末换行；不得新增空白行、改写原文或改动其他文件，允许 LF 或 CRLF 换行格式`,
    status: "compiled",
    ownership_modules: ["smoke-readme"],
    write_globs: ["README.md"],
    required_gateway: "codex-app-server",
    shared_contracts: [],
    dependencies: [],
    acceptance_commands: [CODEX_SMOKE_ACCEPTANCE_COMMAND],
    unresolved_design_questions: [],
    max_minutes: 10,
    max_turns: 7
  };
}

function smokeChange(startSha: string): ChangeSet {
  return {
    schema_version: 1,
    id: CODEX_SMOKE_CHANGE_ID,
    title: "真实 Codex 临时仓库全链路烟测",
    status: "compiled",
    start_sha: startSha,
    goal_ids: [CODEX_SMOKE_GOAL_ID],
    dependency_dag: { [CODEX_SMOKE_GOAL_ID]: [] },
    design_ids: [],
    constraint_ids: [],
    shared_contract_owners: {},
    protected_baselines: [CODEX_SMOKE_BASELINE_ID],
    acceptance_commands: [CODEX_SMOKE_ACCEPTANCE_COMMAND]
  };
}

function smokeAgentInstructions() {
  return "# Disposable Codex smoke fixture\n\n- Follow only the frozen Goal Contract supplied by the orchestrator in the current thread.\n- Treat every file under `.project/` as read-only control-plane metadata.\n- Do not inspect or modify any repository outside this disposable fixture.\n- Run the acceptance command supplied by the orchestrator and report its result.\n";
}

function assertSingleSmokeContract(repo: string) {
  const model = loadProject(repo);
  if (model.goals.length !== 1 || model.goals[0]?.id !== CODEX_SMOKE_GOAL_ID) throw new Error("smoke_fixture_goal_not_unique");
  if (model.changes.length !== 1 || model.changes[0]?.id !== CODEX_SMOKE_CHANGE_ID) throw new Error("smoke_fixture_change_not_unique");
  if (model.design.length || model.constraints.length || model.runs.length || model.proposals.length || model.reviews.length) {
    throw new Error("smoke_fixture_contains_unrelated_contracts");
  }
}

function assertMinimalIndex(repo: string) {
  const indexed = readIndexEntityIds(repo);
  const expected = [CODEX_SMOKE_CHANGE_ID, CODEX_SMOKE_GOAL_ID, "project-real-codex-smoke"].sort();
  if (JSON.stringify(indexed) !== JSON.stringify(expected)) throw new Error("smoke_fixture_index_not_minimal");
}

function assertSafeEmptySmokeRoot(candidate: string, boundary: { allowedParent?: string; exactName?: string }) {
  const allowedParent = resolve(boundary.allowedParent ?? tmpdir());
  const target = resolve(candidate);
  const child = relative(allowedParent, target);
  const expectedName = boundary.exactName;
  const nameAllowed = expectedName === undefined
    ? basename(target).startsWith("specmirror-codex-smoke-")
    : basename(target) === expectedName;
  if (!child || child.startsWith("..") || isAbsolute(child) || child.includes("/") || child.includes("\\") || dirname(target) !== allowedParent || !nameAllowed) {
    throw new Error("unsafe_smoke_fixture_target");
  }
  if (!existsSync(target)) mkdirSync(target, { recursive: false });
  if (readdirSync(target).length) throw new Error("smoke_fixture_root_not_empty");
  return target;
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}
