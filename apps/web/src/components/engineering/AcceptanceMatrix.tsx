import { useMemo, useState } from "react";
import type { EngineeringView } from "@epm/domain";
import { acceptanceRows, overviewIndex, OVERVIEW_LIST_PAGE } from "./overview-selectors.ts";

export function AcceptanceMatrix({ view, nodeId, onNavigate }: { view: EngineeringView; nodeId: string; onNavigate: (nodeId: string, tab?: string) => void }) {
  const rows = useMemo(() => acceptanceRows(overviewIndex(view), nodeId), [view, nodeId]), [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / OVERVIEW_LIST_PAGE) - 1)), shown = rows.slice(currentPage * OVERVIEW_LIST_PAGE, (currentPage + 1) * OVERVIEW_LIST_PAGE);
  return <section className="eo-acceptance-matrix" aria-label="验收对照">
    <p className="eo-help">条件与承接关系来自已保存的方案。子任务的检查和验收状态不会自动替代上层条件的验收证据。</p>
    {!rows.length ? <div className="eo-empty"><p>当前层级尚未定义验收条件，也没有明确承接的上层条件。</p><button type="button" onClick={() => onNavigate(nodeId, "criteria")}>补充验收条件</button></div> : <div role="table" aria-label="条件、承接任务与当前证据" className="eo-matrix-table">
      <div className="eo-matrix-header" role="row"><span role="columnheader">怎样算通过</span><span role="columnheader">谁来承接</span><span role="columnheader">条件的当前证据</span></div>
      {shown.map(row => <div role="row" className="eo-matrix-row" key={row.id}>
        <div role="cell"><span className="eo-mobile-label">怎样算通过</span><span className="eo-map-kicker">{row.inherited ? "承接的上层条件" : "本层条件"}</span><strong>{row.criterion.text}</strong><button type="button" className="eo-text-button" onClick={() => onNavigate(row.owner.id, "criteria")}>查看“{row.owner.title}”的条件</button></div>
        <div role="cell"><span className="eo-mobile-label">谁来承接</span>{row.uncovered ? <p className="eo-alert">尚未指定承接子任务</p> : row.contributors.map(({ node, state }) => <div className="eo-contributor" key={node.id}><button className="eo-text-button" type="button" onClick={() => onNavigate(node.id)}>{node.title}</button><small>{row.direct ? "本步骤直接负责" : row.inherited ? "该分支在上层关系中承接此条件" : "已明确承接这条条件"}</small><small>{state.produced ? "已有实际产出" : "尚无当前产出"} · {state.checked ? "检查通过" : state.checkFailed ? "检查未通过" : "尚无通过的检查"}</small><small>{state.accepted ? "该任务已人工验收" : "该任务尚未人工验收"}{state.historicalOnly ? " · 仅有历史运行" : ""}</small></div>)}</div>
        <div role="cell"><span className="eo-mobile-label">条件的当前证据</span>{row.evidence.length ? <><p>{row.evidence.filter(evidence => evidence.kind === "artifact" || evidence.kind === "capability").length} 项产出证据 · {row.evidence.filter(evidence => evidence.kind === "check" && evidence.passed === true).length} 项通过检查</p>{row.evidence.some(evidence => evidence.passed === false) && <p className="eo-alert">存在未通过的检查或人工核对</p>}<p>{row.ownerState.accepted ? "条件所属任务已人工验收" : "仍需核对条件并完成人工验收"}</p><button type="button" className="eo-text-button" onClick={() => onNavigate(row.owner.id, "runs")}>查看这条条件的运行证据</button></> : <><p>{row.historicalOnly ? "只有历史记录，当前版本没有对应证据。" : "当前运行还没有直接对应这条条件的证据。"}</p><p className="eo-help">{row.ownerState.accepted ? "所属任务已验收；此处未找到直接绑定的证据，需查看整合记录。" : "已产出、检查通过和人工验收分别记录。"}</p><button type="button" className="eo-text-button" onClick={() => onNavigate(row.owner.id, "runs")}>查看运行与验收</button></>}</div>
      </div>)}
    </div>}
    {rows.length > OVERVIEW_LIST_PAGE && <div className="eo-pagination"><span>第 {currentPage + 1} 页 · 共 {rows.length} 条条件</span><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" disabled={(currentPage + 1) * OVERVIEW_LIST_PAGE >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
  </section>;
}
