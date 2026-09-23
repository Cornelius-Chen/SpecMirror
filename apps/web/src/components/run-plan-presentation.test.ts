import { describe, expect, it } from "vitest";
import type { RunPlanProjection } from "../run-plan-api.ts";
import { groupRunPlanProjections, projectionState, runPlanMotion, runPlanSessionLabel, visibleRunPlanSteps } from "./run-plan-presentation.ts";

function plan(): RunPlanProjection {
  return {
    id: "plan", workspace_id: "workspace", session_id: "session", source_cwd: "fixture", turn_id: "turn", plan_hash: "fixture",
    lifecycle: "active", connection: "current",
    binding: { state: "workspace", node_id: null, run_id: null, owner: null, contract_key: null, execution_authorized: false },
    steps: [{ id: "step", order: 0, title: "核对来源", status: "in_progress" }],
    started_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:01:00Z", ended_at: null, acceptance: "not_evaluated", notice: "Agent 自报"
  };
}

describe("run plan activity presentation", () => {
  it("keeps every mixed report discoverable under its actual binding and lifecycle without changing source records", () => {
    const report = (id: string, patch: Partial<RunPlanProjection> = {}) => ({ ...plan(), id, session_id: `session-${id}`, ...patch });
    const linked = { ...plan().binding, state: "run" as const, node_id: "node-one", run_id: "run-one", execution_authorized: true };
    const projections = [
      report("unknown-one", { binding: { ...plan().binding, state: "unassigned" } }),
      report("executing", { binding: linked }),
      report("unknown-two", { binding: { ...plan().binding, state: "ambiguous" } }),
      report("owner", { binding: { ...linked, state: "owner", run_id: null, execution_authorized: false } }),
      report("workspace", { binding: { ...plan().binding, node_id: "root" } }),
      report("ended", { binding: linked, lifecycle: "turn_ended" }),
      report("stale", { binding: linked, connection: "stale" }),
      report("missing-node", { binding: { ...linked, node_id: null } }),
      report("unknown-three", { binding: { ...plan().binding, state: "unassigned" }, updated_at: "2026-09-13T00:02:00Z" })
    ];
    const before = JSON.stringify(projections), groups = groupRunPlanProjections(projections);
    expect(groups.map(group => [group.id, group.projections.map(item => item.id)])).toEqual([
      ["linked", ["executing", "owner"]],
      ["unassigned", ["unknown-three", "missing-node", "unknown-one", "unknown-two", "workspace"]],
      ["inactive", ["ended", "stale"]]
    ]);
    expect(groups.flatMap(group => group.projections)).toHaveLength(projections.length);
    expect(new Set(groups.flatMap(group => group.projections.map(item => item.id))).size).toBe(projections.length);
    expect(JSON.stringify(projections)).toBe(before);
    expect(groups[2].projections.every(item => runPlanMotion(item, "live", true) === "static")).toBe(true);
    expect(groups[1].projections.filter(item => item.binding.state !== "run").every(item => runPlanMotion(item, "live", true) !== "execution")).toBe(true);
  });

  it("keeps empty and task-only reads within their returned scope and labels the actual session", () => {
    expect(groupRunPlanProjections([])).toEqual([]);
    const taskOnly = { ...plan(), workspace_id: null, binding: { ...plan().binding, state: "unassigned" as const } };
    expect(groupRunPlanProjections([taskOnly]).map(group => group.id)).toEqual(["unassigned"]);
    expect(runPlanSessionLabel("session-a")).toBe("session-a");
    expect(runPlanSessionLabel("01a09890-93ab-7772-bd13-978c7d956d83")).toBe("01a09890…6d83");
  });

  it("distinguishes a reported step from authorized engineering execution", () => {
    const projection = plan();
    expect(runPlanMotion(projection, "live", true)).toBe("reported");
    projection.binding.execution_authorized = true;
    expect(runPlanMotion(projection, "live", true)).toBe("reported");
    projection.binding.state = "run";
    expect(runPlanMotion(projection, "live", true)).toBe("execution");
    projection.binding.execution_authorized = false;
    expect(projectionState(projection).key).toBe("waiting");
    expect(runPlanMotion(projection, "live", true)).toBe("static");
  });

  it("stops on ended or stale reports, missing current steps, hidden pages, errors and offline transport", () => {
    const projection = plan();
    for (const transport of ["connecting", "offline"] as const) expect(runPlanMotion(projection, transport, true)).toBe("static");
    expect(runPlanMotion(projection, "live", false)).toBe("static");
    expect(runPlanMotion(projection, "live", true, true)).toBe("static");
    projection.connection = "stale";
    expect(runPlanMotion(projection, "live", true)).toBe("static");
    projection.connection = "current"; projection.lifecycle = "turn_ended";
    expect(runPlanMotion(projection, "live", true)).toBe("static");
    projection.lifecycle = "active"; projection.steps[0].status = "completed";
    expect(runPlanMotion(projection, "live", true)).toBe("static");
    expect(projectionState(projection).key).toBe("reported");
    expect(projection.acceptance).toBe("not_evaluated");
    projection.binding.state = "run"; projection.binding.execution_authorized = true;
    expect(projectionState(projection).key).toBe("reported");
    projection.steps[0].status = "pending";
    expect(projectionState(projection).key).toBe("idle");
    projection.steps = [];
    expect(projectionState(projection).key).toBe("idle");
  });

  it("shows the current step in a long plan without changing order or source records", () => {
    const projection = plan();
    projection.steps = Array.from({ length: 14 }, (_, order) => ({ id: `step-${order}`, order, title: `步骤 ${order + 1}`, status: order < 10 ? "completed" : order === 10 ? "in_progress" : "pending" }));
    const before = JSON.stringify(projection);
    const visible = visibleRunPlanSteps(projection);
    expect(visible).toHaveLength(7);
    expect(visible.some(step => step.id === "step-10")).toBe(true);
    expect(visible.map(step => step.order)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(JSON.stringify(projection)).toBe(before);
    expect(visibleRunPlanSteps(plan())).toHaveLength(1);
  });
});
