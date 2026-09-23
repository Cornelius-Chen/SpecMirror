import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, ClipboardList, FileCheck2, GitBranch, ShieldCheck } from "lucide-react";
import { kindNames } from "../engineering/shared.ts";
import { engineeringNodeName } from "../engineering/node-names.ts";
import { projectNodeInspector, type InspectorStage } from "./inspector-selectors.ts";
import { projectProcessMotion } from "./process-motion.ts";
import { projectDeliverySummary } from "./delivery-selectors.ts";
import { durationLabel, projectRunPerformance, tokenLabel } from "./run-performance.ts";
import { CompositionSummary } from "./CompositionSummary.tsx";
import { NodeRelationsPanel } from "./NodeRelationsPanel.tsx";
import { NodeResultPanel } from "./NodeResultPanel.tsx";
import { hasRecordedReview } from "./node-result-state.ts";
import type { ProjectNodeInspectorProps } from "./types.ts";
import "./inspector.css";
import "./governance-panels.css";

const stageLabels = { done: "已有记录", current: "当前环节", waiting: "尚待完成", attention: "需要处理", unconfigured: "未配置" };
const stageIcons = { plan: ClipboardList, handoff: ArrowRight, execution: ArrowRight, checks: FileCheck2, children: GitBranch, integration: ShieldCheck, review: Check };

/** A read-only account of the selected node. All editing and review stays in the original editor. */
export function ProjectNodeInspector(props: ProjectNodeInspectorProps) {
  // A keyed body also prevents expanded details from following the user to a different node.
  return <InspectorBody key={JSON.stringify([props.api?.workspaceId ?? "host", props.nodeId])} {...props} />;
}

