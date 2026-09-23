import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Bot, CheckCircle2, ExternalLink, ListTree, Play, RadioTower, RefreshCw, RotateCcw, Save, X, ZoomIn } from "lucide-react";
import type { CodexCompanionStatus, SupervisionDetail, SupervisionDocument, SupervisionProgress, SupervisionRun, SupervisionTask } from "../types.ts";
import { companionTaskContext } from "../companion.ts";

const categoryMeta = {
  function: { label: "功能", hint: "行为与结果" },
  visual: { label: "视觉", hint: "画面与层级" },
  interaction: { label: "交互", hint: "操作与反馈" },
  copy: { label: "文案", hint: "语言与理解" },
  asset: { label: "素材", hint: "来源与授权" }
} as const;

const statusLabels: Record<SupervisionDetail["status"], string> = {
  draft: "草拟中",
  ready: "等待 Agent",
  assigned: "执行中",
  reviewing: "等待检查",
  accepted: "已通过",
  needs_revision: "需要重做"
};

const checkLabels = { pass: "满足", partial: "部分满足", fail: "未满足", pending: "待验证" } as const;
const checkProgress = { pass: 100, partial: 50, fail: 0, pending: 0 } as const;

function splitLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

interface GuidedSupervisionDetailsProps {
  document: SupervisionDocument;
  tasks: SupervisionTask[];
  task: SupervisionTask;
  details: SupervisionDetail[];
  detail: SupervisionDetail;
  progress?: SupervisionProgress;
  companion?: CodexCompanionStatus;
  latestRun?: SupervisionRun;
  dirty: boolean;
  busy: boolean;
  message?: string;
  reviewNote: string;
  formalControls: ReactNode;
  onSelectTask: (id: string) => void;
  onSelectDetail: (id: string) => void;
  onUpdateDetail: (detail: SupervisionDetail) => void;
  onReviewNote: (value: string) => void;
  onSave: () => void;
  onDispatch: () => void;
  onReview: (verdict: "accepted" | "needs_revision") => void;
  onRefresh: () => void;
}

