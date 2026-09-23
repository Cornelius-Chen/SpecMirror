import { minimatch } from "minimatch";
import type { GoalContract } from "./schema.ts";

export interface LintFinding { code: string; message: string; severity: "error" | "warning" }

export interface StructuredGoalPlan {
  outcome: string;
  primaryOutcomes: string[];
  ownershipModules: string[];
  plannedWriteGlobs: string[];
  sharedContracts: string[];
  unresolvedQuestions: string[];
  steps: Array<{ title: string; acceptance: string }>;
  risks: string[];
}

export function lintGoal(goal: GoalContract): LintFinding[] {
  const findings: LintFinding[] = [];
  if (!goal.outcome.trim()) findings.push({ code: "missing_outcome", message: "Goal 必须有单一主要结果。", severity: "error" });
  if (!goal.ownership_modules.length) findings.push({ code: "missing_ownership", message: "Goal 必须声明至少一个所有权模块。", severity: "error" });
  if (goal.ownership_modules.length > 2) findings.push({ code: "too_many_modules", message: "Goal 最多拥有两个模块。", severity: "error" });
  if (goal.unresolved_design_questions.length) findings.push({ code: "unresolved_design", message: "实施前必须关闭设计问题。", severity: "error" });
  if (!goal.acceptance_commands.length) findings.push({ code: "not_independently_accepted", message: "Goal 必须可独立验收。", severity: "error" });
  if (!goal.write_globs.length) findings.push({ code: "missing_write_domain", message: "Goal 必须声明写入范围。", severity: "error" });
  if (goal.max_minutes > 60 || goal.max_turns > 8) findings.push({ code: "limit_exceeded", message: "Goal 超过硬运行上限。", severity: "error" });
  return findings;
}

export function lintGoalPlan(goal: GoalContract, plan: StructuredGoalPlan): LintFinding[] {
  const findings: LintFinding[] = [];
  if (plan.outcome.trim() !== goal.outcome.trim() || plan.primaryOutcomes.length !== 1 || plan.primaryOutcomes[0]?.trim() !== goal.outcome.trim()) {
    findings.push({ code: "plan_outcome_drift", message: "Worker Plan 必须保持 Goal Contract 的单一主要结果。", severity: "error" });
  }
  if (!plan.steps.length || plan.steps.length > goal.max_turns || plan.steps.some((step) => !step.title.trim() || !step.acceptance.trim())) {
    findings.push({ code: "plan_step_budget", message: `Worker Plan 必须包含 1-${goal.max_turns} 个可独立验收步骤。`, severity: "error" });
  }
  const unownedModules = plan.ownershipModules.filter((module) => !goal.ownership_modules.includes(module));
  if (!plan.ownershipModules.length || plan.ownershipModules.length > 2 || unownedModules.length) {
    findings.push({ code: "plan_ownership_drift", message: `Worker Plan 越过所有权模块：${unownedModules.join(", ") || (!plan.ownershipModules.length ? "未声明所有权" : "超过两个模块")}`, severity: "error" });
  }
  const outOfScopeGlobs = plan.plannedWriteGlobs.filter((planned) => !goal.write_globs.some((allowed) => globContainedBy(planned, allowed)));
  if (!plan.plannedWriteGlobs.length || outOfScopeGlobs.length) {
    findings.push({ code: "plan_write_scope_drift", message: `Worker Plan 写域越界：${outOfScopeGlobs.join(", ") || "未声明计划写域"}`, severity: "error" });
  }
  const allowedContracts = new Set(goal.shared_contracts.map(normalizeResource));
  const unownedContracts = plan.sharedContracts.filter((contract) => !allowedContracts.has(normalizeResource(contract)));
  if (unownedContracts.length) {
    findings.push({ code: "plan_shared_contract_drift", message: `Worker Plan 引入未授权共享契约：${unownedContracts.join(", ")}`, severity: "error" });
  }
  if (plan.unresolvedQuestions.length) {
    findings.push({ code: "plan_unresolved_design", message: `Worker Plan 仍有未决设计问题：${plan.unresolvedQuestions.join("；")}`, severity: "error" });
  }
  return findings;
}

