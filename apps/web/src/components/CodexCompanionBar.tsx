import { useEffect, useState, type ReactNode } from "react";
import { RadioTower, RefreshCw } from "lucide-react";
import { companionStageLabels, companionTaskContext } from "../companion.ts";
import type { CodexCompanionStatus, SupervisionTask } from "../types.ts";

interface Props {
  status?: CodexCompanionStatus;
  tasks: SupervisionTask[];
  taskId?: string;
  busy: boolean;
  error?: string;
  fallback?: ReactNode;
  onBind(sessionId: string): void;
  onSelectTask(taskId: string): void;
  onRefresh(): void;
}

export function CodexCompanionBar({ status, tasks, taskId, busy, error, fallback, onBind, onSelectTask, onRefresh }: Props) {
  const [candidateId, setCandidateId] = useState("");
  const { session, belongsToSession, progress, planStep, canSendFeedback, reason } = companionTaskContext(status, taskId);
  useEffect(() => {
    setCandidateId((current) => status?.sessions.some((item) => item.session_id === current) ? current : status?.selected_session_id ?? "");
  }, [status]);
  const taskStage = progress ? companionStageLabels[progress.stage]
    : planStep ? { pending: "尚未开始", in_progress: "执行中", completed: "Agent 已完成" }[planStep.status]
      : belongsToSession ? "等待任务进度" : "未关联此会话";
  const pending = status?.feedback.filter((item) => item.session_id === session?.session_id && item.task_id === taskId && item.status === "pending").length ?? 0;

  return <section className={`codex-companion-bar ${canSendFeedback ? "is-connected" : "is-offline"}`} data-testid="codex-companion-bar" aria-label="Codex 会话与任务归属">
    <div className="companion-identity"><RadioTower size={16} /><span><strong>Codex 伴随同步</strong><small>{status?.selection_required ? "待选择会话" : status?.connected && session ? "所选会话已连接" : "未连接"}</small></span></div>
    <div className="companion-facts">
      <span><small>会话阶段</small><strong>{session ? companionStageLabels[session.stage] : "未选择"}</strong></span>
      <span><small>当前任务状态</small><strong>{taskStage}</strong></span>
      <span><small>同步 Plan</small><strong>{session?.plan_version ?? "尚未同步"}</strong></span>
      <span><small>本任务待送达</small><strong>{pending}</strong></span>
    </div>
    <button className="companion-refresh" disabled={busy} onClick={onRefresh}><RefreshCw size={13} />刷新连接</button>
    <div className="companion-selection">
      <label>反馈目标会话<select aria-label="反馈目标会话" value={candidateId} disabled={busy || !status?.sessions.length} onChange={(event) => setCandidateId(event.target.value)}>
        <option value="">{status?.sessions.length ? "请选择 Codex 会话" : "尚无可选会话"}</option>
        {status?.sessions.map((item) => <option value={item.session_id} key={item.session_id}>{item.model ?? "Codex"} · {companionStageLabels[item.stage]} · {item.synced_task_ids.length} 项任务 · {item.session_id.length > 16 ? `${item.session_id.slice(0, 8)}…${item.session_id.slice(-4)}` : item.session_id}</option>)}
      </select></label>
      <button className="companion-refresh" disabled={busy || !candidateId || candidateId === session?.session_id} onClick={() => onBind(candidateId)}>绑定所选会话</button>
      <label>当前监督任务<select aria-label="当前监督任务" value={taskId ?? ""} disabled={busy || !tasks.length} onChange={(event) => onSelectTask(event.target.value)}>
        {!tasks.length && <option value="">等待 Plan 任务</option>}
        {tasks.map((task) => <option value={task.id} key={task.id}>{task.title}{session?.synced_task_ids.includes(task.id) ? " · 属于所选会话" : ""}</option>)}
      </select></label>
    </div>
    <p className="companion-scope-note" role="status">{error ?? reason}{progress?.summary && <span>{status?.connected ? "当前任务回报" : "上次任务回报"}：{progress.summary}</span>}{(progress?.stage === "completed" || planStep?.status === "completed") && <span>Agent 完成状态仍需通过产出证据和人工验收确认。</span>}</p>
    {fallback}
  </section>;
}