export function GuidedSupervisionDetails({
  document,
  tasks,
  task,
  details,
  detail,
  progress,
  companion,
  latestRun,
  dirty,
  busy,
  message,
  reviewNote,
  formalControls,
  onSelectTask,
  onSelectDetail,
  onUpdateDetail,
  onReviewNote,
  onSave,
  onDispatch,
  onReview,
  onRefresh
}: GuidedSupervisionDetailsProps) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [artifactPreviewOpen, setArtifactPreviewOpen] = useState(false);
  const companionContext = companionTaskContext(companion, task.id);
  const activeStep: number = detail.status === "accepted" ? 4 : detail.output ? 3 : 2;
  const nextAction = activeStep === 4
    ? "本分项已通过；选择下一项继续检查"
    : activeStep === 3
      ? "逐条对照 Plan 要求与 Codex 产出，然后通过或退回"
      : "选择需要监督的任务分项，等待 Codex 产出回挂";
  const acceptedCount = details.filter((item) => item.status === "accepted").length;
  const artifactIsImage = Boolean(detail.output?.artifact_ref && /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(detail.output.artifact_ref));
  const requirementRows = detail.acceptance.map((criterion, index) => {
    const check = detail.output?.checks.find((item) => item.criterion === criterion) ?? detail.output?.checks[index];
    const result = check?.result ?? "pending";
    return { criterion, check, result, progress: checkProgress[result] };
  });
  const completedRequirements = requirementRows.filter((item) => item.result === "pass").length;
  const evidenceProgress = requirementRows.length
    ? Math.round(requirementRows.reduce((total, item) => total + item.progress, 0) / requirementRows.length)
    : 0;

  useEffect(() => setArtifactPreviewOpen(false), [detail.id]);
  useEffect(() => {
    if (!artifactPreviewOpen) return;
    const previousOverflow = globalThis.document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArtifactPreviewOpen(false);
    };
    globalThis.document.body.style.overflow = "hidden";
    globalThis.addEventListener("keydown", closeOnEscape);
    return () => {
      globalThis.document.body.style.overflow = previousOverflow;
      globalThis.removeEventListener("keydown", closeOnEscape);
    };
  }, [artifactPreviewOpen]);

  const updatePrompt = (key: "allowed_changes" | "forbidden_changes", value: string) => {
    onUpdateDetail({
      ...detail,
      prompt: { ...detail.prompt, [key]: splitLines(value) }
    });
  };

  return <>
    <section className="supervision-onboarding" aria-label="操作顺序">
      <div className="next-operation"><span>现在请做</span><strong>{nextAction}</strong></div>
      <ol>
        {[
          ["选择任务", "来自 Codex Plan"],
          ["选择分项", "功能 / 视觉 / 交互 / 文案 / 素材"],
          ["对照产出", "Plan 要求 ↔ Codex 证据"],
          ["给出结论", "通过或退回；Prompt 按需修改"]
        ].map(([title, hint], index) => {
          const step = index + 1;
          return <li key={title} className={step === activeStep ? "is-current" : step < activeStep ? "is-done" : ""}>
            <span>{step < activeStep ? "✓" : step}</span><div><strong>{title}</strong><small>{hint}</small></div>
          </li>;
        })}
      </ol>
    </section>

    <section className={`guided-plan-board ${activeStep === 1 ? "is-current-step" : ""}`} data-testid="plan-task-board">
      <header>
        <div><ListTree size={15} /><strong>第 1 步 · Codex Plan 任务</strong><span>此处直接读取 Codex Plan，不在这里改写任务内容</span></div>
        <div className="plan-source-state">
          <span className={companionContext.canSendFeedback ? "is-live" : "is-waiting"}><RadioTower size={12} />{companionContext.canSendFeedback ? "本任务会话已连接" : companion?.selection_required ? "待选择会话" : companion?.connected ? "本任务未关联" : "等待 Codex 连接"}</span>
          <span>{document.plan.source === "codex-plan" ? "来源：Codex Plan" : `来源：${document.plan.source}`}</span>
          <b>{document.plan.version}</b>
          <button aria-label="刷新 Codex Plan" onClick={onRefresh}><RefreshCw size={12} />刷新</button>
        </div>
      </header>
      <div className="guided-task-list">{tasks.map((item) => {
        const itemDetails = document.details.filter((candidate) => candidate.task_id === item.id);
        const itemAccepted = itemDetails.filter((candidate) => candidate.status === "accepted").length;
        return <button key={item.id} className={item.id === task.id ? "active" : ""} onClick={() => onSelectTask(item.id)}>
          <span>{item.order + 1}</span><div><strong>{item.title}</strong><small>{item.objective}</small></div><em>{itemAccepted}/{itemDetails.length} 已通过</em>
        </button>;
      })}</div>
    </section>

    <div className="guided-supervision-columns">
      <aside className={`guided-detail-tree ${activeStep === 2 ? "is-current-step" : ""}`} aria-label="任务分项">
        <div className="guided-column-title"><div><span>第 2 步</span><strong>选择任务分项</strong></div><small>{acceptedCount}/{details.length} 已通过</small></div>
        <div className="task-readonly-summary"><strong>{task.title}</strong><p>{task.objective}</p><span>内容由 {document.plan.version} 提供，只读</span></div>
        {Object.entries(categoryMeta).map(([category, meta]) => {
          const items = details.filter((item) => item.category === category);
          if (!items.length) return null;
          return <section className="guided-category" key={category}>
            <header><strong>{meta.label}</strong><span>{meta.hint}</span></header>
            {items.map((item) => <button key={item.id} className={item.id === detail.id ? "active" : ""} onClick={() => onSelectDetail(item.id)}>
              <span>{item.title}</span><small className={`status-${item.status}`}>{statusLabels[item.status]}</small>
            </button>)}
          </section>;
        })}
      </aside>

      <main className={`guided-output-panel ${activeStep === 3 ? "is-current-step" : ""}`} aria-label="Plan 与 Agent 产出对照">
        <div className="guided-column-title"><div><span>主工作区</span><strong>逐条对照 Plan 与 Codex 产出</strong></div><small>{detail.output ? `${completedRequirements}/${requirementRows.length} 条已有满足证据` : "等待产出"}</small></div>
        <section className={`guided-prompt-disclosure ${promptOpen ? "is-open" : ""}`}>
          <div><span>可选修正</span><strong>只有发现偏差时，才需要调整本分项 Prompt</strong><small>{dirty ? "有未保存修改" : `${detail.prompt.version} · 当前已保存`}</small></div>
          <button type="button" aria-expanded={promptOpen} onClick={() => setPromptOpen((open) => !open)}>{promptOpen ? "收起 Prompt" : "需要修改时打开 Prompt"}</button>
          {promptOpen && <div className="guided-prompt-drawer" data-testid="prompt-only-editor">
            <section className="readonly-design-brief">
              <header><span>{categoryMeta[detail.category].label} · {detail.version}</span><strong>{detail.title}</strong></header>
              <p>{detail.intent}</p>
            </section>
            <section className="prompt-only-editor">
              <header><div><span>局部修正工具</span><strong>只告诉 Agent 要强化什么、绝不能改什么</strong></div><b>{detail.prompt.version}</b></header>
              <div className="prompt-pair">
                <label className="positive-prompt">Positive Prompt · 正向要求
                  <small>希望新增、强化或保持的结果。</small>
                  <textarea aria-label="Positive Prompt" rows={5} value={detail.prompt.allowed_changes.join("\n")} onChange={(event) => updatePrompt("allowed_changes", event.target.value)} placeholder="例如：突出当前任务状态；保持中文标题清晰可读" />
                </label>
                <label className="negative-prompt">Negative Prompt · 负向要求
                  <small>本次禁止碰触或必须避免的内容。</small>
                  <textarea aria-label="Negative Prompt" rows={5} value={detail.prompt.forbidden_changes.join("\n")} onChange={(event) => updatePrompt("forbidden_changes", event.target.value)} placeholder="例如：不要改变业务逻辑；不要新增无关卡片" />
                </label>
              </div>
            </section>
            <details className="readonly-context">
              <summary>查看 Codex 原始要求与工程边界（只读）</summary>
              <dl>
                <div><dt>通用要求</dt><dd>{detail.prompt.base || "未提供"}</dd></div>
                <div><dt>本分项要求</dt><dd>{detail.prompt.local || "未提供"}</dd></div>
                <div><dt>参考素材</dt><dd>{detail.prompt.resources.length ? detail.prompt.resources.join("；") : "未提供"}</dd></div>
                <div><dt>允许写入</dt><dd>{detail.execution?.write_globs.join("；") || "未编译"}</dd></div>
                <div><dt>验收命令</dt><dd>{detail.execution?.acceptance_commands.join("；") || "未编译"}</dd></div>
              </dl>
            </details>
            <footer className="guided-save-bar"><span>{message || (dirty ? "Prompt 有未保存修改；Agent 尚未收到。" : "当前 Prompt 已保存。")}</span><button disabled={busy || !dirty} onClick={onSave}><Save size={14} />{busy ? "保存中…" : "保存 Prompt 版本"}</button></footer>
          </div>}
        </section>
        <div className="guided-output-scroll">
          {detail.output ? <>
            <div className={`guided-source-badge source-${detail.output.source}`}><Bot size={14} />{detail.output.source === "mock" ? "Mock 演练 · 不算正式证据" : detail.output.agent_label}</div>
            {latestRun && <p className="guided-run-line">第 {latestRun.attempt} 次运行 · {latestRun.mode === "external" ? "真实 Agent 回执" : latestRun.goal_id ? "正式 Goal 链路" : "Mock 演练"}</p>}
            <section className="human-comparison" data-testid={`comparison-mode-${detail.output.artifact_kind}`}>
              <article><span>你要求的设计</span><strong>{detail.title}</strong><p>{detail.intent}</p><small>正向：{detail.prompt.allowed_changes.join("；") || "未补充"}</small><small>负向：{detail.prompt.forbidden_changes.join("；") || "未补充"}</small></article>
              <article><span>Agent 当前回执</span><strong>{completedRequirements}/{requirementRows.length} 条 Plan 要求已有满足证据</strong><p>下面按设计线逐条列出完成情况；总说明只作为辅助，不再代替验收。</p>{artifactIsImage && <button className="artifact-preview-trigger" type="button" aria-label={`放大查看${detail.title}产出截图`} onClick={() => setArtifactPreviewOpen(true)}><img src={detail.output.artifact_ref} alt={`${detail.title} Agent 产出`} loading="eager" fetchPriority="high" /><span><ZoomIn size={13} />点击放大查看原图</span></button>}{detail.output.artifact_ref && !artifactIsImage && <a href={detail.output.artifact_ref} target="_blank" rel="noreferrer">打开可检查产出 <ExternalLink size={12} /></a>}</article>
            </section>
            <details className="agent-summary-disclosure"><summary>查看 Agent 总结原文（辅助信息）</summary><p>{detail.output.summary}</p></details>
            <section className="plan-completion-matrix" aria-label="Plan 细分完成度" data-testid="plan-completion-matrix">
              <header>
                <div><span>按设计线逐条检查</span><strong>{completedRequirements}/{requirementRows.length} 条已经满足</strong><small>完成度由验收证据计算，不采用 Agent 自报百分比</small></div>
                <div className="plan-evidence-score"><b>{evidenceProgress}%</b><span>证据完成度</span></div>
              </header>
              <ol>{requirementRows.map((row, index) => <li className={`requirement-${row.result}`} key={`${row.criterion}-${index}`}>
                <details open>
                  <summary>
                    <span className="requirement-index">{String(index + 1).padStart(2, "0")}</span>
                    <div><small>Plan 设计要求</small><strong>{row.criterion}</strong></div>
                    <span className="requirement-state"><b>{row.progress}%</b><em>{checkLabels[row.result]}</em></span>
                  </summary>
                  <div className="requirement-evidence">
                    <article><small>{row.result === "pass" ? "Agent 已完成部分" : row.result === "partial" ? "Agent 当前完成与缺口" : "当前证据"}</small><p>{row.check?.note || "尚未收到能证明本条要求完成的证据。"}</p></article>
                    <article><small>你需要怎样检查</small><p>{row.result === "pass" ? "确认右侧产出和这条完成说明确实满足左侧设计要求；不符合时退回本分项并注明本条。" : row.result === "partial" ? "核对已经完成的范围，并在检查意见中指出仍需补齐的部分。" : "本条尚不能通过；等待补充产出或证据后再检查。"}</p></article>
                  </div>
                </details>
              </li>)}</ol>
            </section>
          </> : <section className="guided-output-empty"><Bot size={28} /><h2>还没有 Agent 产出</h2><p>先完成第 3 步并保存 Prompt。之后可等待 Codex 正式执行，或在下方高级操作中运行 Mock 演练。</p><span>{categoryMeta[detail.category].label} · {statusLabels[detail.status]}</span></section>}

          <details className="advanced-execution">
            <summary>执行与高级操作</summary>
            <button className="mock-dispatch" disabled={busy || dirty} onClick={onDispatch}><Play size={13} />{dirty ? "先保存 Prompt" : "运行 Mock 演练"}</button>
            {formalControls}
          </details>
        </div>
        {detail.output && <footer className="guided-review-bar">
          <label>检查意见（退回时说明哪里不符合）<textarea rows={3} value={reviewNote} onChange={(event) => onReviewNote(event.target.value)} placeholder="例如：视觉层级仍不清楚，只重做视觉，不要改功能逻辑。" /></label>
          <div><button className="revise" disabled={busy} onClick={() => onReview("needs_revision")}><RotateCcw size={14} />退回本分项</button><button className="accept" disabled={busy} onClick={() => onReview("accepted")}><CheckCircle2 size={14} />通过本分项</button></div>
        </footer>}
        {artifactPreviewOpen && artifactIsImage && detail.output?.artifact_ref && <div className="artifact-lightbox" role="dialog" aria-modal="true" aria-label={`${detail.title}产出截图放大预览`} onMouseDown={(event) => { if (event.target === event.currentTarget) setArtifactPreviewOpen(false); }}>
          <section>
            <header><div><span>Agent 产出证据</span><strong>{detail.title}</strong></div><button type="button" autoFocus aria-label="关闭截图预览" onClick={() => setArtifactPreviewOpen(false)}><X size={18} /></button></header>
            <div className="artifact-lightbox-canvas"><img src={detail.output.artifact_ref} alt={`${detail.title} 放大预览`} /></div>
            <footer>可滚动查看完整原图 · 点击背景或按 Esc 关闭</footer>
          </section>
        </div>}
      </main>
    </div>
  </>;
}
