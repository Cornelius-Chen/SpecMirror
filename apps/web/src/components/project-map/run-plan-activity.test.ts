import { describe, expect, it } from "vitest";
import type { RunPlanProjection } from "../../run-plan-api.ts";
import { projectNodeRunPlanActivities } from "./run-plan-activity.ts";

const report = (patch: Partial<RunPlanProjection> = {}): RunPlanProjection => ({
  id: "report-one", workspace_id: "workspace", session_id: "agent-a", source_cwd: "fixture", turn_id: "turn-one", plan_hash: "one",
  lifecycle: "active", connection: "current", binding: { state: "run", node_id: "node", run_id: "run", owner: "codex:agent-a", contract_key: "contract", execution_authorized: true },
  steps: [{ id: "first", order: 0, title: "修复展开布局", status: "in_progress" }], started_at: "2026-09-13T01:00:00Z", updated_at: "2026-09-13T01:01:00Z", ended_at: null, acceptance: "not_evaluated", notice: "步骤报告", ...patch
});

describe("map activity is a current report, not engineering acceptance", () => {
  it("requires a current step for running and keeps reported completion distinct", () => {
    const p = report(), before = JSON.stringify(p);
    expect(projectNodeRunPlanActivities([p], "live").node).toMatchObject({ phase: "running", currentStepTitle: "修复展开布局", agentCount: 1 });
    expect(JSON.stringify(p)).toBe(before);
    p.steps[0].status = "completed";
    expect(projectNodeRunPlanActivities([p], "live").node).toMatchObject({ phase: "reported", completedSteps: 1, executionAuthorized: true });
    expect(p.acceptance).toBe("not_evaluated");
    p.steps[0].status = "pending";
    expect(projectNodeRunPlanActivities([p], "live").node.phase).toBe("idle");
    p.steps = [];
    expect(projectNodeRunPlanActivities([p], "live").node.phase).toBe("idle");
  });
  it("does not turn a stale or unavailable observation into map activity", () => {
    for (const transport of ["offline", "connecting"] as const) expect(projectNodeRunPlanActivities([report()], transport)).toEqual({});
    expect(projectNodeRunPlanActivities([report()], "live", true)).toEqual({});
    expect(projectNodeRunPlanActivities([report({ connection: "stale" })], "live")).toEqual({});
    expect(projectNodeRunPlanActivities([report({ lifecycle: "turn_ended" })], "live")).toEqual({});
  });
  it("never treats an unassigned or owner-only report as authorized execution", () => {
    for (const state of ["workspace", "ambiguous", "unassigned"] as const) expect(projectNodeRunPlanActivities([report({ binding: { ...report().binding, state } })], "live")).toEqual({});
    expect(projectNodeRunPlanActivities([report({ binding: { ...report().binding, state: "owner" } })], "live").node).toMatchObject({ phase: "plan", executionAuthorized: false });
    expect(projectNodeRunPlanActivities([report({ binding: { ...report().binding, execution_authorized: false } })], "live").node.phase).toBe("waiting");
  });
  it("counts a session once and never revives an old assignment after a newer report", () => {
    const old = report(), newer = report({ id: "new", turn_id: "turn-two", updated_at: "2026-09-13T01:02:00Z", steps: [{ id: "done", order: 0, title: "已核对", status: "completed" }] });
    expect(projectNodeRunPlanActivities([old, newer, old], "live").node).toMatchObject({ agentCount: 1, totalSteps: 1, phase: "reported" });
    expect(projectNodeRunPlanActivities([newer, old], "live").node.phase).toBe("reported");
    newer.lifecycle = "turn_ended";
    expect(projectNodeRunPlanActivities([old, newer], "live")).toEqual({});
    newer.lifecycle = "active"; newer.binding = { ...newer.binding, state: "unassigned", node_id: null };
    expect(projectNodeRunPlanActivities([old, newer], "live")).toEqual({});
  });
  it("retains another actual agent's current work while one reports done", () => {
    const done = report({ steps: [{ id: "done", order: 0, title: "已检查", status: "completed" }] });
    const running = report({ id: "b", session_id: "agent-b", binding: { ...done.binding, owner: "codex:agent-b" } });
    for (const rows of [[done, running], [running, done]]) expect(projectNodeRunPlanActivities(rows, "live").node).toMatchObject({ agentCount: 2, totalSteps: 2, completedSteps: 1, phase: "running", currentStepTitle: "修复展开布局" });
  });
});
