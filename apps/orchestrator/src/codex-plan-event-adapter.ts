import { normalizeRunPlan, type NormalizedRunPlan } from "./run-plan-projection.ts";

export type CodexPlanSource = "update_plan" | "goal";
export type CodexGoalStatus = "active" | "complete" | "blocked";

export type AdaptedCodexPlanEvent =
  | { accepted: true; source: "update_plan"; operation: "replace"; plan: NormalizedRunPlan }
  | { accepted: true; source: "goal"; operation: "create" | "refresh" | "finish"; plan: NormalizedRunPlan; goal_status: CodexGoalStatus }
  | { accepted: false; reason: "lifecycle_only" | "plan_contract_invalid" | "goal_contract_invalid" | "goal_result_unverified" | "goal_not_active" };

type GoalSnapshot = { objective: string; status: CodexGoalStatus };

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

function goalStatus(value: unknown): CodexGoalStatus | null {
  if (value === "active" || value === "in_progress") return "active";
  if (value === "complete" || value === "completed") return "complete";
  if (value === "blocked") return "blocked";
  return null;
}

function goalSnapshot(value: unknown): GoalSnapshot | null {
  const envelope = record(value), goal = record(envelope?.goal);
  if (!goal) return null;
  const status = goalStatus(goal.status);
  if (typeof goal.objective !== "string" || !goal.objective.trim() || !status) return null;
  const plan = normalizeRunPlan([{ step: goal.objective, status: status === "complete" ? "completed" : status === "active" ? "in_progress" : "pending" }]);
  return plan ? { objective: plan.steps[0]!.title, status } : null;
}

function goalPlan(snapshot: GoalSnapshot) {
  return normalizeRunPlan([{ step: snapshot.objective, status: snapshot.status === "complete" ? "completed" : snapshot.status === "active" ? "in_progress" : "pending" }])!;
}

/**
 * Converts the bounded PostToolUse surfaces into one observation-only plan
 * contract. Callers must pass a relay-sanitized response envelope; this
 * adapter deliberately never searches arbitrary tool output or content text.
 */
export function adaptCodexPlanEvent(input: { tool_name?: unknown; tool_input?: unknown; tool_response?: unknown }): AdaptedCodexPlanEvent {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = record(input.tool_input);
  if (toolName === "update_plan") {
    const plan = normalizeRunPlan(toolInput?.plan);
    return plan ? { accepted: true, source: "update_plan", operation: "replace", plan } : { accepted: false, reason: "plan_contract_invalid" };
  }
  if (!["create_goal", "get_goal", "update_goal"].includes(toolName)) return { accepted: false, reason: "lifecycle_only" };

  const response = record(input.tool_response);
  if (response?.goal === null) return { accepted: false, reason: "goal_not_active" };
  const snapshot = goalSnapshot(response);
  if (!snapshot) return { accepted: false, reason: "goal_result_unverified" };

  if (toolName === "create_goal") {
    const requested = normalizeRunPlan([{ step: toolInput?.objective, status: "in_progress" }]);
    if (!requested || snapshot.status !== "active" || requested.steps[0]!.title !== snapshot.objective) return { accepted: false, reason: "goal_contract_invalid" };
    return { accepted: true, source: "goal", operation: "create", plan: goalPlan(snapshot), goal_status: snapshot.status };
  }
  if (toolName === "update_goal") {
    const requested = toolInput?.status;
    if (!new Set(["complete", "blocked"]).has(requested as string) || requested !== snapshot.status) return { accepted: false, reason: "goal_contract_invalid" };
    return { accepted: true, source: "goal", operation: "finish", plan: goalPlan(snapshot), goal_status: snapshot.status };
  }
  return { accepted: true, source: "goal", operation: snapshot.status === "active" ? "refresh" : "finish", plan: goalPlan(snapshot), goal_status: snapshot.status };
}