function globPrefix(glob: string): string {
  return glob.replaceAll("\\", "/").split(/[*?[{]/, 1)[0].replace(/\/$/, "");
}

function globContainedBy(candidate: string, allowed: string) {
  const planned = candidate.replaceAll("\\", "/");
  const boundary = allowed.replaceAll("\\", "/");
  if (planned === boundary) return true;
  const plannedPrefix = globPrefix(planned);
  const allowedPrefix = globPrefix(boundary);
  if (!allowedPrefix || !plannedPrefix.startsWith(allowedPrefix)) return false;
  return minimatch(plannedPrefix, boundary, { dot: true }) || plannedPrefix === allowedPrefix || plannedPrefix.startsWith(`${allowedPrefix}/`);
}

export function globsOverlap(a: string, b: string): boolean {
  const left = a.replaceAll("\\", "/");
  const right = b.replaceAll("\\", "/");
  const leftPrefix = globPrefix(left);
  const rightPrefix = globPrefix(right);
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix) || minimatch(leftPrefix, right) || minimatch(rightPrefix, left);
}

export function goalsConflict(a: GoalContract, b: GoalContract): boolean {
  const rightContracts = new Set(b.shared_contracts.map(normalizeResource));
  if (a.shared_contracts.some((contract) => rightContracts.has(normalizeResource(contract)))) return true;
  return a.write_globs.some((left) => b.write_globs.some((right) => globsOverlap(left, right)));
}

function normalizeResource(value: string) {
  return value.replaceAll("\\", "/");
}

export function scheduleGoals(goals: GoalContract[], completed = new Set<string>(), failed = new Set<string>(), maxWorkers = 3, running: GoalContract[] = []) {
  const blockedDownstream = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const goal of goals) {
      if (!blockedDownstream.has(goal.id) && goal.dependencies.some((id) => failed.has(id) || blockedDownstream.has(id))) {
        blockedDownstream.add(goal.id); changed = true;
      }
    }
  }
  const runningIds = new Set(running.map((goal) => goal.id));
  const eligible = goals.filter((goal) => !completed.has(goal.id) && !failed.has(goal.id) && !runningIds.has(goal.id) && !blockedDownstream.has(goal.id) && goal.dependencies.every((id) => completed.has(id)) && !lintGoal(goal).some((item) => item.severity === "error"));
  const selected: GoalContract[] = [];
  for (const goal of eligible) {
    if (selected.length >= Math.max(0, Math.min(maxWorkers, 3) - running.length)) break;
    if (![...running, ...selected].some((activeGoal) => goalsConflict(goal, activeGoal))) selected.push(goal);
  }
  return { runnable: selected, waiting: eligible.filter((goal) => !selected.includes(goal)), blocked: [...blockedDownstream] };
}

export function validateGoalDag(goals: GoalContract[]): string[] {
  const errors: string[] = [];
  const ids = new Set(goals.map((goal) => goal.id));
  for (const goal of goals) for (const dependency of goal.dependencies) if (!ids.has(dependency)) errors.push(`missing_dependency:${goal.id}:${dependency}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  function visit(id: string, path: string[]) {
    if (visiting.has(id)) { errors.push(`dependency_cycle:${[...path, id].join("->")}`); return; }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency, [...path, id]);
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id, []);
  return [...new Set(errors)];
}

export function isPathAllowed(path: string, goal: GoalContract): boolean {
  const normalized = path.replaceAll("\\", "/");
  return goal.write_globs.some((glob) => minimatch(normalized, glob.replaceAll("\\", "/"), { dot: true }));
}

export function scopeViolations(paths: string[], goal: GoalContract): string[] {
  return paths.filter((path) => !isPathAllowed(path, goal));
}

export type PlanCandidateKind = "design" | "decision" | "evidence" | "constraint";

/** Parse free-form Plan text into review-only candidates. This function never writes YAML or trace links. */
export function parsePlanCandidates(source: string) {
  const lines = source
    .split(/\r?\n|[。；;]|\s+但\s*/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
    .filter((line) => line.length >= 4 && !line.startsWith("#"));
  return [...new Set(lines)].map((title, index) => {
    const kind: PlanCandidateKind = /证据|验证|测试|test|evidence/i.test(title)
      ? "evidence"
      : /尚未决定|未决定|决策|决定|decision/i.test(title)
        ? "decision"
        : /约束|禁止|必须|constraint/i.test(title)
          ? "constraint"
          : "design";
    return {
      id: `candidate-${index + 1}`,
      title,
      kind,
      status: "suggested" as const,
      proposed_status: kind === "decision" ? "proposed" : kind === "design" ? "draft" : "candidate",
      formal: false as const
    };
  });
}
