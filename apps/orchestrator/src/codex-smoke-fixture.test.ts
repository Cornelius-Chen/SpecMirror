import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, readIndexEntityIds } from "@epm/spec-io";
import { GitController } from "./git.ts";
import { MockAgentGateway } from "./gateway.ts";
import { GoalOrchestrator } from "./orchestrator.ts";
import {
  CODEX_SMOKE_BASELINE_ID,
  CODEX_SMOKE_CHANGE_ID,
  CODEX_SMOKE_GOAL_ID,
  CODEX_SMOKE_MARKER,
  CODEX_SMOKE_ACCEPTANCE_COMMAND,
  CODEX_SMOKE_EXPECTED_README,
  CODEX_SMOKE_INITIAL_README,
  createCodexSmokeFixture
} from "./codex-smoke-fixture.ts";

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0).sort((left, right) => right.length - left.length)) rmSync(root, { recursive: true, force: true });
});

describe("Codex smoke repository fixture", () => {
  it("commits one product baseline and builds one controller Goal from its exact SHA", () => {
    const repo = smokeTemp();
    const fixture = createCodexSmokeFixture(repo);
    const model = loadProject(repo);

    expect(model.goals.map((goal) => goal.id)).toEqual([CODEX_SMOKE_GOAL_ID]);
    expect(model.changes.map((change) => change.id)).toEqual([CODEX_SMOKE_CHANGE_ID]);
    expect(model.project.baselines.map((baseline) => baseline.id)).toEqual([CODEX_SMOKE_BASELINE_ID]);
    expect(model.design).toEqual([]);
    expect(model.constraints).toEqual([]);
    expect(model.goals[0]?.max_turns).toBe(7);
    expect(model.project.runtime.max_fix_retries).toBe(1);
    expect(readIndexEntityIds(repo)).toEqual([
      CODEX_SMOKE_CHANGE_ID,
      CODEX_SMOKE_GOAL_ID,
      "project-real-codex-smoke"
    ].sort());

    const committedFiles = git(repo, ["ls-tree", "-r", "--name-only", fixture.startSha]).split(/\r?\n/).filter(Boolean);
    expect(committedFiles).toEqual([
      ".gitignore",
      ".project/project.yaml",
      ".project/trace.yaml",
      "AGENTS.md",
      "README.md"
    ]);
    expect(model.changes[0]?.start_sha).toBe(fixture.startSha);
    expect(git(repo, ["status", "--short"])).toBe("");
    const committedHistory = git(repo, ["log", "-p", "--all"]);
    expect(committedHistory).not.toContain("UNBORN");
    expect(committedHistory).not.toContain(CODEX_SMOKE_GOAL_ID);
    expect(committedHistory).not.toContain(CODEX_SMOKE_CHANGE_ID);
  });

  it("keeps local contracts out of the Worker history and leaves the worktree clean", () => {
    const repo = smokeTemp();
    const fixture = createCodexSmokeFixture(repo);
    const worktree = new GitController(repo).createGoalWorktree(CODEX_SMOKE_GOAL_ID, fixture.startSha);
    const workerModel = loadProject(worktree.path);
    const instructions = readFileSync(join(worktree.path, "AGENTS.md"), "utf8");

    expect(workerModel.goals).toEqual([]);
    expect(workerModel.changes).toEqual([]);
    expect(existsSync(join(worktree.path, ".project", "goals"))).toBe(false);
    expect(existsSync(join(worktree.path, ".project", "changes"))).toBe(false);
    expect(instructions).toContain("Goal Contract supplied by the orchestrator");
    expect(instructions).not.toContain(CODEX_SMOKE_GOAL_ID);
    expect(instructions).not.toContain(CODEX_SMOKE_MARKER);
    expect(instructions).not.toContain("goal-y1-real-codex-smoke");
    expect(new GitController(worktree.path).allChangedFiles(fixture.startSha)).toEqual([]);
    expect(git(worktree.path, ["status", "--short"])).toBe("");
    new GitController(repo).removeGoalWorktree(worktree.path);
  });

  it("keeps the controller base SHA consistent through dispatch, review and integration", async () => {
    const repo = smokeTemp();
    const fixture = createCodexSmokeFixture(repo);
    class WritingGateway extends MockAgentGateway {
      override readonly kind = "codex-app-server" as const;
      readonly receivedGoals: unknown[] = [];
      planCalls = 0;
      override async start(...args: Parameters<MockAgentGateway["start"]>) {
        this.receivedGoals.push(args[0]);
        return super.start(...args);
      }
      override async plan(...args: Parameters<MockAgentGateway["plan"]>) {
        this.receivedGoals.push(args[0]);
        this.planCalls += 1;
        const plan = await super.plan(...args);
        return this.planCalls < 3 ? { ...plan, primaryOutcomes: [args[0].outcome, "unauthorized extra outcome"] } : plan;
      }
      override async implement(...args: Parameters<MockAgentGateway["implement"]>) {
        const [goal, , context] = args;
        this.receivedGoals.push(goal);
        appendFileSync(join(context!.cwd, "README.md"), `${CODEX_SMOKE_MARKER}\n`, "utf8");
        return { changedFiles: ["README.md"], evidence: [`README.md contains ${CODEX_SMOKE_MARKER}`], summary: goal.outcome };
      }
      override async review(...args: Parameters<MockAgentGateway["review"]>) {
        this.receivedGoals.push(args[0]);
        return super.review(...args);
      }
    }
    const gateway = new WritingGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway);
    try {
      const dispatched = orchestrator.dispatch(fixture.change.id);
      expect(dispatched.active).toEqual([fixture.goal.id]);
      const run = await orchestrator.active.get(fixture.goal.id)!;
      const finalModel = loadProject(repo);
      const finalChange = finalModel.changes.find((change) => change.id === fixture.change.id)!;
      const finalReview = finalModel.reviews.find((review) => review.id === `review-integrator-${fixture.change.id}`)!;

      expect(run.status).toBe("verified");
      expect(finalChange.status).toBe("verified");
      expect(finalChange.start_sha).toBe(fixture.startSha);
      expect(finalReview.start_sha).toBe(fixture.startSha);
      expect(new GitController(repo).head(`codex/checkpoint/${fixture.change.id}`)).toBe(fixture.startSha);
      expect(git(repo, ["show", `${fixture.mainBranch}:README.md`])).toContain(CODEX_SMOKE_MARKER);
      expect(git(repo, ["status", "--short"])).toBe("");
      expect(run.events.filter((event) => event.startsWith("turn_budget:"))).toEqual([
        "turn_budget:1/7:plan",
        "turn_budget:2/7:plan",
        "turn_budget:3/7:plan",
        "turn_budget:4/7:implementation",
        "turn_budget:5/7:review"
      ]);
      expect(gateway.receivedGoals).toHaveLength(6);
      expect(gateway.receivedGoals.every((goal) => JSON.stringify(goal) === JSON.stringify(fixture.goal))).toBe(true);
    } finally {
      orchestrator.close();
    }
  }, 15_000);

  it("fails closed instead of layering the fixture over copied production contracts", () => {
    const repo = smokeTemp();
    const staleGoal = join(repo, ".project", "goals", "goal-y1-real-codex-smoke.yaml");
    mkdirSync(join(repo, ".project", "goals"), { recursive: true });
    writeFileSync(staleGoal, "poison: preserved\n", "utf8");

    expect(() => createCodexSmokeFixture(repo)).toThrow("smoke_fixture_root_not_empty");
    expect(readFileSync(staleGoal, "utf8")).toBe("poison: preserved\n");
    expect(existsSync(join(repo, ".git"))).toBe(false);
  });

  it("checks the exact authorized edit, rejecting an extra blank line, duplication and original-text changes", () => {
    const repo = smokeTemp();
    const check = (content: string) => {
      writeFileSync(join(repo, "README.md"), content, "utf8");
      return spawnSync("powershell.exe", ["-NoProfile", "-Command", CODEX_SMOKE_ACCEPTANCE_COMMAND], { cwd: repo, encoding: "utf8", windowsHide: true }).status;
    };
    expect(check(CODEX_SMOKE_EXPECTED_README)).toBe(0);
    expect(check(CODEX_SMOKE_EXPECTED_README.replaceAll("\n", "\r\n"))).toBe(0);
    expect(check(`${CODEX_SMOKE_INITIAL_README}\nSMOKE_OK\n`)).toBe(1);
    expect(check(`${CODEX_SMOKE_EXPECTED_README}SMOKE_OK\n`)).toBe(1);
    expect(check(CODEX_SMOKE_EXPECTED_README.replace("等待", "改写"))).toBe(1);
    expect(check(CODEX_SMOKE_INITIAL_README)).toBe(1);
  });

  it("refuses a non-temporary repository before writing anything", () => {
    expect(() => createCodexSmokeFixture(resolve("."))).toThrow("unsafe_smoke_fixture_target");
  });
});

function smokeTemp() {
  const root = mkdtempSync(join(tmpdir(), "specmirror-codex-smoke-"));
  cleanupRoots.push(root, resolve(root, "..", `${root.split(/[\\/]/).at(-1)}-worktrees`));
  return root;
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}
