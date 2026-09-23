import { describe, expect, it } from "vitest";
import { adaptCodexPlanEvent } from "./codex-plan-event-adapter.ts";

describe("Codex plan event adapter", () => {
  it("keeps the existing update_plan contract", () => {
    expect(adaptCodexPlanEvent({ tool_name: "update_plan", tool_input: { plan: [{ step: "Inspect", status: "in_progress" }] } })).toMatchObject({
      accepted: true, source: "update_plan", operation: "replace", plan: { steps: [{ title: "Inspect", status: "in_progress" }] }
    });
  });

  it("requires a matching successful create_goal result and exposes one active objective", () => {
    const adapted = adaptCodexPlanEvent({
      tool_name: "create_goal",
      tool_input: { objective: "Build API_KEY=fixture-secret safely", token_budget: 1234, ignored: "never-store" },
      tool_response: { goal: { objective: "Build API_KEY=fixture-secret safely", status: "active", elapsed_time: 55 }, remainingTokens: 999 }
    });
    expect(adapted).toMatchObject({ accepted: true, source: "goal", operation: "create", goal_status: "active",
      plan: { steps: [{ title: "Build API_KEY=[REDACTED] safely", status: "in_progress" }] } });
    expect(JSON.stringify(adapted)).not.toContain("fixture-secret");
    expect(JSON.stringify(adapted)).not.toContain("token_budget");
    expect(JSON.stringify(adapted)).not.toContain("elapsed_time");
  });

  it("does not infer success from create_goal or update_goal input", () => {
    expect(adaptCodexPlanEvent({ tool_name: "create_goal", tool_input: { objective: "Unconfirmed" } })).toEqual({ accepted: false, reason: "goal_result_unverified" });
    expect(adaptCodexPlanEvent({ tool_name: "update_goal", tool_input: { status: "complete" }, tool_response: { error: "failed" } })).toEqual({ accepted: false, reason: "goal_result_unverified" });
    expect(adaptCodexPlanEvent({ tool_name: "update_goal", tool_input: { status: "complete" }, tool_response: { goal: { objective: "Still blocked", status: "blocked" } } })).toEqual({ accepted: false, reason: "goal_contract_invalid" });
  });

  it("refreshes get_goal and maps only verified terminal statuses", () => {
    expect(adaptCodexPlanEvent({ tool_name: "get_goal", tool_response: { goal: { objective: "Long work", status: "in_progress" } } })).toMatchObject({
      accepted: true, source: "goal", operation: "refresh", goal_status: "active", plan: { steps: [{ title: "Long work", status: "in_progress" }] }
    });
    expect(adaptCodexPlanEvent({ tool_name: "update_goal", tool_input: { status: "complete" }, tool_response: { goal: { objective: "Long work", status: "complete" } } })).toMatchObject({
      accepted: true, source: "goal", operation: "finish", goal_status: "complete", plan: { steps: [{ title: "Long work", status: "completed" }] }
    });
    expect(adaptCodexPlanEvent({ tool_name: "get_goal", tool_response: { goal: null } })).toEqual({ accepted: false, reason: "goal_not_active" });
  });

  it("ignores all ordinary tool contents", () => {
    expect(adaptCodexPlanEvent({ tool_name: "functions.exec", tool_input: { objective: "incidental", plan: [{ step: "incidental" }] }, tool_response: { goal: { objective: "incidental", status: "active" } } })).toEqual({ accepted: false, reason: "lifecycle_only" });
  });
});
