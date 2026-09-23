import type { CodexCompanionStage, CodexCompanionStatus } from "./types.ts";

export const companionStageLabels: Record<CodexCompanionStage, string> = {
  connected: "已连接", planning: "规划中", implementing: "实现中", testing: "验证中",
  reviewing: "检查中", blocked: "等待处理", completed: "Agent 已完成", idle: "空闲"
};

export function companionTaskContext(status: CodexCompanionStatus | undefined, taskId: string | undefined) {
  const session = !status?.selection_required && status?.selected_session_id === status?.latest_session?.session_id
    ? status?.latest_session ?? undefined : undefined;
  const belongsToSession = Boolean(taskId && session?.synced_task_ids.includes(taskId));
  const progress = belongsToSession ? session?.task_progress?.find((item) => item.task_id === taskId) : undefined;
  const planStep = belongsToSession ? session?.plan_steps?.find((item) => item.task_id === taskId) : undefined;
  const canSendFeedback = Boolean(status?.connected && session && belongsToSession);
  const reason = !status ? "伴随同步暂不可用；仍可审查已有产出。"
    : status.selection_required ? "发现多个 Codex 会话，请先选择并绑定反馈目标。"
      : !session ? "尚未连接 Codex 会话；可继续审查已有产出。"
        : !status.connected ? "所选会话已离线；恢复连接后才能发送反馈。"
          : !belongsToSession ? "当前任务不属于所选会话，请切换任务或绑定对应会话。"
            : "反馈将仅发送到所选会话的当前任务，在下一个安全回合边界送达。";
  return { session, belongsToSession, progress, planStep, canSendFeedback, reason };
}