function InspectorBody({ api, view, nodeId, nodeNames, labels = [], onRename, onOpenDetail, onNavigateNode, onFeedback, observationUnavailable }: ProjectNodeInspectorProps) {
  const model = useMemo(() => {
    const saved = projectNodeInspector(view, nodeId); if (!saved) return saved;
    const reviewed = (id: string) => { const run = view.document.runs.find(item => item.id === view.derived[id]?.latest_run_id && item.node_id === id); return run?.status === "accepted" && hasRecordedReview(run); };
    const children = saved.children.map(child => ({ ...child, accepted: child.accepted && reviewed(child.node.id),
      status: child.accepted && !reviewed(child.node.id) ? "验收记录待核对" : child.status,
      leafAccepted: view.document.nodes.filter(node => (node.id === child.node.id || view.derived[node.id]?.path.includes(child.node.id))
        && !view.document.nodes.some(item => item.parent_id === node.id && item.status !== "archived") && reviewed(node.id)).length }));
    const result = { ...saved, children, acceptedChildren: children.filter(child => child.accepted).length };
    if (result.acceptedChildren !== saved.acceptedChildren) {
      result.stages = result.stages.map(stage => stage.id === "children" ? { ...stage, tone: "attention", note: `${result.acceptedChildren} / ${children.length} 个直属子项具有有效人工复核记录；其余需核对。` }
        : stage.id === "integration" && !saved.currentRun ? { ...stage, tone: "waiting", note: "先核对子项的人工复核记录，再进行本层整合。" } : stage);
      if (!saved.currentRun) { result.summary = "部分子项的人工复核记录待核对，本层仍需独立整合与验收。"; result.next = { label: "核对子项验收记录", tab: "reading" }; }
    }
    if (saved.currentRun?.status !== "accepted" || hasRecordedReview(saved.currentRun)) return result;
    return { ...result, status: "验收记录待核对", summary: "原运行标记为 accepted，但缺少有效人工复核时间。", next: { label: "核对验收记录", tab: "runs" as const },
      blockers: [...result.blockers, "缺少有效人工复核记录。"], stages: result.stages.map(stage => stage.id === "review"
        ? { ...stage, tone: "attention" as const, note: "验收记录待核对，不能据此认定已通过人工验收。" } : stage) };
  }, [view, nodeId]);
  const motion = useMemo(() => {
    if (!model) return null;
    const result = projectProcessMotion(view, nodeId, model);
    if (model.currentRun?.status === "accepted" && !hasRecordedReview(model.currentRun)) return { ...result, state: "blocked" as const, label: "验收记录待核对。" };
    if (!model.currentRun && model.isParent && model.children.some(child => view.derived[child.node.id]?.status === "accepted" && !child.accepted)) return { ...result, state: "waiting" as const, label: "部分子项的人工复核记录待核对。" };
    return observationUnavailable && result.state === "running" ? { ...result, state: "waiting" as const, label: "状态待更新；当前显示上次记录，暂不推断正在执行。" } : result;
  }, [view, nodeId, model, observationUnavailable]);
  const delivery = useMemo(() => projectDeliverySummary(view, nodeId), [view, nodeId]);
  const performance = useMemo(() => projectRunPerformance(view, nodeId), [view, nodeId]);
  const nodes = useMemo(() => new Map(view.document.nodes.map(node => [node.id, node])), [view]);
  const [expanded, setExpanded] = useState(false);
  const [reviewsExpanded, setReviewsExpanded] = useState(false);
  const [processExpanded, setProcessExpanded] = useState(false);
  const processElement = useRef<HTMLElement>(null);
  useEffect(() => { if (processExpanded) processElement.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); }, [processExpanded]);
  if (!model || !motion) return <section className="project-node-inspector pni-empty" aria-label="选中任务详情"><p>这项任务已不在当前工程中。请从地图选择其他任务。</p></section>;
  const { node, currentRun: run, evidence } = model;
  const nodeName = (id: string, fallback: string) => { const item = nodes.get(id); return item ? engineeringNodeName(item, nodeNames) : fallback; };
  const runningBranches = model.running.filter(item => motion.runningNodeIds?.includes(item.nodeId));
  const owner = node.owner.startsWith("codex:") ? "已分配 Codex 负责人" : node.owner || "未分配";
  const firstBlocker = model.blockers[0];
  const decision = run?.status === "review" || model.next.action === "review_list" ? "需要你验收" : run?.status === "rejected" ? "需要修订后再验收" : model.historicalOnly ? "当前版本需要重新核对" : node.status === "archived" ? "已归档，可查阅记录" : model.status === "已验收" ? "已有验收结论" : "接下来";
  const outputs = !model.isParent && (evidence.artifacts || evidence.sourceChanges) ? [evidence.artifacts ? `${evidence.artifacts} 份有文件记录的成果` : "", evidence.sourceChanges ? `${evidence.sourceChanges} 项源文件变更记录` : ""].filter(Boolean).join(" · ") : "";
  const accepted = model.status === "已验收";
  const flow = (stage: InspectorStage, index: number) => {
    const Icon = stageIcons[stage.id];
    const isCurrent = motion.stageId === stage.id, live = isCurrent && motion.state === "running";
    const legacyTone = isCurrent && motion.state !== "complete" ? motion.state === "blocked" ? "blocked" : "active" : stage.tone === "attention" ? "blocked" : stage.tone === "done" ? "done" : "waiting";
    const stateLabel = live ? "正在进行" : isCurrent && motion.state === "waiting" ? "当前等待" : stage.tone === "current" && !isCurrent ? "尚待完成" : stageLabels[stage.tone];
    return <li key={stage.id} className={`execution-stage stage-${legacyTone} pni-stage pni-stage-${stage.tone} ${live ? "is-current" : ""}`} data-stage={stage.id} data-tone={stage.tone} data-current={String(isCurrent)} data-live={String(live)}>
      <button type="button" onClick={() => onOpenDetail(nodeId, stage.tab)}>
        <span className="stage-marker" aria-hidden="true"><Icon size={14} /></span>
        <span className="pni-stage-text"><strong>{stage.title}</strong><span className="pni-stage-state">{stateLabel}</span></span>
      </button><p>{stage.id === "children" ? `${model.acceptedChildren} / ${model.children.length} 个直属子项已验收${runningBranches.length ? `；${runningBranches.length} 项下级正在执行` : ""}。` : stage.note}</p>
      {index < model.stages.length - 1 && <div className={`stage-link ${live ? "is-live" : stage.tone === "done" ? "is-passed" : ""}`} aria-hidden="true">{live && <i className="pni-flow-dot" />}</div>}
    </li>;
  };
  return <section className="project-node-inspector task-progress-board" aria-label="选中任务详情" data-node-id={nodeId}>
    <header className="task-progress-head pni-header">
      <div className="pni-heading"><p className="pni-eyebrow">{kindNames[node.kind]} · 当前结果</p><h2 title={node.title}>{engineeringNodeName(node, nodeNames)}</h2></div>
      {onRename && <button type="button" className="pni-rename" onClick={onRename}>修改名称</button>}
    </header>
    <div className="pni-outcome"><h3>要交付什么</h3><p>{node.objective || "还没有写明本项要交付的结果。"}</p></div>
    {api && <NodeResultPanel api={api} view={view} nodeId={nodeId} />}
    {performance.runCount > 0 && <section className="pni-value-strip" aria-label="真实执行量测" title={performance.measuredTokenRuns ? `Token 来自 ${performance.measuredTokenRuns} 项已分配 Codex 任务的本机执行窗口；计划投影不计入执行。` : "这里只计算已领取并实际开始的 Agent 任务；当前没有可归属的 Token 记录。"}>
      <span><small>Agent 任务</small><strong>{performance.runCount} 项{performance.runningCount ? ` · ${performance.runningCount} 项进行中` : ""}</strong></span>
      <span><small>Agent 用时</small><strong>{durationLabel(performance.agentMs)}</strong></span>
      {performance.peakParallel > 1 && <span><small>并行重叠</small><strong>{durationLabel(performance.overlapMs)} · 峰值 {performance.peakParallel}</strong></span>}
      {performance.measuredTokenRuns > 0 && <span><small>{performance.tokenState === "final" ? "实测 Token" : "已观测 Token"}</small><strong>{tokenLabel(performance.totalTokens)}</strong></span>}
    </section>}
    <CompositionSummary view={view} nodeId={nodeId} nodeNames={nodeNames} onEdit={() => onOpenDetail(nodeId, "plan", "composition")} onNavigate={onNavigateNode} />
    <NodeRelationsPanel view={view} nodeId={nodeId} nodeNames={nodeNames} onEdit={(id, field) => onOpenDetail(id, "plan", field)} onFeedback={onFeedback} onNavigate={onNavigateNode} />
    {delivery && <section className="pni-delivery" aria-label="本项交付约定" data-contract-complete={String(delivery.contractComplete)}>
      <header><h3>本项交付约定</h3><span>{delivery.contractComplete ? "约定已补齐" : "待补充"}</span><button type="button" onClick={() => onOpenDetail(nodeId, "plan")}>修改交付约定</button></header>
      <p className="pni-helper">{delivery.contractComplete ? "边界、成果与完成条件已说明；是否完成仍以实际验收为准。" : "写清负责范围、输入来源、交付成果与完成条件，才能约束本项工作。"}</p>
      <details className="pni-contract-details"><summary>展开范围、成果与完成条件</summary><div className="pni-delivery-grid">
        <section aria-label="负责范围"><h3>负责什么</h3>{node.delivery?.included.length ? <ul>{node.delivery.included.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="pni-helper">负责范围待补充。</p>}<h3>不做什么</h3>{node.delivery?.excluded.length ? <ul>{node.delivery.excluded.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="pni-helper">{node.delivery?.no_extra_exclusions ? "没有额外排除项，沿用上级边界。" : "不承担的范围待说明。"}</p>}</section>
        <section aria-label="输入来源"><h3>需要什么</h3>{delivery.inputs.length ? <ul>{delivery.inputs.map(input => <li key={input.id}><strong>{input.title || "未命名输入"}</strong>{input.sourceNodeId ? <button type="button" onClick={() => onNavigateNode(input.sourceNodeId!)}>{nodeName(input.sourceNodeId, input.sourceTitle)}{input.outputTitle ? ` · ${input.outputTitle}` : ""}</button> : <p className="pni-helper">{input.externalSource ? `外部来源：${input.externalSource}` : "来源待补充"}</p>}{input.problem && <p className="pni-delivery-issue">{input.problem}</p>}</li>)}</ul> : <p className="pni-helper">{delivery.configured ? "本项未声明输入。" : "输入与来源待说明。"}</p>}{delivery.declaredDependencies.map(id => <p key={id} className="pni-helper">前置：<button type="button" disabled={!nodes.has(id)} onClick={() => onNavigateNode(id)}>{nodeName(id, "来源已不存在")}</button>，交接成果待说明。</p>)}</section>
        <section className="pni-output-contract" aria-label="成果与完成条件"><h3>交付什么 · 怎样算完成</h3>{delivery.outputs.length ? <ul>{delivery.outputs.map(output => <li key={output.id}><strong>{output.title || "未命名成果"}</strong>{output.criteria.length ? <ul>{output.criteria.map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul> : <p className="pni-delivery-issue">完成条件待关联。</p>}{output.missingCriteria.length > 0 && <p className="pni-delivery-issue">有 {output.missingCriteria.length} 条关联条件已不存在。</p>}</li>)}</ul> : <p className="pni-helper">可独立交付的成果待说明。</p>}
          {node.criteria.some(criterion => !delivery.outputs.some(output => output.criteria.some(item => item.id === criterion.id))) && <div className="pni-additional-criteria"><h4>{delivery.outputs.length ? "本项还需满足" : "已有完成条件"}</h4><ul>{node.criteria.filter(criterion => !delivery.outputs.some(output => output.criteria.some(item => item.id === criterion.id))).map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul></div>}
          {node.criteria.length === 0 && <p className="pni-delivery-issue">完成条件待补充。</p>}
        </section>
      </div>
      {delivery.parentContribution && <section className="pni-parent-contribution" aria-label="对上级的作用"><h3>对上级有什么用</h3><button type="button" onClick={() => onNavigateNode(delivery.parentContribution!.nodeId)}>{nodeName(delivery.parentContribution.nodeId, delivery.parentContribution.title)}</button>{delivery.parentContribution.criteria.length ? <ul>{delivery.parentContribution.criteria.map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul> : <p className="pni-helper">本项支撑哪些上级完成条件，尚待关联。</p>}{delivery.parentContribution.missingCriteria.length > 0 && <p className="pni-delivery-issue">有关联的上级条件已失效。</p>}<p className="pni-helper">本项通过后，上级仍需单独整体验收。</p></section>}
      </details>
      {delivery.issues.length > 0 && <details className="pni-delivery-issues"><summary>交付约定缺项（{delivery.issues.length}）</summary><ul>{delivery.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
    </section>}
    {run && view.observation && <p className="pni-observation" role="status">{view.observation.runs[run.id]?.message || "当前运行的实际活动尚未确认。"}{view.observation.runs[run.id]?.last_observed_at ? ` 最后观察：${new Date(view.observation.runs[run.id].last_observed_at!).toLocaleString("zh-CN")}` : " 尚无对应观察时间。"}</p>}
    {api && <p className="pni-helper">下方为已保存的运行与验收记录；文件当前是否有效，以本次成果核对为准。</p>}
    <div className="task-progress-columns">
      <section className="progress-column is-current" aria-label="现在"><header><i aria-hidden="true" /><h3>现在</h3><b className="pni-status">{model.status}</b></header><p className="pni-summary">{model.summary}</p>{outputs && <p className="pni-output-count">{outputs}</p>}</section>
      <section className="progress-column is-done" aria-label="已验收"><header><i aria-hidden="true" /><h3>已验收</h3></header><p className="pni-accepted-count">{model.isParent ? `本层直属已验收 ${model.acceptedChildren} / ${model.children.length} 项` : accepted ? "本项已通过人工验收" : "本项尚未验收"}</p>{model.isParent && <p className="pni-helper">{accepted ? "本层已独立通过人工验收。" : "本层尚未验收；子项通过不替代本层验收。"}</p>}</section>
      <section className="progress-column is-review" aria-label="待你检查"><header><i aria-hidden="true" /><h3>待你检查</h3><b>{(run?.status === "review" ? 1 : 0) + model.descendantReviews.length}</b></header>{run?.status === "review" && <p>本项结果待你验收。</p>}{model.descendantReviews.length > 0 && <p className="pni-result-count">下级 {model.descendantReviews.length} 项待验收</p>}{run?.status !== "review" && !model.descendantReviews.length && <p className="pni-helper">当前没有待验收结果。</p>}</section>
      <section className={`progress-column is-blocked ${firstBlocker ? "has-blocker" : ""}`} aria-label="卡点"><header><i aria-hidden="true" /><h3>卡点</h3><b>{model.blockers.length}</b></header>{firstBlocker ? <div className="pni-blocker"><p>{firstBlocker}</p>{model.blockers.length > 1 && <p className="pni-helper">另有 {model.blockers.length - 1} 项条件，可展开查看。</p>}</div> : <p className="pni-helper">当前没有已知卡点。</p>}</section>
    </div>
    <div className="pni-next"><div><span>{decision}</span><p>负责人：{owner}</p></div><div className="pni-command-actions"><button type="button" className="pni-primary" aria-expanded={model.next.action === "review_list" ? reviewsExpanded : undefined} aria-controls={model.next.action === "review_list" ? `pni-reviews-${nodeId}` : undefined} onClick={() => model.next.action === "review_list" ? setReviewsExpanded(value => !value) : onOpenDetail(nodeId, model.next.tab)}>{model.next.label}<ArrowRight size={14} aria-hidden="true" /></button><button type="button" className="pni-disclosure pni-process-toggle" aria-expanded={processExpanded} aria-controls={`pni-process-${nodeId}`} onClick={() => setProcessExpanded(value => !value)}><ChevronDown size={14} aria-hidden="true" />{processExpanded ? "收起执行过程" : "展开执行过程"}</button><button type="button" className="pni-disclosure" aria-expanded={expanded} aria-controls={`pni-detail-${nodeId}`} onClick={() => setExpanded(value => !value)}><ChevronDown size={14} aria-hidden="true" />{expanded ? "收起方案与依据" : "查看方案与依据"}</button></div></div>
    {processExpanded && <section ref={processElement} className={`pni-process is-${motion.state}`} id={`pni-process-${nodeId}`} aria-label="本项真实过程" data-motion-state={motion.state}>
      <header className="pni-process-heading"><h3>{model.isParent ? "分支推进后，独立整合与验收" : "从方案到本次验收"}</h3><span className="pni-process-status" role="status"><i aria-hidden="true" />{motion.label}</span></header>
      <ol>{model.stages.map(flow)}</ol>
      {motion.state === "running" && motion.stageId === "children" && runningBranches.length > 0 && <div className="pni-running-branches" aria-label="正在执行的下级"><span>{runningBranches.length} 项下级正在执行</span>{runningBranches.map(item => <button type="button" key={item.nodeId} title={item.title} onClick={() => onNavigateNode(item.nodeId)}>{nodeName(item.nodeId, item.title)}<ArrowRight size={12} aria-hidden="true" /></button>)}</div>}
      <p className="pni-process-note">正在执行的环节会动起来，等待或完成后停下。点击环节可查看依据。</p>
    </section>}
    {reviewsExpanded && model.descendantReviews.length > 0 && <section className="pni-review-list" id={`pni-reviews-${nodeId}`} aria-label="待验收结果"><h3>下级 {model.descendantReviews.length} 项待验收</h3><ul>{model.descendantReviews.map(item => <li key={item.node.id} data-review-node-id={item.node.id}><strong title={item.node.title}>{engineeringNodeName(item.node, nodeNames)}</strong><button type="button" title={item.node.title} aria-label={`查看并验收 ${engineeringNodeName(item.node, nodeNames)}`} onClick={() => onOpenDetail(item.node.id, "runs")}>查看证据并验收<ArrowRight size={14} aria-hidden="true" /></button></li>)}</ul></section>}
    {expanded && <div className="pni-details" id={`pni-detail-${nodeId}`}>
      <nav className="pni-path" aria-label="当前任务层级">{model.path.map((item, index) => <span key={item.id}>{index > 0 && <span aria-hidden="true"> / </span>}<button type="button" title={item.title} disabled={item.id === nodeId} onClick={() => onNavigateNode(item.id)}>{nodeName(item.id, item.title)}</button></span>)}</nav>
      {labels.length > 0 && <div className="pni-labels" aria-label="内容标签">{labels.map(label => <span key={label}>{label}</span>)}</div>}
      {model.isParent && <section className="pni-children" aria-label="直属子项进展"><h3>直属子项</h3><p className="pni-helper">各分支分别推进；子项验收不能替代本层整体验收。</p><ul>{model.children.map(child => <li key={child.node.id} data-child-id={child.node.id}><button type="button" title={child.node.title} onClick={() => onNavigateNode(child.node.id)}><strong>{engineeringNodeName(child.node, nodeNames)}</strong><span>{child.status}{child.running.length ? ` · 下级 ${child.running.length} 项执行中` : ""}</span></button>{child.leafTotal > 1 && <p>下级末级任务已验收 {child.leafAccepted} / {child.leafTotal} 项</p>}</li>)}</ul></section>}
      <div className="pni-detail-grid">
        <section><h3>做法与已选能力</h3><p>{node.method || "具体做法尚待补充。"}</p>{node.capabilities.length ? <ul>{node.capabilities.map(capability => <li key={capability.id}>{capability.purpose}</li>)}</ul> : <p className="pni-helper">本层没有选定能力。</p>}<button type="button" onClick={() => onOpenDetail(nodeId, "capabilities")}>查看能力选择</button></section>
        <section><h3>约束边界</h3>{node.constraints.rules.length ? <ul>{node.constraints.rules.map((rule, index) => <li key={index}>{rule}</li>)}</ul> : <p>本层没有额外文字约束。</p>}<p className="pni-helper">另继承 {model.inheritedRules.length} 条上级约束；允许与禁止范围在完整方案中核对。</p><button type="button" onClick={() => onOpenDetail(nodeId, "bounds")}>查看完整约束</button></section>
        <section><h3>验收条件</h3>{node.criteria.length ? <ul>{node.criteria.map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul> : <p>验收条件尚待补充。</p>}<button type="button" onClick={() => onOpenDetail(nodeId, "criteria")}>核对验收条件</button></section>
        <section><h3>本次依据</h3><p>{run ? `当前第 ${model.attempt} 次运行，冻结方案第 ${run.snapshot.node.revision} 版。` : "当前方案没有有效运行。"}</p><p>{evidence.hasAutomatic ? `实际检查通过记录 ${evidence.checksPassed} / ${evidence.checksTotal} 项。` : "未配置自动检查。"}人工核对通过记录 {evidence.manualPassed} / {evidence.manualTotal} 项。</p><p className="pni-helper">已有 {model.historyCount} 次历史运行。历史证据不替代当前版本的验收。</p><button type="button" onClick={() => onOpenDetail(nodeId, "history")}>查看变更与历史</button></section>
      </div>
      {model.blockers.length > 1 && <section className="pni-all-blockers"><h3>尚需满足的条件</h3><ul>{model.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></section>}
      <div className="pni-detail-actions"><button type="button" onClick={() => onOpenDetail(nodeId, "reading")}>阅读完整方案</button><button type="button" onClick={() => onOpenDetail(nodeId, "plan")}>修改方案</button><button type="button" onClick={() => onOpenDetail(nodeId, "runs")}>运行与验收</button></div>
    </div>}
  </section>;
}
