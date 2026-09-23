import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteYaml, loadProject, writeChangeSet, writeGoal } from "@epm/spec-io";
import { createCodexSmokeFixture, CODEX_SMOKE_MARKER } from "./codex-smoke-fixture.ts";
import { normalizeReviewFeedback } from "./gateway.ts";
import { CodexAppServerGateway, MockJsonRpcTransport } from "./jsonrpc.ts";
import { GoalOrchestrator } from "./orchestrator.ts";

const roots: string[] = [];
const orchestrators: GoalOrchestrator[] = [];
const gateways: CodexAppServerGateway[] = [];
const originalApiKey = process.env.OPENAI_API_KEY;
const finding = "README.md 在标记前多出一个空行；删除这个空行，保留原有文本。";
const credential = "isolated-review-feedback-secret";

afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) orchestrator.close();
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  for (const candidate of roots.splice(0)) {
    const target = resolve(candidate);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes("mirror-review-feedback-")) throw new Error("unsafe_review_feedback_cleanup");
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fixture(retries: number) {
  const root = mkdtempSync(join(tmpdir(), "mirror-review-feedback-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  const smoke = createCodexSmokeFixture(repo, { allowedParent: root, exactName: "repo" });
  git(repo, ["config", "core.autocrlf", "false"]);
  const project = loadProject(repo).project;
  project.runtime.max_fix_retries = retries;
  project.runtime.max_execution_turns = 8;
  atomicWriteYaml(join(repo, ".project", "project.yaml"), project);
  git(repo, ["add", ".project/project.yaml"]);
  git(repo, ["commit", "-m", "fixture: bounded review retries"]);
  smoke.startSha = git(repo, ["rev-parse", "HEAD"]);
  smoke.change = { ...smoke.change, start_sha: smoke.startSha };
  smoke.goal = { ...smoke.goal, max_turns: 8 };
  writeChangeSet(repo, smoke.change); writeGoal(repo, smoke.goal);
  const baseline = readFileSync(join(repo, "README.md"), "utf8");
  return { ...smoke, baseline, expected: baseline + CODEX_SMOKE_MARKER + "\n" };
}

/** The real gateway and orchestrator use only this in-memory transport. */
function workerTransport(f: ReturnType<typeof fixture>, failFirstRepair = false) {
  let turn = 0, reviewer = 0, repairFailed = false;
  const implementationPrompts: string[] = [];
  const transport = new MockJsonRpcTransport({
    "thread/start": (params: Record<string, unknown>) => ({ thread: { id: params.serviceName === "specmirror-reviewer" ? "reviewer-" + ++reviewer : "worker-retained" } }),
    "thread/resume": (params: Record<string, unknown>) => ({ thread: { id: params.threadId } }),
    "thread/goal/set": {},
    "turn/start": (params: Record<string, unknown>, mock: MockJsonRpcTransport) => {
      const id = "turn-" + ++turn;
      const planning = (params.collaborationMode as { mode?: string } | undefined)?.mode === "plan";
      const implementing = (params.sandboxPolicy as { type: string }).type === "workspaceWrite";
      let result: unknown;
      if (planning) result = {
        outcome: f.goal.outcome, primaryOutcomes: [f.goal.outcome], ownershipModules: [...f.goal.ownership_modules],
        plannedWriteGlobs: [...f.goal.write_globs], sharedContracts: [], unresolvedQuestions: [],
        steps: [{ title: "修改唯一允许的文件并核对", acceptance: f.goal.acceptance_commands[0] }], risks: []
      };
      else if (implementing) {
        const prompt = (params.input as Array<{ text: string }>)[0]!.text;
        implementationPrompts.push(prompt);
        const repairing = prompt.includes(finding);
        if (repairing && failFirstRepair && !repairFailed) { repairFailed = true; throw new Error("fixture_pause_after_review"); }
        writeFileSync(join(String(params.cwd), "README.md"), repairing ? f.expected : f.baseline + "\n" + CODEX_SMOKE_MARKER + "\n");
        result = repairing ? "修复了审查指出的额外空行。" : "提交第一轮结果。";
      } else {
        const approved = readFileSync(join(String(params.cwd), "README.md"), "utf8") === f.expected;
        result = {
          approved,
          requirementDiffTestMap: [{ requirement: f.goal.outcome, evidence: "README.md diff; " + f.goal.acceptance_commands[0] }],
          findings: approved ? [] : [finding, "测试中回显的凭证须脱敏：" + credential]
        };
      }
      queueMicrotask(() => {
        mock.emit({ method: "item/completed", params: { threadId: params.threadId, turnId: id, item: { type: "agentMessage", text: typeof result === "string" ? result : JSON.stringify(result) } } });
        mock.emit({ method: "turn/completed", params: { threadId: params.threadId, turn: { id, status: "completed" } } });
      });
      return { turn: { id, status: "inProgress" } };
    }
  });
  return { transport, implementationPrompts };
}

function start(f: ReturnType<typeof fixture>, transport: MockJsonRpcTransport) {
  const gateway = new CodexAppServerGateway(transport, f.repo, true); gateways.push(gateway);
  const orchestrator = new GoalOrchestrator(f.repo, gateway); orchestrators.push(orchestrator);
  return orchestrator;
}

describe("rejected review feedback reaches the same Worker", () => {
  it("repairs the actual rejected diff on its second turn without changing the frozen contract or starting another Worker", async () => {
    process.env.OPENAI_API_KEY = credential;
    const f = fixture(1), mock = workerTransport(f), orchestrator = start(f, mock.transport);
    orchestrator.dispatch(f.change.id);
    const run = await orchestrator.active.get(f.goal.id);
    expect(run).toMatchObject({ status: "verified", attempt: 2, thread_id: "worker-retained" });
    expect(mock.implementationPrompts).toHaveLength(2);
    expect(mock.implementationPrompts[0]).not.toContain(finding);
    expect(mock.implementationPrompts[1]).toContain(finding);
    expect(mock.implementationPrompts[1]).toContain("[REDACTED]");
    expect(mock.implementationPrompts[1]).not.toContain(credential);
    expect(mock.implementationPrompts[1]).toContain("原 Goal Contract、负责人、允许写域和验收条件保持不变");
    expect(mock.transport.calls.filter(call => call.method === "thread/start" && call.params.serviceName === "specmirror")).toHaveLength(1);
    const writes = mock.transport.calls.filter(call => (call.params.sandboxPolicy as { type?: string } | undefined)?.type === "workspaceWrite");
    expect(new Set(writes.map(call => call.params.threadId)).size).toBe(1);
    expect(new Set(writes.map(call => call.params.cwd)).size).toBe(1);
    expect(writes.every(call => JSON.stringify(call.params.sandboxPolicy) === JSON.stringify(writes[0]!.params.sandboxPolicy))).toBe(true);
    const model = loadProject(f.repo);
    expect(model.runs).toHaveLength(1);
    expect({ ...model.goals[0], status: "compiled" }).toEqual(f.goal);
    expect(model.reviews.find(review => review.status === "changes_requested")?.orphan_code).toContain(finding);
    expect(JSON.stringify(model.reviews)).not.toContain(credential);
    expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe(f.expected);
  }, 30_000);

  it("restores this run's persisted rejection after an interrupted repair and resumes the original Worker", async () => {
    process.env.OPENAI_API_KEY = credential;
    const f = fixture(2), first = workerTransport(f, true), orchestrator = start(f, first.transport);
    orchestrator.dispatch(f.change.id);
    const failed = await orchestrator.active.get(f.goal.id);
    expect(failed).toMatchObject({ status: "failed", attempt: 2, thread_id: "worker-retained" });
    orchestrator.close(); orchestrators.splice(orchestrators.indexOf(orchestrator), 1);
    const second = workerTransport(f), resumed = start(f, second.transport);
    resumed.resume(failed!.id);
    const completed = await resumed.active.get(f.goal.id);
    expect(completed).toMatchObject({ id: failed!.id, status: "verified", attempt: 3, thread_id: failed!.thread_id });
    expect(second.implementationPrompts).toHaveLength(1);
    expect(second.implementationPrompts[0]).toContain(finding);
    expect(second.implementationPrompts[0]).not.toContain(credential);
    expect(second.transport.calls.filter(call => call.method === "thread/start" && call.params.serviceName === "specmirror")).toHaveLength(0);
    expect(second.transport.calls.filter(call => call.method === "thread/resume")).toMatchObject([{ params: { threadId: failed!.thread_id } }]);
    const model = loadProject(f.repo);
    expect(model.runs).toHaveLength(1);
    expect({ ...model.goals[0], status: "compiled" }).toEqual(f.goal);
    expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe(f.expected);
  }, 30_000);

  it("bounds feedback and removes credentials before truncation without fabricating missing findings", () => {
    process.env.OPENAI_API_KEY = credential;
    const normalized = normalizeReviewFeedback([
      "修复缺失检查；" + credential + "; Bearer test-bearer-secret; api_key=test-key-secret; sk-abcdefghijklmnop",
      ...Array.from({ length: 20 }, () => "x".repeat(4000))
    ]);
    expect(normalized.join("\n")).not.toMatch(/isolated-review-feedback-secret|test-bearer-secret|test-key-secret|sk-abcdefghijklmnop/);
    expect(normalized[0]).toContain("修复缺失检查");
    expect(normalized.length).toBeLessThanOrEqual(12);
    expect(normalized.every(value => value.length <= 2000)).toBe(true);
    expect(normalized.reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(6000);
    expect(normalizeReviewFeedback()).toEqual([]);
  });
});

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}
