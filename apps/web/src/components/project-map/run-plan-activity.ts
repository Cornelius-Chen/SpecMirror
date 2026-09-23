import type { RunPlanProjection } from "../../run-plan-api.ts";
import { latestRunPlanProjections, projectionState, type RunPlanTransportState } from "../run-plan-presentation.ts";
import type { ProjectMapRunPlanActivity } from "./types.ts";

/** Read reports, never replace a node's run/acceptance state or assign ownership. */
export function projectNodeRunPlanActivities(projections: readonly RunPlanProjection[], transport: RunPlanTransportState, unavailable = false): Record<string, ProjectMapRunPlanActivity> {
  const activities: Record<string, ProjectMapRunPlanActivity> = {};
  if (transport !== "live" || unavailable) return activities;
  // An older turn must not relight an earlier assignment or count one Agent
  // twice. Include terminal/stale reports when choosing the newest observation.
  const priority = { reported: 0, idle: 1, plan: 2, waiting: 3, running: 4 } as const;
  for (const report of latestRunPlanProjections(projections)) {
    const nodeId = report.binding.node_id;
    if (!nodeId || !["run", "owner"].includes(report.binding.state) || report.lifecycle !== "active" || report.connection !== "current") continue;
    const state = projectionState(report).key;
    const phase = state === "executing" ? "running" : state === "waiting" ? "waiting" : state === "reported" ? "reported" : state === "idle" ? "idle" : "plan";
    const current: ProjectMapRunPlanActivity = activities[nodeId] ?? { agentCount: 0, completedSteps: 0, totalSteps: 0, executionAuthorized: false, phase };
    current.agentCount++;
    current.completedSteps += report.steps.filter(step => step.status === "completed").length;
    current.totalSteps += report.steps.length;
    current.executionAuthorized ||= report.binding.state === "run" && report.binding.execution_authorized;
    if (priority[phase] >= priority[current.phase]) {
      current.phase = phase;
      current.currentStepTitle = report.steps.find(step => step.status === "in_progress")?.title;
    }
    activities[nodeId] = current;
  }
  return activities;
}
