import { ArrowUpRight, Braces, GitCommitHorizontal, ShieldCheck, TestTube2 } from "lucide-react";
import type { Entity, TraceEdge } from "../types.ts";
import { StatusMark } from "./StatusMark.tsx";

export function Inspector({ entity, edges, onClose }: { entity?: Entity; edges: TraceEdge[]; onClose(): void }) {
  if (!entity) return <aside className="inspector empty-inspector">
    <div className="inspector-kicker">检查器</div><ShieldCheck size={32} strokeWidth={1.2} />
    <h2>选择一个规格节点</h2><p>检查范围、验收、代码、测试、证据和关系历史。高级元数据只在需要时展开。</p>
  </aside>;
  const related = edges.filter((edge) => edge.from === entity.id || edge.to === entity.id);
  const acceptance = (entity.acceptance ?? entity.acceptance_commands ?? []) as string[];
  const tests = (entity.test_paths ?? []) as string[];
  return <aside className="inspector" data-testid="inspector">
    <button className="inspector-close" onClick={onClose} aria-label="关闭检查器">×</button>
    <div className="inspector-kicker">对象检查器</div>
    <StatusMark status={entity.status} />
    <h2>{entity.title ?? entity.id}</h2>
    <p className="entity-id">{entity.id}{entity.version ? ` · ${entity.version}` : ""}</p>
    {(entity.summary || entity.rationale || entity.outcome) && <p className="inspector-summary">{String(entity.summary ?? entity.rationale ?? entity.outcome)}</p>}
    <InspectorGroup icon={GitCommitHorizontal} title="关系" empty="暂无正式关系">
      {related.map((edge) => <div className="relation-line" key={edge.id}><span>{edge.from === entity.id ? "输出" : "输入"}</span><b>{edge.relation}</b><code>{edge.from === entity.id ? edge.to : edge.from}</code></div>)}
    </InspectorGroup>
    <InspectorGroup icon={TestTube2} title="验收" empty="未声明验收">
      {acceptance.map((item) => <p className="check-line" key={item}>✓ {item}</p>)}
      {tests.map((item) => <p className="path-line" key={item}>{item}</p>)}
    </InspectorGroup>
    <details className="raw-details"><summary><Braces size={14} /> 高级元数据</summary><pre>{JSON.stringify(entity, null, 2)}</pre></details>
    <button className="ghost-action">查看版本历史 <ArrowUpRight size={14} /></button>
  </aside>;
}

function InspectorGroup({ icon: Icon, title, empty, children }: { icon: typeof ShieldCheck; title: string; empty: string; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section className="inspector-group"><h3><Icon size={15} />{title}</h3>{hasChildren ? children : <p className="muted">{empty}</p>}</section>;
}
