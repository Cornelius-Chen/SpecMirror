import { z } from "zod";
import { Id } from "./schema.ts";

export const CompletionTaskStatusSchema = z.enum(["done", "in_progress", "pending", "waiting_user", "blocked"]);

export const CompletionConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supervision_detail_accepted"), detail_id: Id }),
  z.object({ kind: z.literal("codex_smoke_passed") }),
  z.object({ kind: z.literal("baseline_guarded"), baseline_id: Id })
]);

export const CompletionTaskSchema = z.object({
  id: z.string().min(2).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  title: z.string().min(1),
  status: CompletionTaskStatusSchema,
  evidence: z.array(z.string().min(1)).default([]),
  action: z.string().min(1).optional(),
  condition: CompletionConditionSchema.optional()
}).superRefine((task, context) => {
  if (task.status === "done" && task.evidence.length === 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "已完成任务必须给出可复核证据" });
  }
  if (["waiting_user", "blocked"].includes(task.status) && !task.action) {
    context.addIssue({ code: "custom", path: ["action"], message: "等待或阻塞任务必须说明解除动作" });
  }
});

export const CompletionWorkstreamSchema = z.object({
  id: z.string().min(2).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  title: z.string().min(1),
  description: z.string().min(1),
  tasks: z.array(CompletionTaskSchema).min(1)
});

export const CompletionAuditSchema = z.object({
  schema_version: z.number().int().positive(),
  id: z.string().min(2).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  title: z.string().min(1),
  updated_at: z.string().datetime({ offset: true }),
  counting_rule: z.literal("atomic_tasks_equal_weight_done_only"),
  workstreams: z.array(CompletionWorkstreamSchema).min(1)
}).superRefine((audit, context) => {
  const ids = new Set<string>();
  for (const [workstreamIndex, workstream] of audit.workstreams.entries()) {
    if (ids.has(workstream.id)) context.addIssue({ code: "custom", path: ["workstreams", workstreamIndex, "id"], message: `重复 ID：${workstream.id}` });
    ids.add(workstream.id);
    for (const [taskIndex, task] of workstream.tasks.entries()) {
      if (ids.has(task.id)) context.addIssue({ code: "custom", path: ["workstreams", workstreamIndex, "tasks", taskIndex, "id"], message: `重复 ID：${task.id}` });
      ids.add(task.id);
    }
  }
});

export type CompletionTaskStatus = z.infer<typeof CompletionTaskStatusSchema>;
export type CompletionCondition = z.infer<typeof CompletionConditionSchema>;
export type CompletionTask = z.infer<typeof CompletionTaskSchema>;
export type CompletionWorkstream = z.infer<typeof CompletionWorkstreamSchema>;
export type CompletionAudit = z.infer<typeof CompletionAuditSchema>;

export interface CompletionFacts {
  acceptedSupervisionDetailIds: readonly string[];
  codexSmokePassed: boolean;
  guardedBaselineIds: readonly string[];
}

export interface CompletionTaskProgress extends Omit<CompletionTask, "status"> {
  status: CompletionTaskStatus;
  declaredStatus: CompletionTaskStatus;
  resolved: boolean;
  resolution?: string;
}

export interface CompletionWorkstreamProgress extends Omit<CompletionWorkstream, "tasks"> {
  tasks: CompletionTaskProgress[];
  done: number;
  total: number;
  progress: number;
  status: Exclude<CompletionTaskStatus, "pending"> | "pending";
}

export interface CompletionProgress {
  id: string;
  title: string;
  updatedAt: string;
  countingRule: CompletionAudit["counting_rule"];
  done: number;
  total: number;
  progress: number;
  waitingUser: number;
  blocked: number;
  inProgress: number;
  pending: number;
  workstreams: CompletionWorkstreamProgress[];
  nextAction: { taskId: string | null; title: string; action: string };
}

export function deriveCompletionProgress(audit: CompletionAudit, facts?: CompletionFacts): CompletionProgress {
  const workstreams = audit.workstreams.map((workstream): CompletionWorkstreamProgress => {
    const tasks = workstream.tasks.map((task) => resolveTask(task, facts));
    const counts = countTasks(tasks);
    return {
      ...workstream,
      tasks,
      done: counts.done,
      total: tasks.length,
      progress: percent(counts.done, tasks.length),
      status: workstreamStatus(tasks)
    };
  });
  const tasks = workstreams.flatMap((workstream) => workstream.tasks);
  const counts = countTasks(tasks);
  const next = tasks.find((task) => task.status === "in_progress")
    ?? tasks.find((task) => task.status === "waiting_user")
    ?? tasks.find((task) => task.status === "blocked")
    ?? tasks.find((task) => task.status === "pending");
  return {
    id: audit.id,
    title: audit.title,
    updatedAt: audit.updated_at,
    countingRule: audit.counting_rule,
    done: counts.done,
    total: tasks.length,
    progress: percent(counts.done, tasks.length),
    waitingUser: counts.waiting_user,
    blocked: counts.blocked,
    inProgress: counts.in_progress,
    pending: counts.pending,
    workstreams,
    nextAction: next
      ? { taskId: next.id, title: next.title, action: next.action ?? "继续完成该任务并补充可复核证据。" }
      : { taskId: null, title: "全部原子任务已完成", action: "进入最终完成审计。" }
  };
}

function resolveTask(task: CompletionTask, facts?: CompletionFacts): CompletionTaskProgress {
  const resolved = Boolean(task.condition && facts && conditionSatisfied(task.condition, facts));
  return {
    ...task,
    status: resolved ? "done" : task.status,
    declaredStatus: task.status,
    resolved,
    resolution: resolved && task.condition ? conditionResolution(task.condition) : undefined
  };
}

function conditionSatisfied(condition: CompletionCondition, facts: CompletionFacts) {
  if (condition.kind === "supervision_detail_accepted") return facts.acceptedSupervisionDetailIds.includes(condition.detail_id);
  if (condition.kind === "codex_smoke_passed") return facts.codexSmokePassed;
  return facts.guardedBaselineIds.includes(condition.baseline_id);
}

function conditionResolution(condition: CompletionCondition) {
  if (condition.kind === "supervision_detail_accepted") return `设计条目 ${condition.detail_id} 已由监督者通过`;
  if (condition.kind === "codex_smoke_passed") return "真实 Codex 隔离烟测已通过";
  return `基线 ${condition.baseline_id} 已进入 guarded`;
}

function countTasks(tasks: Array<{ status: CompletionTaskStatus }>) {
  return tasks.reduce((counts, task) => ({ ...counts, [task.status]: counts[task.status] + 1 }), {
    done: 0, in_progress: 0, pending: 0, waiting_user: 0, blocked: 0
  } as Record<CompletionTaskStatus, number>);
}

function percent(done: number, total: number) {
  return total ? Math.round(done / total * 100) : 0;
}

function workstreamStatus(tasks: Array<{ status: CompletionTaskStatus }>): CompletionWorkstreamProgress["status"] {
  if (tasks.every((task) => task.status === "done")) return "done";
  if (tasks.some((task) => task.status === "in_progress")) return "in_progress";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "waiting_user")) return "waiting_user";
  return "pending";
}
