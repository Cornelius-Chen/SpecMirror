import { AlertTriangle, Bot, Check, CheckCircle2, Circle, GitMerge, MessageSquareText, Pause, Play, Send, ShieldCheck, Sparkles, Target, TestTube2, UserCheck, X } from "lucide-react";
import { useState } from "react";
import type { CodexCompanionStatus, SupervisionCategory, SupervisionDetail, SupervisionProgress, SupervisionRun, SupervisionTask } from "../types.ts";
import { companionTaskContext } from "../companion.ts";

type FlowState = "done" | "active" | "waiting" | "blocked";

function readableCodexEvent(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const labels: Record<string, string> = {
    "mcp/progress": "Codex 正在同步执行进度",
    "mcp/plan-sync": "Codex 已同步最新 Plan",
    "turn/started": "Codex 已开始处理本轮任务",
    "turn/completed": "Codex 已完成本轮任务",
    "item/started": "Codex 正在处理当前步骤",
    "plan/updated": "Codex 已更新任务计划"
  };
  return labels[value] ?? (value.includes("/") ? "Codex 正在更新执行状态" : value);
}

const categoryMeta: Record<SupervisionCategory, { label: string; meaning: string }> = {
  function: { label: "功能", meaning: "行为与结果" },
  visual: { label: "视觉", meaning: "画面与层级" },
  interaction: { label: "交互", meaning: "操作与反馈" },
  copy: { label: "文案", meaning: "语言与理解" },
  asset: { label: "素材", meaning: "来源与授权" }
};

function taskFlow(task: SupervisionTask, details: SupervisionDetail[], run: SupervisionRun | undefined, companion: CodexCompanionStatus | undefined) {
  const { progress, canSendFeedback } = companionTaskContext(companion, task.id);
  const taskStage = canSendFeedback ? progress?.stage : undefined;
  const hasOutput = details.some((detail) => detail.output);
  const allAccepted = details.length > 0 && details.every((detail) => detail.status === "accepted");
  const needsRevision = details.some((detail) => detail.status === "needs_revision");
  const readyDesign = details.length > 0 && details.every((detail) => detail.status !== "draft");
  const testsPassed = details.some((detail) => detail.output?.checks.length) && details.every((detail) => !detail.output || detail.output.checks.every((check) => check.result === "pass"));
  const liveWorker = ["planning", "implementing"].includes(taskStage ?? "") || ["queued", "running"].includes(run?.status ?? "");
  const liveTests = taskStage === "testing";
  const liveReview = taskStage === "reviewing";
  const workerBlocked = taskStage === "blocked";

  const raw = [
    { id: "goal", label: "任务目标", actor: "你与监督 Agent", icon: Target, state: task.objective.trim() ? "done" : "active", note: task.objective || "等待补充任务结果", jobs: ["收集目标", "确认结果"] },
    { id: "understand", label: "设计理解", actor: "监督 Agent", icon: Sparkles, state: readyDesign ? "done" : "active", note: readyDesign ? "设计条件已形成" : "仍有设计条目需要完善", jobs: ["解析要求", "找出边界", "检查风险"] },
    { id: "split", label: "任务冻结", actor: "监督 Agent", icon: ShieldCheck, state: task.status === "frozen" ? "done" : task.status === "ready" ? "active" : "waiting", note: task.status === "frozen" ? `${task.version} 已锁定` : "冻结后 Agent 才能执行", jobs: ["拆分工作", "冻结版本"] },
    { id: "worker", label: "Agent 执行", actor: "执行 Agent", icon: Bot, state: workerBlocked ? "blocked" : liveWorker ? "active" : hasOutput ? "done" : "waiting", note: workerBlocked ? progress?.summary || "当前任务等待处理" : liveWorker ? progress?.summary || "正在按任务边界执行" : hasOutput ? "产出已经回挂" : "等待派发", jobs: ["读取范围", "制作产出", "回挂结果"] },
    { id: "test", label: "证据验证", actor: "自动验证", icon: TestTube2, state: liveTests ? "active" : testsPassed ? "done" : hasOutput ? "blocked" : "waiting", note: liveTests ? progress?.summary || "正在验证当前任务" : testsPassed ? "验收证据全部满足" : hasOutput ? "存在待补证据" : "等待 Agent 产出", jobs: ["运行测试", "收集证据"] },
    { id: "review", label: "独立检查", actor: "检查 Agent", icon: UserCheck, state: liveReview ? "active" : needsRevision ? "blocked" : allAccepted ? "done" : hasOutput ? "active" : "waiting", note: liveReview ? progress?.summary || "正在检查当前任务" : needsRevision ? "发现需要修订的内容" : hasOutput && !allAccepted ? "正在等你检查结论" : allAccepted ? "检查结论已通过" : "等待验证完成", jobs: ["检查范围", "检查回归", "整理结论"] },
    { id: "human", label: "你的验收", actor: "你", icon: CheckCircle2, state: allAccepted ? "done" : hasOutput ? "active" : "waiting", note: allAccepted ? "任务内设计已全部通过" : hasOutput ? "请逐项通过或退回" : "暂时不需要操作", jobs: ["查看对照", "给出结论"] },
    { id: "integrate", label: "安全集成", actor: "集成 Agent", icon: GitMerge, state: allAccepted && run?.goal_id ? "done" : allAccepted ? "active" : "waiting", note: run?.goal_id ? "按正式 Goal 进入集成门禁" : "验收通过后才允许进入", jobs: ["完整回归", "进入基线"] }
  ] as Array<{ id: string; label: string; actor: string; icon: typeof Target; state: FlowState; note: string; jobs: string[] }>;

  const reportedStage = workerBlocked ? "worker" : liveTests ? "test" : liveReview ? "review" : liveWorker ? "worker" : undefined;
  const firstAttention = reportedStage ? raw.findIndex((step) => step.id === reportedStage) : raw.findIndex((step) => step.state === "active" || step.state === "blocked");
  return { steps: raw, currentIndex: firstAttention === -1 ? raw.length - 1 : firstAttention };
}

