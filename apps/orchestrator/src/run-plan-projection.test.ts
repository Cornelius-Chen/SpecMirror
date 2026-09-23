import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineeringNodeSchema, engineeringContractKey, type EngineeringDocument, type EngineeringRun } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering, RuntimeStore } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";
import { registerTaskWorkspaceRoutes, TaskWorkspaces } from "./task-workspaces.ts";

const fixtures: Array<{ root: string; runtime: RuntimeStore; workspaces: TaskWorkspaces; app: ReturnType<typeof Fastify> }> = [];

function emptyDocument(title = "宿主工程"): EngineeringDocument {
  const at = "2026-09-07T12:00:00.000Z";
  const node = EngineeringNodeSchema.parse({ id: "engineering-project", parent_id: null, kind: "project", title, objective: "测试运行态计划投影",
    owner: "未分配", order: 0, revision: 1, status: "draft", constraints: { allow: [], deny: [], rules: [], resources: [] }, created_at: at, updated_at: at });
  return { schema_version: 1, id: "engineering-document", revision: 1, root_id: node.id, created_at: at, updated_at: at,
    nodes: [node], runs: [], events: [], changes: [], capability_uses: [] };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-run-plan-")), source = join(root, "source");
  mkdirSync(source); atomicWriteYaml(engineeringDocumentPath(root), emptyDocument());
  const runtime = new RuntimeStore(root), events = new EventBus(), companion = new WorkspaceCompanion(root, runtime, events, { readonlyLegacy: true });
  const catalog = { source: async (id: string) => ({ id, title: "Codex 任务", cwd: source, version: "source-v1", preview: "实现一个可核对成果。", updatedAt: 1, pinned: false, received: false, receivedAt: null }) };
  const workspaces = new TaskWorkspaces(root, events, catalog, { sessions: record => companion.sessions(record), observations: record => companion.lifecycleObservations(record) });
  const workspace = await workspaces.connect({ thread_id: "thread-a", source_version: "source-v1", mode: "create" });
  const app = Fastify(); registerTaskWorkspaceRoutes(app, workspaces, companion); await app.ready();
  fixtures.push({ root, runtime, workspaces, app });
  return { root, source, runtime, events, companion, workspaces, workspace, app, catalog };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const item of fixtures.splice(0).reverse()) {
    await item.app.close(); await item.workspaces.close(); item.runtime.close();
    const root = resolve(item.root); if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

function observeTurn(f: Awaited<ReturnType<typeof fixture>>, turn = "turn-1", session = "thread-a") {
  f.companion.receiveHook({ session_id: session, cwd: f.source, hook_event_name: "SessionStart" }, f.workspaces);
  f.companion.receiveHook({ session_id: session, cwd: f.source, hook_event_name: "UserPromptSubmit", turn_id: turn }, f.workspaces);
}

function updatePlan(f: Awaited<ReturnType<typeof fixture>>, plan: Array<{ step: string; status: string }>, turn = "turn-1", session = "thread-a") {
  return f.companion.receiveHook({ session_id: session, cwd: f.source, hook_event_name: "PostToolUse", turn_id: turn, tool_name: "update_plan",
    tool_input: { plan, ignored: { raw: "must-not-be-stored" } } }, f.workspaces);
}

function goalTool(f: Awaited<ReturnType<typeof fixture>>, tool_name: "create_goal" | "get_goal" | "update_goal", input: Record<string, unknown>,
  response: Record<string, unknown>, turn = "turn-1", toolUseId = `${tool_name}-1`) {
  return f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "PostToolUse", turn_id: turn, tool_name,
    tool_use_id: toolUseId, tool_input: input, tool_response: response }, f.workspaces);
}

