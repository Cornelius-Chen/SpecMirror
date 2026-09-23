import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EngineeringView } from "@epm/domain";
import { localDependencyView, overviewIndex } from "./overview-selectors.ts";
import { nodeStatusLabel } from "./shared.ts";
import { routeDependencyLinks, type DependencyRoute } from "./dependency-routing.ts";

export function LocalDependencyMap({ view, phaseId, onNavigate }: { view: EngineeringView; phaseId: string; onNavigate: (nodeId: string, tab?: string) => void }) {
  const index = useMemo(() => overviewIndex(view), [view]), graph = useMemo(() => localDependencyView(index, phaseId), [index, phaseId]);
  const canvas = useRef<HTMLDivElement>(null), elements = useRef(new Map<string, HTMLButtonElement>()), marker = useId().replaceAll(":", "");
  const [paths, setPaths] = useState<DependencyRoute[]>([]);
  const orderedNodes = useMemo(() => {
    const ranks = new Map(graph.nodes.map(node => [node.id, 0]));
    for (let pass = 0; pass < graph.nodes.length; pass++) { let changed = false; for (const link of graph.links) { const next = Math.min(graph.nodes.length, (ranks.get(link.from) ?? 0) + 1); if (next > (ranks.get(link.to) ?? 0)) { ranks.set(link.to, next); changed = true; } } if (!changed) break; }
    return [...graph.nodes].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  }, [graph]);
  useLayoutEffect(() => {
    const container = canvas.current; if (!container) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        const bounds = container.querySelector("svg")!.getBoundingClientRect();
        const rectangles = graph.nodes.flatMap(node => { const rect = elements.current.get(node.id)?.getBoundingClientRect(); return rect ? [{ id: node.id, left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top }] : []; });
        const next = routeDependencyLinks(rectangles, graph.links);
        setPaths(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      });
    };
    const observer = new ResizeObserver(measure); observer.observe(container); for (const element of elements.current.values()) observer.observe(element); measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [graph]);
  if (!graph.nodes.length) return <p className="eo-empty">当前层级还没有可显示的任务。</p>;
  return <section className="eo-dependency-map" aria-label="局部依赖图">
    <p className="eo-help">只展开同一层级的任务，箭头表示前置关系。</p>
    <div className="eo-map-canvas" ref={canvas} style={{ "--eo-lanes": Math.min(3, orderedNodes.length) } as React.CSSProperties}>
      <svg className="eo-map-lines" aria-hidden="true"><defs><marker id={marker} data-local-dependency-marker="true" data-marker-size="7" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" fill="#759384" /></marker></defs>{paths.map(path => <g key={path.id}><path d={path.d} fill="none" stroke="#fafcf7" strokeWidth="4.5" strokeLinejoin="round" /><path data-dependency-path={path.id} data-from={path.from} data-to={path.to} d={path.d} fill="none" stroke="#6f9581" strokeWidth="1.5" strokeLinejoin="round" strokeDasharray={path.inherited ? "4 4" : undefined} markerEnd={`url(#${marker})`} /></g>)}</svg>
      {orderedNodes.map(node => <button type="button" key={node.id} data-node-id={node.id} ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }} className={`eo-map-node ${graph.externalIds.has(node.id) ? "is-external" : ""} ${node.id === phaseId ? "is-phase" : ""}`} onClick={() => onNavigate(node.id)}>
        <span className="eo-map-kicker">{graph.externalIds.has(node.id) ? "层级外关联" : node.id === phaseId ? "当前步骤" : "本层直属任务"}</span><strong>{node.title}</strong>{graph.externalIds.has(node.id) && <small className="eo-map-kicker">来自：{index.nodes.get(index.view.derived[node.id]?.path[1] ?? node.id)?.title}</small>}<span className="eo-node-status">{nodeStatusLabel(view, node)}</span>
      </button>)}
    </div>
    {!graph.links.length && <p className="eo-empty">当前展开范围没有已声明的依赖连线。并列展示不代表可以同时执行。</p>}
    {(graph.hiddenNodes > 0 || graph.hiddenExternalNodes > 0 || graph.hiddenLinks > 0) && <p className="eo-fold-note" role="status">本层显示 {graph.levelTotal - graph.hiddenPeers} / {graph.levelTotal} 项；{graph.hiddenDescendants} 项下级任务、{graph.hiddenPeers} 项同层任务、{graph.hiddenExternalNodes} 项层级外关联和 {graph.hiddenLinks} 条关系未展开。用“查看层级”进入下一级，用“列表”逐页查看本层。</p>}
    {graph.missingIds.length > 0 && <p className="eo-alert">有 {graph.missingIds.length} 个前置任务未找到，依赖仍未满足。请在步骤中核对。</p>}
    <details className="eo-map-explanation"><summary>图例与执行限制</summary><p className="eo-help">虚线箭头表示继承的前置条件，虚线外框标出当前层级以外的任务。并列分支不代表可以同时执行；负责人、源码范围与共享资源仍由引擎检查。</p></details>
    {graph.links.length > 0 && <details className="eo-relations"><summary>逐条读取已展开关系（{graph.links.length} 条）</summary><ul>{graph.links.map(link => <li key={link.id}><button className="eo-text-button" type="button" onClick={() => onNavigate(link.from)}>{index.nodes.get(link.from)?.title}</button><span> 是 </span><button className="eo-text-button" type="button" onClick={() => onNavigate(link.to)}>{index.nodes.get(link.to)?.title}</button><span> 的前置任务</span>{link.inherited && <small>继承自“{index.nodes.get(link.origin)?.title}”</small>}{link.crossPhase && <small>跨阶段关系</small>}</li>)}</ul></details>}
  </section>;
}