function relativeTime(value: string | undefined) {
  if (!value) return "尚无时间记录";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

export interface ExecutionSupervisionOverviewProps {
  task: SupervisionTask;
  details: SupervisionDetail[];
  selectedDetail?: SupervisionDetail;
  runs: SupervisionRun[];
  progress?: SupervisionProgress;
  companion?: CodexCompanionStatus;
  feedbackText: string;
  busy: boolean;
  onSelectDetail(id: string): void;
  onFeedbackText(value: string): void;
  onSendFeedback(): void;
  onOpenDetails(): void;
  onApproveCurrent(): void;
  onPause(run: SupervisionRun): void;
  onResume(run: SupervisionRun): void;
}

export function ExecutionSupervisionOverview(props: ExecutionSupervisionOverviewProps) {
  const [openPanel, setOpenPanel] = useState<"task" | "dialogue" | null>(null);
  const { task, details, selectedDetail, runs, progress, companion, feedbackText, busy } = props;
  const taskRuns = runs.filter((run) => details.some((detail) => detail.id === run.detail_id)).sort((left, right) => left.requested_at.localeCompare(right.requested_at));
  const latestRun = taskRuns.at(-1);
  const companionContext = companionTaskContext(companion, task.id);
  const taskReport = companionContext.progress;
  const { steps, currentIndex } = taskFlow(task, details, latestRun, companion);
  const current = steps[currentIndex];
  const taskProgress = progress?.byTask[task.id]?.progress ?? 0;
  const completedDetails = details.filter((detail) => detail.status === "accepted");
  const checkDetails = details.filter((detail) => detail.status === "reviewing" || detail.status === "needs_revision");
  const remainingDetails = details.filter((detail) => !["accepted", "reviewing", "needs_revision"].includes(detail.status));
  const blockedDetails = details.filter((detail) => detail.status === "needs_revision");
  const pendingFeedback = companion?.feedback.filter((item) => item.session_id === companionContext.session?.session_id && item.task_id === task.id && item.status === "pending") ?? [];
  const deliveredFeedback = companion?.feedback.filter((item) => item.session_id === companionContext.session?.session_id && item.task_id === task.id && item.status === "delivered").at(-1);
  const accepted = details.filter((detail) => detail.status === "accepted").length;
  const selectedMeta = selectedDetail ? categoryMeta[selectedDetail.category] : undefined;
  const canApprove = Boolean(selectedDetail?.output && selectedDetail.status === "reviewing");
  const canPause = latestRun?.status === "queued" || latestRun?.status === "running";
  const canResume = latestRun?.status === "stopped";

  return <div className="execution-overview" data-testid="execution-overview">
    <section className="execution-story" aria-label="动态执行流">
      <header className="execution-story-header">
        <div><span className="live-eyebrow"><i />实时执行故事</span><h2>{current.label}：{current.note}</h2><p>当前任务：{task.title} · 系统只突出现在需要关注的一步</p></div>
        <div className="execution-legend"><span><i className="legend-live" />正在运行</span><span><i className="legend-done" />已产出</span><span><i className="legend-waiting" />尚未开始</span><span><i className="legend-blocked" />等待处理</span></div>
      </header>
      <div className="execution-track-scroll"><div className="execution-track-canvas">
        <div className="execution-stage-track">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return <article className={`execution-stage stage-${step.state} ${index === currentIndex ? "is-current" : ""}`} key={step.id} data-state={step.state}>
              <div className="stage-marker">{step.state === "done" ? <Check size={14} /> : step.state === "blocked" ? <AlertTriangle size={14} /> : <Icon size={16} />}</div>
              <strong>{step.label}</strong><span>{step.actor}</span><small>{step.note}</small>
              {index < steps.length - 1 && <div className={`stage-link ${index < currentIndex ? "is-passed" : index === currentIndex ? "is-live" : ""}`}><i /></div>}
            </article>;
          })}
        </div>
        <section className={`task-progress-board progress-${current.state}`} aria-label="当前 Plan 任务进度">
          <header className="task-progress-head">
            <div><span>当前 Plan 任务</span><strong>{task.title}</strong><small>{current.label} · {current.note}</small></div>
            <b>{taskProgress}%</b>
          </header>
          <div className="task-progress-rail" role="progressbar" aria-label={`${task.title} 完成度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={taskProgress}>
            <i style={{ width: `${taskProgress}%` }} />
          </div>
          <div className="task-progress-columns">
            <section className="progress-column is-current">
              <header><i /><span>现在</span><b>{current.label}</b></header>
              <p>{taskReport?.summary || current.note}</p>
              <ul>{current.jobs.map((job) => <li key={job}>{job}</li>)}</ul>
            </section>
            <section className="progress-column is-done">
              <header><i /><span>已完成</span><b>{completedDetails.length}</b></header>
              <ul>{completedDetails.length ? completedDetails.map((detail) => <li key={detail.id}>{detail.title}</li>) : <li className="is-empty">尚无已验收项</li>}</ul>
            </section>
            <section className="progress-column is-review">
              <header><i /><span>待你检查</span><b>{checkDetails.length}</b></header>
              <ul>{checkDetails.length ? checkDetails.map((detail) => <li key={detail.id}>{detail.title}</li>) : <li className="is-empty">当前无需检查</li>}</ul>
            </section>
            <section className={`progress-column is-blocked ${blockedDetails.length ? "has-blocker" : ""}`}>
              <header><i /><span>阻塞</span><b>{blockedDetails.length}</b></header>
              <ul>{blockedDetails.length ? blockedDetails.map((detail) => <li key={detail.id}>{detail.title}</li>) : remainingDetails.length ? <li className="is-empty">{remainingDetails.length} 项尚未到达检查阶段</li> : <li className="is-empty">无阻塞</li>}</ul>
            </section>
          </div>
        </section>
      </div></div>
      <footer className="execution-story-footer"><span><Bot size={13} />系统状态来自 Codex 伴随会话、版本化任务、运行记录与验收证据</span><strong>{companionContext.canSendFeedback ? <>本任务会话已连接 · <time className="relative-time">{relativeTime(taskReport?.updated_at ?? companionContext.session?.last_seen_at)}</time></> : companion?.selection_required ? "请先绑定会话 · 当前展示已有任务证据" : companion?.connected ? "当前任务未关联所选会话" : "Codex 当前未连接 · 仍可审查已有回挂产出"}</strong></footer>
    </section>

    <section className="overview-command-dock">
      <div className="command-current"><span>当前需要你关注</span><strong>{current.label} · {current.note}</strong><small>{task.title} · 任务进度 {progress?.byTask[task.id]?.progress ?? 0}% · {accepted}/{details.length} 条人工通过</small></div>
      <div className="command-category-dots">{Object.entries(categoryMeta).map(([category, meta]) => {
        const items = details.filter((detail) => detail.category === category);
        const tone = !items.length ? "empty" : items.every((detail) => detail.status === "accepted") ? "done" : items.some((detail) => ["reviewing", "needs_revision"].includes(detail.status)) ? "attention" : "waiting";
        return <button key={category} className={`dot-${tone}`} disabled={!items.length} title={`${meta.label}：${!items.length ? "本任务无要求" : tone === "done" ? "已通过" : tone === "attention" ? "等待检查" : "等待执行"}`} onClick={() => { if (items[0]) props.onSelectDetail(items[0].id); setOpenPanel("task"); }}><i />{meta.label}</button>;
      })}</div>
      <div className="command-actions">
        {canPause && <button className="control-pause" disabled={busy} onClick={() => latestRun && props.onPause(latestRun)}><Pause size={14} />暂停</button>}
        {canResume && <button className="control-resume" disabled={busy} onClick={() => latestRun && props.onResume(latestRun)}><Play size={14} />继续</button>}
        <button onClick={() => setOpenPanel("task")}><Target size={14} />查看任务监督</button>
        <button onClick={() => setOpenPanel("dialogue")}><MessageSquareText size={14} />打开监督对话{pendingFeedback.length > 0 && <b>{pendingFeedback.length}</b>}</button>
        <button className="control-approve" disabled={busy || !canApprove} onClick={props.onApproveCurrent}><CheckCircle2 size={14} />通过当前产出</button>
      </div>
    </section>

    {openPanel && <div className="logic-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenPanel(null); }}>
      <section className={`logic-modal logic-modal-${openPanel}`} role="dialog" aria-modal="true" aria-label={openPanel === "task" ? "当前任务监督" : "独立监督对话"}>
        <button className="logic-modal-close" aria-label="关闭弹窗" onClick={() => setOpenPanel(null)}><X size={18} /></button>
        {openPanel === "task" ? <section className="task-watch-panel">
        <header><div><span>当前任务监督</span><h2>{task.title}</h2></div><button onClick={props.onOpenDetails}>调整设计与 Prompt</button></header>
        <p className="task-objective">{task.objective}</p>
        <div className="watch-list">{Object.entries(categoryMeta).map(([category, meta]) => {
          const items = details.filter((detail) => detail.category === category);
          const item = items[0];
          const done = items.filter((detail) => detail.status === "accepted").length;
          const hasAttention = items.some((detail) => ["reviewing", "needs_revision"].includes(detail.status));
          return <button key={category} disabled={!item} className={`${selectedDetail?.category === category ? "active" : ""} ${hasAttention ? "needs-attention" : ""}`} onClick={() => item && props.onSelectDetail(item.id)}>
            <span className="watch-category">{meta.label}<small>{meta.meaning}</small></span>
            <span className="watch-status">{!items.length ? "本任务无要求" : done === items.length ? "已通过" : hasAttention ? "等待检查" : "尚未开始"}<small>{items.length ? `${done}/${items.length} 条通过` : "不会派发"}</small></span>
            <span className="watch-evidence">{item?.output ? <><CheckCircle2 size={13} />已有产出</> : <><Circle size={13} />暂无产出</>}</span>
          </button>;
        })}</div>
        <footer><span>本任务进度 <b>{progress?.byTask[task.id]?.progress ?? 0}%</b></span><span>人工通过 <b>{accepted}/{details.length}</b></span><span>运行记录 <b>{taskRuns.length}</b></span></footer>
      </section> : <section className="supervisor-dialogue">
        <header><div><MessageSquareText size={17} /><span><strong>独立监督对话</strong><small>当前只针对：{task.title}</small></span></div><span className={`dialogue-connection ${companionContext.canSendFeedback ? "is-online" : ""}`}><i />{companionContext.canSendFeedback ? "本任务已关联" : "反馈暂不可用"}</span></header>
        <div className="dialogue-log">
          <article className="dialogue-agent"><span><Bot size={14} /></span><div><small>监督 Agent · {relativeTime(taskReport?.updated_at ?? latestRun?.finished_at ?? undefined)}</small><p>{taskReport?.summary || readableCodexEvent(latestRun?.events.at(-1)?.message, `“${task.title}”已有 ${details.filter((detail) => detail.output).length} 类产出回挂，当前最需要你处理的是：${current.note}。`)}</p></div></article>
          {deliveredFeedback && <article className="dialogue-human"><span>你</span><div><small>已送达 · {relativeTime(deliveredFeedback.delivered_at ?? deliveredFeedback.created_at)}</small><p>{deliveredFeedback.text}</p></div></article>}
          {pendingFeedback.map((feedback) => <article className="dialogue-human is-pending" key={feedback.id}><span>你</span><div><small>等待安全边界送达</small><p>{feedback.text}</p></div></article>)}
        </div>
        <section className="feedback-contract" data-testid="feedback-contract">
          <header><div><ShieldCheck size={14} /><strong>本次反馈边界</strong></div><span>{selectedMeta ? `${selectedMeta.label} · 局部修正` : "先选择一条设计"}</span></header>
          {selectedDetail ? <div className="feedback-contract-grid">
            <span><small>作用对象</small><strong>{selectedDetail.title}</strong></span>
            <span><small>允许影响</small><strong>{selectedDetail.prompt.allowed_changes.slice(0, 2).join("、") || "按当前设计范围"}</strong></span>
            <span><small>禁止影响</small><strong>{selectedDetail.prompt.forbidden_changes[0] || "不得跨类别修改"}</strong></span>
            <span><small>送达时机</small><strong>下一个安全回合边界</strong></span>
          </div> : <p>从左侧选择一条设计要求，反馈才会绑定到明确对象。</p>}
        </section>
        <p className="dialogue-scope-note" role="status">{companionContext.reason}</p>
        <div className="dialogue-composer"><textarea aria-label="独立监督反馈" value={feedbackText} onChange={(event) => props.onFeedbackText(event.target.value)} rows={3} placeholder={companionContext.canSendFeedback ? "例如：只把移动端图例改得更清楚，不要修改数据采集逻辑。" : companionContext.reason} disabled={busy || !companionContext.canSendFeedback} /><button disabled={busy || !companionContext.canSendFeedback || !feedbackText.trim()} onClick={props.onSendFeedback}><Send size={14} />发送局部反馈</button></div>
      </section>}
      </section>
    </div>}
  </div>;
}
