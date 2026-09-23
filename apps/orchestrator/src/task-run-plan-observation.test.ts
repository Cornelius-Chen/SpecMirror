import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineeringNodeSchema, type EngineeringDocument } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, RuntimeStore } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { normalizeRunPlan } from "./run-plan-projection.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";
import { registerTaskWorkspaceRoutes, TaskWorkspaces } from "./task-workspaces.ts";

const fixtures: Array<{ directory: string; runtime: RuntimeStore; workspaces: TaskWorkspaces; app: ReturnType<typeof Fastify> }> = [];

async function fixture(sourceInsideHost = false) {
  const directory = mkdtempSync(join(tmpdir(), "mirror-task-plan-read-")), root = join(directory, "host");
  const source = join(sourceInsideHost ? root : directory, "source");
  mkdirSync(root); mkdirSync(source);
  const at = new Date().toISOString();
  const node = EngineeringNodeSchema.parse({ id: "engineering-project", parent_id: null, kind: "project", title: "隔离宿主",
    objective: "验证计划观察不修改工程", owner: "未分配", order: 0, revision: 1, status: "draft",
    constraints: { allow: [], deny: [], rules: [], resources: [] }, created_at: at, updated_at: at });
  const document: EngineeringDocument = { schema_version: 1, id: "engineering-document", revision: 1,
    root_id: node.id, created_at: at, updated_at: at, nodes: [node], runs: [], events: [], changes: [], capability_uses: [] };
  atomicWriteYaml(engineeringDocumentPath(root), document);
  const runtime = new RuntimeStore(root), events = new EventBus();
  const companion = new WorkspaceCompanion(root, runtime, events, { readonlyLegacy: true });
  const catalog = { source: async (id: string) => ({ id, title: "真实任务", cwd: source, version: "v1", preview: "观察本轮计划",
    updatedAt: 1, pinned: false, received: false, receivedAt: null }) };
  const workspaces = new TaskWorkspaces(root, events, catalog, {
    sessions: record => companion.sessions(record), observations: record => companion.lifecycleObservations(record)
  });
  const app = Fastify(); registerTaskWorkspaceRoutes(app, workspaces, companion); await app.ready();
  fixtures.push({ directory, runtime, workspaces, app });
  const observe = (session = "task-a", turn = "turn-1", cwd = source) => {
    companion.receiveHook({ session_id: session, cwd, hook_event_name: "SessionStart" }, workspaces);
    companion.receiveHook({ session_id: session, cwd, hook_event_name: "UserPromptSubmit", turn_id: turn }, workspaces);
  };
  const plan = (session = "task-a", turn = "turn-1", title = "检查当前实现", cwd = source) => companion.receiveHook({
    session_id: session, cwd, hook_event_name: "PostToolUse", turn_id: turn, tool_name: "update_plan",
    tool_input: { plan: [{ step: title, status: "in_progress" }] }
  }, workspaces);
  const read = (session = "task-a", cwd = source) => app.inject({ url: `/api/task-run-plans/${encodeURIComponent(session)}?cwd=${encodeURIComponent(cwd)}` });
  return { root, source, runtime, events, companion, workspaces, app, observe, plan, read };
}

afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const item of fixtures.splice(0).reverse()) {
    await item.app.close(); await item.workspaces.close(); item.runtime.close();
    const directory = resolve(item.directory);
    if (!directory.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("read-only task RunPlan observations", () => {
  it.each([false, true])("reads an unbound task without workspace creation (source inside host: %s)", async insideHost => {
    const f = await fixture(insideHost); f.observe();
    const projected = f.plan();
    expect(projected.run_plan_projection.workspace_id).toBe(insideHost ? "host" : null);
    const engineeringBefore = readFileSync(engineeringDocumentPath(f.root), "utf8");
    const recordsBefore = JSON.stringify(f.workspaces.records());
    const observationsBefore = f.runtime.getState("workspace-companion:hook-observations:v1");
    const plansBefore = f.runtime.getState("workspace-companion:run-plan-projections:v1");
    const eventsBefore = f.events.history.length;
    const runtimeWrites = vi.spyOn(f.runtime, "setState"), workspaceWrites = vi.spyOn(f.workspaces, "connect");
    for (let refresh = 0; refresh < 2; refresh++) {
      const response = await f.read();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ schema_version: 1, session_id: "task-a", source_cwd: f.source, workspace_id: null,
        projections: [{ workspace_id: null, session_id: "task-a", connection: "current", acceptance: "not_evaluated",
          binding: { state: "unassigned", node_id: null, run_id: null, owner: null, contract_key: null, execution_authorized: false } }] });
    }
    expect(runtimeWrites).not.toHaveBeenCalled(); expect(workspaceWrites).not.toHaveBeenCalled();
    expect(readFileSync(engineeringDocumentPath(f.root), "utf8")).toBe(engineeringBefore);
    expect(JSON.stringify(f.workspaces.records())).toBe(recordsBefore);
    expect(f.runtime.getState("workspace-companion:hook-observations:v1")).toBe(observationsBefore);
    expect(f.runtime.getState("workspace-companion:run-plan-projections:v1")).toBe(plansBefore);
    expect(f.events.history).toHaveLength(eventsBefore);
  });

  it("requires exact observed session and canonical cwd and isolates another task in the same directory", async () => {
    const f = await fixture(); f.observe(); f.plan(); f.observe("task-b"); f.plan("task-b", "turn-1", "其他任务私有步骤");
    const response = await f.read("task-a", f.source + sep + "." + sep);
    expect(response.statusCode).toBe(200); expect(response.json().projections).toHaveLength(1);
    expect(response.body).not.toContain("其他任务私有步骤"); expect(response.body).not.toContain("task-b");
    const writes = vi.spyOn(f.runtime, "setState");
    for (const [session, cwd] of [["not-observed", f.source], ["task-a", f.root], ["task-a", join(f.source, "child")]]) {
      const rejected = await f.read(session, cwd);
      expect(rejected.statusCode).toBe(403); expect(rejected.json().code).toBe("task_run_plan_source_unobserved");
      expect(rejected.body).not.toContain("检查当前实现");
    }
    expect((await f.read("task-a", "relative/path")).statusCode).toBe(400);
    expect((await f.read("bad session", f.source)).statusCode).toBe(400);
    expect((await f.app.inject({ url: "/api/task-run-plans/task-a" })).statusCode).toBe(400);
    expect(writes).not.toHaveBeenCalled();
  });

  it("shows an observed task with no plan as empty without fabricating a projection", async () => {
    const f = await fixture(); f.observe();
    const writes = vi.spyOn(f.runtime, "setState"), response = await f.read();
    expect(response.statusCode).toBe(200); expect(response.json().projections).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("does not expose a stored plan from another cwd even when its session and turn match", async () => {
    const f = await fixture(); f.observe(); f.plan();
    f.companion.runPlans.upsert({ workspace_id: "other-workspace", session_id: "task-a", source_cwd: f.root,
      turn_id: "turn-1", plan: normalizeRunPlan([{ step: "另一个目录的步骤", status: "in_progress" }])!,
      binding: { state: "unassigned", node_id: null, run_id: null, owner: null, contract_key: null, execution_authorized: false },
      at: new Date().toISOString() });
    const response = await f.read();
    expect(response.statusCode).toBe(200); expect(response.json().projections).toEqual([]);
    expect(response.body).not.toContain("另一个目录的步骤");
  });

  it("removes every engineering binding from a matching task projection without modifying the stored binding", async () => {
    const f = await fixture(); f.observe(); f.plan();
    const binding = { state: "run" as const, node_id: "private-node", run_id: "private-run", owner: "codex:task-a",
      contract_key: "private-contract", execution_authorized: true, reason: "private engineering reason" };
    f.companion.runPlans.upsert({ workspace_id: "private-workspace", session_id: "task-a", source_cwd: f.source,
      turn_id: "turn-1", plan: normalizeRunPlan([{ step: "当前任务步骤", status: "pending" }])!, binding, at: new Date().toISOString() });
    const response = await f.read();
    expect(response.statusCode).toBe(200);
    expect(response.json().projections[0].binding).toMatchObject({ state: "unassigned", node_id: null, run_id: null, owner: null,
      contract_key: null, execution_authorized: false });
    expect(response.body).not.toContain("private-"); expect(response.body).not.toContain("private engineering");
    expect(f.companion.runPlans.list()[0]?.binding).toEqual(binding);
  });

  it("preserves ended and expired observations while repeated reads cannot refresh activity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    const f = await fixture(); f.observe(); f.plan();
    f.companion.receiveHook({ session_id: "task-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-1" }, f.workspaces);
    expect((await f.read()).json().projections[0]).toMatchObject({ lifecycle: "turn_ended", connection: "current", acceptance: "not_evaluated" });
    vi.setSystemTime(new Date("2026-09-13T13:00:00.000Z"));
    const writes = vi.spyOn(f.runtime, "setState");
    expect((await f.read()).json().projections[0]).toMatchObject({ lifecycle: "turn_ended", connection: "stale" });
    expect((await f.read()).json().projections[0]).toMatchObject({ lifecycle: "turn_ended", connection: "stale" });
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps restored observations stale until a natural lifecycle event reaches the new process", async () => {
    const f = await fixture(); f.observe(); f.plan();
    const restored = new WorkspaceCompanion(f.root, f.runtime, f.events, { readonlyLegacy: true });
    const writes = vi.spyOn(f.runtime, "setState");
    expect(restored.readTaskRunPlanProjections({ session_id: "task-a", cwd: f.source }).projections[0]).toMatchObject({
      lifecycle: "active", connection: "stale", binding: { execution_authorized: false }
    });
    expect(writes).not.toHaveBeenCalled();
    restored.receiveHook({ session_id: "task-a", cwd: f.source, hook_event_name: "SessionStart" }, f.workspaces);
    expect(restored.readTaskRunPlanProjections({ session_id: "task-a", cwd: f.source }).projections[0]?.connection).toBe("current");
  });
});
