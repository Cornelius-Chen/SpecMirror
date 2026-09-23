import { useMemo, useState } from "react";
import type { EngineeringView } from "@epm/domain";
import { AcceptanceMatrix } from "./AcceptanceMatrix.tsx";
import { LocalDependencyMap } from "./LocalDependencyMap.tsx";
import { currentReadingPhase, nodeReadState, overviewIndex, readingIssues, subtreeNodes, subtreeProgress, OVERVIEW_LIST_PAGE } from "./overview-selectors.ts";
import { nodeStatusLabel } from "./shared.ts";
import "./overview.css";

export interface EngineeringOverviewProps { view: EngineeringView; currentPhaseId?: string | null; onSelectPhase: (id: string | null) => void; onNavigate: (nodeId: string, tab?: string) => void }
export function EngineeringOverview({ view, currentPhaseId, onSelectPhase, onNavigate }: EngineeringOverviewProps) {
  const index = useMemo(() => overviewIndex(view), [view]), selection = useMemo(() => currentReadingPhase(index, currentPhaseId), [index, currentPhaseId]);
  const { phases, phase, suggested } = selection, root = index.nodes.get(view.document.root_id);
  const [mode, setMode] = useState<"graph" | "list" | "matrix">("graph"), [goalExpanded, setGoalExpanded] = useState(false), [page, setPage] = useState(0), [issuePage, setIssuePage] = useState(0);
  const [localChoice, setLocalChoice] = useState<{ phaseId: string; nodeId: string }>();
  const progress = phase ? subtreeProgress(index, phase.id) : null, issues = useMemo(() => readingIssues(index), [index]), phaseNodes = phase ? subtreeNodes(index, phase.id) : [];
  const focusOptions = phaseNodes.filter(node => node.id === phase?.id || index.children.get(node.id)?.length);
  const localFocus = localChoice?.phaseId === phase?.id ? focusOptions.find(node => node.id === localChoice.nodeId) ?? phase : phase;
  const projectReviewCount = index.active.filter(node => view.derived[node.id]?.status === "review").length;
  const projectAccepted = view.derived[view.document.root_id]?.counts;
  const list = localFocus ? index.children.get(localFocus.id) ?? [] : [], listed = list.length ? list : localFocus ? [localFocus] : [], currentPage = Math.min(page, Math.max(0, Math.ceil(listed.length / OVERVIEW_LIST_PAGE) - 1));
  const shown = listed.slice(currentPage * OVERVIEW_LIST_PAGE, (currentPage + 1) * OVERVIEW_LIST_PAGE), currentIssuePage = Math.min(issuePage, Math.max(0, Math.ceil(issues.length / 8) - 1));
  const context = (id: string) => [...new Set([view.derived[id]?.path[1], index.nodes.get(id)?.parent_id].filter((value): value is string => Boolean(value && value !== id && value !== root?.id)))].map(value => index.nodes.get(value)?.title).filter(Boolean).join(" › ") || "工程直属层级";
  if (!root || !phase || !progress || !localFocus) return <div className="engineering-overview"><p className="eo-empty">当前工程没有可显示的活动任务。请核对工程计划。</p></div>;
  return <div className="engineering-overview">
    <section className="eo-goal" aria-label="工程目标"><div><span className="eo-eyebrow">这项工程要完成什么</span><h2 className={goalExpanded ? "" : "eo-goal-collapsed"}>{root.objective || "尚未明确工程目标。先把预期结果与验收条件写清楚。"}</h2>{goalExpanded && root.method && <p>{root.method}</p>}{(root.objective.length > 70 || root.method) && <button className="eo-text-button" type="button" aria-expanded={goalExpanded} onClick={() => setGoalExpanded(!goalExpanded)}>{goalExpanded ? "收起工程做法" : "展开目标与工程做法"}</button>}</div><button type="button" onClick={() => onNavigate(root.id)}>查看工程说明</button></section>
    <section className="eo-phase" aria-label="当前阅读阶段"><div className="eo-phase-heading"><div><span className="eo-eyebrow">{suggested ? "建议查看 · 最近新增的阶段" : phases.length ? "正在查看的阶段" : "尚未拆分阶段"}</span><h2>{phase.title}</h2></div>{phases.length > 0 && <label className="eo-phase-select">切换阶段<select aria-label="切换阶段" value={suggested ? "" : phase.id} onChange={event => { setPage(0); onSelectPhase(event.target.value || null); }}><option value="">建议查看最近阶段</option>{phases.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}</div>
      {phase.objective && phase.id !== root.id && <p className="eo-phase-objective">{phase.objective}</p>}<p className="eo-help">切换仅影响阅读，不会派发任务。</p>
      <dl className="eo-progress"><div data-metric="produced"><dt>已产出</dt><dd>{progress.produced}<small> 项</small></dd></div><div data-metric="checked"><dt>检查通过</dt><dd>{progress.checked}<small> 项</small></dd></div><div data-metric="accepted"><dt>人工已验收</dt><dd>{progress.accepted}<small> / {progress.total} 项</small></dd></div><div><dt>阶段本身</dt><dd className="eo-phase-status">{nodeStatusLabel(view, phase)}</dd></div></dl><details className="eo-count-explanation"><summary>计数说明</summary><p className="eo-help">前三项按末级任务分别计数。子步骤验收后，阶段本身仍需独立整合验收。</p></details>
    </section>
    <div className="eo-work-grid"><div className="eo-work-main"><section className="eo-relationships" aria-label="阶段关系"><div className="eo-section-heading"><h2>阶段内的工作关系</h2><div className="eo-view-switch" role="group" aria-label="阶段关系视图">{([{ id: "graph", text: "依赖图" }, { id: "list", text: "列表" }, { id: "matrix", text: "验收对照" }] as const).map(item => <button type="button" key={item.id} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.text}</button>)}</div></div>
      <label className="eo-local-focus">查看层级<select aria-label="查看层级" value={localFocus.id} onChange={event => { setPage(0); setLocalChoice({ phaseId: phase.id, nodeId: event.target.value }); }}>{focusOptions.map(node => <option key={node.id} value={node.id}>{node.id === phase.id ? "当前阶段的直属任务" : node.title + "的直属步骤"}</option>)}</select></label>
      {mode === "graph" && <LocalDependencyMap view={view} phaseId={localFocus.id} onNavigate={onNavigate} />}
      {mode === "matrix" && <AcceptanceMatrix key={localFocus.id} view={view} nodeId={localFocus.id} onNavigate={onNavigate} />}
      {mode === "list" && <div className="eo-phase-list"><p className="eo-help">当前只列“{localFocus.title}”的直属任务。选择其他层级可继续深入。</p>{shown.map(node => { const state = nodeReadState(index, node.id); return <button type="button" className="eo-list-row" data-node-id={node.id} key={node.id} onClick={() => onNavigate(node.id)}><span><small>{index.children.get(node.id)?.length ? "含 " + index.children.get(node.id)!.length + " 项直属步骤" : "末级任务"}</small><strong>{node.title}</strong><small>{state.produced ? "已产出" : "尚无当前产出"} · {state.checked ? "检查通过" : state.checkFailed ? "检查未通过" : "尚无通过检查"} · {state.accepted ? "已人工验收" : "尚未人工验收"}</small></span><span className="eo-node-status">{nodeStatusLabel(view, node)}</span></button>; })}{listed.length > OVERVIEW_LIST_PAGE && <div className="eo-pagination"><span>显示 {currentPage * OVERVIEW_LIST_PAGE + 1}–{Math.min((currentPage + 1) * OVERVIEW_LIST_PAGE, listed.length)} / {listed.length} 项</span><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" disabled={(currentPage + 1) * OVERVIEW_LIST_PAGE >= listed.length} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}</div>}
    </section>
    {phases.some(item => item.id !== phase.id) && <details className="eo-other-phases"><summary>其他阶段 <span>{phases.filter(item => item.id !== phase.id).length} 个 · {phases.filter(item => item.id !== phase.id).reduce((total, item) => total + subtreeProgress(index, item.id).unresolved, 0)} 项尚未验收</span></summary>{phases.filter(item => item.id !== phase.id).map(item => { const state = subtreeProgress(index, item.id); return <button type="button" key={item.id} className="eo-list-row" onClick={() => { setPage(0); onSelectPhase(item.id); }}><span><strong>{item.title}</strong><small>{state.accepted} / {state.total} 项末级任务已验收 · 含阶段整合在内，{state.unresolved} 项尚未验收</small></span><span>查看阶段</span></button>; })}</details>}
    </div><aside className="eo-attention" aria-label="需处理事项">
      <div className="eo-section-heading"><h2>需要处理</h2><span>{issues.length} 项</span></div>
      <p className="eo-help">包括待验收、待完善和未分配事项，并非都在阻塞执行。</p>
      <div className="eo-project-counts"><span data-metric="project-review">全工程待验收 {projectReviewCount} 项</span><span data-metric="project-accepted">全工程末级任务已验收 {projectAccepted?.accepted ?? 0} / {projectAccepted?.total ?? 0} 项</span></div>
      {issues.slice(currentIssuePage * 8, (currentIssuePage + 1) * 8).map(issue => <article key={issue.node.id} className="eo-issue" data-node-id={issue.node.id}>
        <span className="eo-node-status">{nodeStatusLabel(view, issue.node)}</span><h3>{issue.node.title}</h3><small className="eo-issue-context">所属：{context(issue.node.id)}</small><p>{issue.reason}</p><button type="button" className="eo-text-button" onClick={() => onNavigate(issue.node.id, issue.tab)}>{issue.action} →</button>
      </article>)}
      {!issues.length && <p className="eo-empty">{index.view.derived[root.id]?.status === "accepted" ? "当前工程已经完成整合验收。可进入步骤查看证据和反馈。" : "当前没有待处理的准备或验收问题。执行是否就绪仍由调度区判断。"}</p>}
      {issues.length > 8 && <div className="eo-pagination"><span>第 {currentIssuePage + 1} 页</span><button type="button" disabled={currentIssuePage === 0} onClick={() => setIssuePage(currentIssuePage - 1)}>上一页</button><button type="button" disabled={(currentIssuePage + 1) * 8 >= issues.length} onClick={() => setIssuePage(currentIssuePage + 1)}>下一页</button></div>}
    </aside></div>
  </div>;
}