describe("temporary Codex RunPlanProjection", () => {
  it("projects a primary task Plan at workspace scope without changing engineering truth and deduplicates the same hash", async () => {
    const f = await fixture(), before = JSON.stringify(loadEngineering(f.workspaces.resolve(f.workspace.id).root));
    observeTurn(f);
    const first = updatePlan(f, [{ step: "Inspect token=fixture-secret", status: "in_progress" }, { step: "Run tests", status: "pending" }]);
    const repeated = updatePlan(f, [{ step: "Inspect token=fixture-secret", status: "in_progress" }, { step: "Run tests", status: "pending" }]);
    expect(first.run_plan_projection).toMatchObject({ accepted: true, changed: true, workspace_id: f.workspace.id,
      binding: { state: "workspace", node_id: "engineering-project", execution_authorized: false } });
    expect(repeated.run_plan_projection).toMatchObject({ accepted: true, changed: false });
    expect(JSON.stringify(loadEngineering(f.workspaces.resolve(f.workspace.id).root))).toBe(before);
    const response = await f.app.inject({ url: `/api/task-workspaces/${f.workspace.id}/run-plan-projections` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.projections).toHaveLength(1);
    expect(body.projections[0]).toMatchObject({ lifecycle: "active", connection: "current", acceptance: "not_evaluated",
      notice: "计划完成只表示 Agent 报告，不代表工程验收。", binding: { state: "workspace", execution_authorized: false } });
    expect(JSON.stringify(body)).not.toContain("fixture-secret");
    expect(JSON.stringify(body)).not.toContain("must-not-be-stored");
    expect(f.events.history.filter(event => event.data?.kind === "run-plan-projection")).toHaveLength(1);
  });

  it("accepts a deliberate A to B to A edit while only deduplicating the current projection", async () => {
    const f = await fixture(); observeTurn(f);
    const a = [{ step: "Inspect the current graph", status: "in_progress" }];
    const b = [{ step: "Verify the changed graph", status: "in_progress" }];
    expect(updatePlan(f, a).run_plan_projection.changed).toBe(true);
    expect(updatePlan(f, b).run_plan_projection.changed).toBe(true);
    expect(updatePlan(f, a).run_plan_projection.changed).toBe(true);
    expect(updatePlan(f, a).run_plan_projection.changed).toBe(false);
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]?.steps[0]?.title).toBe("Inspect the current graph");
  });

  it("projects one verified durable goal across turns and closes it only from a verified goal result", async () => {
    const f = await fixture(), before = JSON.stringify(loadEngineering(f.workspaces.resolve(f.workspace.id).root));
    observeTurn(f, "turn-1");
    const created = goalTool(f, "create_goal", { objective: "Complete the adapter", token_budget: 5000 },
      { goal: { objective: "Complete the adapter", status: "active", tokens_used: 12 }, remainingTokens: 4988 });
    expect(created.run_plan_projection).toMatchObject({ accepted: true, changed: true, workspace_id: f.workspace.id });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({
      source: "goal", goal_status: "active", lifecycle: "active", turn_id: "turn-1", steps: [{ title: "Complete the adapter", status: "in_progress" }], acceptance: "not_evaluated"
    });

    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-1" }, f.workspaces);
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({ source: "goal", lifecycle: "active" });
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "UserPromptSubmit", turn_id: "turn-2" }, f.workspaces);
    const refreshed = goalTool(f, "get_goal", {}, { goal: { objective: "Complete the adapter", status: "active" } }, "turn-2", "get-goal-2");
    expect(refreshed.run_plan_projection).toMatchObject({ accepted: true, changed: true });

    const unverified = goalTool(f, "update_goal", { status: "complete" }, { error: "goal was not completed" }, "turn-2", "update-goal-failed");
    expect(unverified.run_plan_projection).toMatchObject({ accepted: false, reason: "goal_result_unverified" });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({ goal_status: "active", lifecycle: "active" });

    const completed = goalTool(f, "update_goal", { status: "complete" }, { goal: { objective: "Complete the adapter", status: "complete" } }, "turn-2", "update-goal-complete");
    const repeated = goalTool(f, "update_goal", { status: "complete" }, { goal: { objective: "Complete the adapter", status: "complete" } }, "turn-2", "update-goal-complete");
    expect(completed.run_plan_projection).toMatchObject({ accepted: true, changed: true });
    expect(repeated.run_plan_projection).toMatchObject({ accepted: true, changed: false });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({
      source: "goal", goal_status: "complete", lifecycle: "turn_ended", steps: [{ status: "completed" }], acceptance: "not_evaluated"
    });
    const delayedCreate = goalTool(f, "create_goal", { objective: "Complete the adapter" },
      { goal: { objective: "Complete the adapter", status: "active" } }, "turn-2", "create_goal-1");
    expect(delayedCreate.run_plan_projection).toMatchObject({ accepted: false, changed: false, reason: "goal_event_stale" });
    const delayedRefresh = goalTool(f, "get_goal", {}, { goal: { objective: "Complete the adapter", status: "active" } }, "turn-2", "get-goal-2");
    expect(delayedRefresh.run_plan_projection).toMatchObject({ accepted: false, changed: false, reason: "goal_event_stale" });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({ goal_status: "complete", lifecycle: "turn_ended" });
    expect(JSON.stringify(loadEngineering(f.workspaces.resolve(f.workspace.id).root))).toBe(before);
  });

  it("requires a stable tool use id for goal mutations and ignores incidental goal-shaped output", async () => {
    const f = await fixture(); observeTurn(f);
    const missingId = f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "PostToolUse", turn_id: "turn-1", tool_name: "create_goal",
      tool_input: { objective: "Unidentified goal" }, tool_response: { goal: { objective: "Unidentified goal", status: "active" } } }, f.workspaces);
    expect(missingId.run_plan_projection).toMatchObject({ accepted: false, reason: "tool_use_id_unverified" });
    const ordinary = f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "PostToolUse", turn_id: "turn-1", tool_name: "functions.exec",
      tool_input: { objective: "incidental" }, tool_response: { goal: { objective: "incidental", status: "active" } } }, f.workspaces);
    expect(ordinary.run_plan_projection).toMatchObject({ accepted: false, reason: "lifecycle_only" });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections).toEqual([]);
  });

  it("accepts an explicit current-turn plan only after a fresh real Hook observation", async () => {
    const f = await fixture(), before = JSON.stringify(loadEngineering(f.workspaces.resolve(f.workspace.id).root));
    const body = { session_id: "thread-a", cwd: f.source, workspace_id: f.workspace.id,
      plan: [{ step: "Inspect API_KEY=fixture-secret", status: "in_progress" }, { step: "Run focused tests", status: "pending" }],
      ignored: { command: "must-not-store" } };
    const beforeHook = await f.app.inject({ method: "POST", url: "/api/codex-companion/run-plan", payload: body });
    expect(beforeHook.statusCode).toBe(403);
    expect(beforeHook.json()).toMatchObject({ code: "codex_session_not_current" });

    observeTurn(f);
    const first = await f.app.inject({ method: "POST", url: "/api/codex-companion/run-plan", payload: body });
    const repeated = await f.app.inject({ method: "POST", url: "/api/codex-companion/run-plan", payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ accepted: true, changed: true, workspace_id: f.workspace.id,
      binding: { state: "workspace", node_id: "engineering-project", execution_authorized: false } });
    expect(repeated.json()).toMatchObject({ accepted: true, changed: false });
    const visible = f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]!;
    expect(visible).toMatchObject({ source: "update_plan", lifecycle: "active", turn_id: "turn-1",
      steps: [{ title: "Inspect API_KEY=[REDACTED]", status: "in_progress" }, { title: "Run focused tests", status: "pending" }], acceptance: "not_evaluated" });
    expect(JSON.stringify(visible)).not.toContain("fixture-secret");
    expect(JSON.stringify(visible)).not.toContain("must-not-store");
    expect(JSON.stringify(loadEngineering(f.workspaces.resolve(f.workspace.id).root))).toBe(before);

    goalTool(f, "create_goal", { objective: "Finish the whole task" },
      { goal: { objective: "Finish the whole task", status: "active" } }, "turn-1", "api-test-goal");
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({ source: "update_plan" });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Inspect API_KEY=[REDACTED]" })
    ]));

    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-1" }, f.workspaces);
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({
      source: "goal", goal_status: "active", steps: [{ title: "Finish the whole task" }]
    });
    const afterStop = await f.app.inject({ method: "POST", url: "/api/codex-companion/run-plan", payload: body });
    expect(afterStop.statusCode).toBe(409);
    expect(afterStop.json()).toMatchObject({ code: "turn_already_ended" });
  });

  it("rejects malformed explicit plans without replacing the current projection", async () => {
    const f = await fixture(); observeTurn(f);
    const valid = { session_id: "thread-a", cwd: f.source, plan: [{ step: "Keep this", status: "in_progress" }] };
    expect((await f.app.inject({ method: "POST", url: "/api/codex-companion/run-plan", payload: valid })).statusCode).toBe(201);
    const invalid = await f.app.inject({ method: "POST", url: "/api/codex-companion/run-plan", payload: {
      session_id: "thread-a", cwd: f.source, plan: [{ step: "Replace this", status: "accepted" }]
    } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "plan_contract_invalid" });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]?.steps[0]?.title).toBe("Keep this");
  });

  it("maps only one strict current claimed run as executable and fails closed after its contract changes", async () => {
    const f = await fixture(), context = f.workspaces.resolve(f.workspace.id), doc = loadEngineering(context.root), node = doc.nodes[0]!;
    node.owner = "codex:thread-a"; node.status = "running";
    const key = engineeringContractKey(doc, node.id), at = "2026-09-07T12:01:00.000Z";
    const run: EngineeringRun = { id: "run-current", node_id: node.id, mode: "external", status: "running", actor: "codex:thread-a",
      snapshot: { node: structuredClone(node), lineage: [{ id: node.id, revision: 1 }], effective: { allow_layers: [], deny: [], rules: [], resources: [] },
        contract_key: key, dependencies: [], children: [] }, started_at: at, finished_at: null, current_action: "", completed_action_ids: [], evidence: [],
      output_dir: join(context.root, "output"), reason: "", review_note: "", reviewed_at: null,
      handoff: { state: "claimed", owner: "codex:thread-a", source_cwd: f.source, document_revision: doc.revision, contract_key: key, created_at: at, claimed_at: at, claimed_by: "codex:thread-a" } };
    doc.runs.push(run); atomicWriteYaml(engineeringDocumentPath(context.root), doc);
    observeTurn(f); const result = updatePlan(f, [{ step: "Implement result", status: "in_progress" }]);
    expect(result.run_plan_projection.binding).toMatchObject({ state: "run", node_id: node.id, run_id: run.id, execution_authorized: true });
    const changed = loadEngineering(context.root); changed.nodes[0]!.objective = "changed contract"; changed.nodes[0]!.revision += 1; changed.nodes[0]!.contract_revision = 2;
    atomicWriteYaml(engineeringDocumentPath(context.root), changed);
    const visible = f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]!;
    expect(visible.binding).toMatchObject({ state: "unassigned", execution_authorized: false });
    expect(visible.binding.reason).toContain("合同已变化");
  });

  it("keeps multiple owned nodes ambiguous when there is no unique current run", async () => {
    const f = await fixture(), context = f.workspaces.resolve(f.workspace.id), doc = loadEngineering(context.root), root = doc.nodes[0]!, at = root.created_at;
    for (const [order, id] of ["first", "second"].entries()) doc.nodes.push(EngineeringNodeSchema.parse({ id, parent_id: root.id, kind: "task", title: id,
      objective: id, owner: "codex:thread-a", order, revision: 1, status: "draft", constraints: { allow: [], deny: [], rules: [], resources: [] }, created_at: at, updated_at: at }));
    atomicWriteYaml(engineeringDocumentPath(context.root), doc);
    observeTurn(f); const result = updatePlan(f, [{ step: "Choose target", status: "in_progress" }]);
    expect(result.run_plan_projection.binding).toMatchObject({ state: "ambiguous", node_id: null, run_id: null, execution_authorized: false });
  });

  it("ends only the matching turn and never converts completed Plan steps into acceptance", async () => {
    const f = await fixture(); observeTurn(f, "turn-1"); updatePlan(f, [{ step: "Finish work", status: "completed" }], "turn-1");
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-1" }, f.workspaces);
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({ lifecycle: "turn_ended", acceptance: "not_evaluated" });
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "UserPromptSubmit", turn_id: "turn-2" }, f.workspaces);
    updatePlan(f, [{ step: "Next work", status: "in_progress" }], "turn-2");
    const late = f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-1" }, f.workspaces);
    expect(late.run_plan_projection).toMatchObject({ accepted: false, reason: "old_turn_event" });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({ turn_id: "turn-2", lifecycle: "active", acceptance: "not_evaluated" });
    expect(loadEngineering(f.workspaces.resolve(f.workspace.id).root).nodes[0]!.status).toBe("draft");
  });

  it("keeps Stop monotonic and does not let same-turn late events refresh presence or resurrect a Plan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
    const f = await fixture(); observeTurn(f, "turn-ended");
    updatePlan(f, [{ step: "Original plan", status: "in_progress" }], "turn-ended");
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-ended" }, f.workspaces);
    const endedObservation = JSON.parse(f.runtime.getState("workspace-companion:hook-observations:v1")!)[0];
    vi.setSystemTime(new Date("2026-09-07T12:10:00.000Z"));
    const subagent = f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "SubagentStop" }, f.workspaces);
    const delayed = f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "PostToolUse", tool_name: "update_plan",
      tool_input: { plan: [{ step: "Must not reappear", status: "completed" }] } }, f.workspaces);
    expect(subagent).toMatchObject({ accepted: false, ignored: "turn_already_ended", identity_observed: false });
    expect(delayed).toMatchObject({ accepted: false, ignored: "turn_already_ended", identity_observed: false,
      run_plan_projection: { accepted: false, reason: "turn_already_ended" } });
    expect(JSON.parse(f.runtime.getState("workspace-companion:hook-observations:v1")!)[0]).toEqual(endedObservation);
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]).toMatchObject({
      turn_id: "turn-ended", lifecycle: "turn_ended", steps: [{ title: "Original plan" }], acceptance: "not_evaluated"
    });
  });

  it("tombstones Stop even when no Plan exists so a delayed update cannot create one", async () => {
    const f = await fixture(); observeTurn(f, "turn-without-plan");
    const stopped = f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-without-plan" }, f.workspaces);
    expect(stopped.run_plan_projection).toMatchObject({ accepted: false, reason: "projection_not_found" });
    const delayed = updatePlan(f, [{ step: "Late plan", status: "in_progress" }], "turn-without-plan");
    expect(delayed.run_plan_projection).toMatchObject({ accepted: false, reason: "turn_already_ended" });
    expect(f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections).toEqual([]);
  });

  it("shows a foreign source session as unassigned and derives staleness only from real Hook time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
    const f = await fixture(); observeTurn(f, "turn-x", "foreign-session");
    const result = updatePlan(f, [{ step: "Unassigned observation", status: "pending" }], "turn-x", "foreign-session");
    expect(result.run_plan_projection.binding).toMatchObject({ state: "unassigned", execution_authorized: false });
    expect(result.run_plan_projection.workspace_id).toBe(f.workspace.id);
    vi.setSystemTime(new Date("2026-09-07T13:00:00.000Z"));
    const visible = f.companion.readRunPlanProjections(f.workspace.id, f.workspaces).projections[0]!;
    expect(visible.connection).toBe("stale");
    expect(visible.binding.state).toBe("unassigned");
  });

  it("requires the authoritative current turn even for a newer signed PostToolUse after a mid-turn restart", async () => {
    const f = await fixture();
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "SessionStart" }, f.workspaces, 1_000);
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "UserPromptSubmit", turn_id: "turn-ended" }, f.workspaces, 1_100);
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "PostToolUse", turn_id: "turn-ended", tool_name: "update_plan",
      tool_input: { plan: [{ step: "Old turn", status: "in_progress" }] } }, f.workspaces, 1_200);
    f.companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "Stop", turn_id: "turn-ended" }, f.workspaces, 1_300);

    const runtime = new RuntimeStore(f.root), events = new EventBus(), companion = new WorkspaceCompanion(f.root, runtime, events, { readonlyLegacy: true });
    const workspaces = new TaskWorkspaces(f.root, events, f.catalog,
      { sessions: record => companion.sessions(record), observations: record => companion.lifecycleObservations(record) });
    const nextPlan = { session_id: "thread-a", cwd: f.source, hook_event_name: "PostToolUse" as const, turn_id: "turn-current", tool_name: "update_plan",
      tool_input: { plan: [{ step: "Recovered current turn", status: "in_progress" }] } };
    try {
      const unsigned = companion.receiveHook(nextPlan, workspaces);
      expect(unsigned).toMatchObject({ accepted: false, ignored: "old_turn_event", identity_observed: false,
        run_plan_projection: { accepted: false, reason: "old_turn_event" } });

      const ended = companion.receiveHook({ ...nextPlan, turn_id: "turn-ended" }, workspaces, 2_000);
      expect(ended).toMatchObject({ accepted: false, ignored: "turn_already_ended", identity_observed: false,
        run_plan_projection: { accepted: false, reason: "turn_already_ended" } });

      const changedCwd = companion.receiveHook({ ...nextPlan, cwd: f.root }, workspaces, 2_500);
      expect(changedCwd).toMatchObject({ accepted: false, ignored: "old_turn_event", identity_observed: false,
        run_plan_projection: { accepted: false, reason: "old_turn_event" } });

      const before = runtime.getState("workspace-companion:hook-observations:v1");
      expect(companion.needsCurrentTurnVerification(nextPlan, 3_000)).toBe(true);
      expect(runtime.getState("workspace-companion:hook-observations:v1")).toBe(before);
      const unverified = companion.receiveHook(nextPlan, workspaces, 3_000);
      expect(unverified).toMatchObject({ accepted: false, ignored: "old_turn_event", identity_observed: false });
      expect(runtime.getState("workspace-companion:hook-observations:v1")).toBe(before);
      expect(companion.lifecycleObservations(f.workspace)).toEqual([]);
      const wrongTurn = companion.receiveHook(nextPlan, workspaces, 3_000,
        { sessionId: "thread-a", cwd: f.source, turnId: "different-current-turn" });
      expect(wrongTurn).toMatchObject({ accepted: false, ignored: "old_turn_event", identity_observed: false });
      expect(runtime.getState("workspace-companion:hook-observations:v1")).toBe(before);

      const recovered = companion.receiveHook(nextPlan, workspaces, 3_000,
        { sessionId: "thread-a", cwd: f.source, turnId: "turn-current" });
      expect(recovered).toMatchObject({ accepted: true, identity_observed: true,
        run_plan_projection: { accepted: true, changed: true, workspace_id: f.workspace.id } });
      expect(companion.lifecycleObservations(f.workspace)[0]).toMatchObject({ turn_id: "turn-current", last_event: "PostToolUse", authenticated_at_ms: 3_000 });
      expect(companion.readRunPlanProjections(f.workspace.id, workspaces).projections[0]).toMatchObject({
        turn_id: "turn-current", lifecycle: "active", connection: "current", steps: [{ title: "Recovered current turn" }]
      });

      const conflicting = companion.receiveHook({ ...nextPlan, turn_id: "turn-conflicting" }, workspaces, 4_000);
      expect(conflicting).toMatchObject({ accepted: false, ignored: "old_turn_event", identity_observed: false,
        run_plan_projection: { accepted: false, reason: "old_turn_event" } });
      expect(companion.lifecycleObservations(f.workspace)[0]?.turn_id).toBe("turn-current");
    } finally {
      await workspaces.close(); runtime.close();
    }
  });

  it("restores the projection as stale after restart and restores authority only after a new lifecycle Hook", async () => {
    const f = await fixture(); observeTurn(f); updatePlan(f, [{ step: "Persist across restart", status: "in_progress" }]);
    const runtime = new RuntimeStore(f.root), events = new EventBus(), companion = new WorkspaceCompanion(f.root, runtime, events, { readonlyLegacy: true });
    const workspaces = new TaskWorkspaces(f.root, events, f.catalog, { sessions: record => companion.sessions(record), observations: record => companion.lifecycleObservations(record) });
    try {
      expect(companion.readRunPlanProjections(f.workspace.id, workspaces).projections[0]).toMatchObject({
        turn_id: "turn-1", connection: "stale", lifecycle: "active", acceptance: "not_evaluated"
      });
      expect(workspaces.contextForAgent("thread-a", f.source, f.workspace.id)).toBeUndefined();
      companion.receiveHook({ session_id: "thread-a", cwd: f.source, hook_event_name: "SessionStart" }, workspaces);
      expect(workspaces.contextForAgent("thread-a", f.source, f.workspace.id)?.record.id).toBe(f.workspace.id);
      expect(companion.readRunPlanProjections(f.workspace.id, workspaces).projections[0]?.connection).toBe("current");
    } finally {
      await workspaces.close(); runtime.close();
    }
  });
});
