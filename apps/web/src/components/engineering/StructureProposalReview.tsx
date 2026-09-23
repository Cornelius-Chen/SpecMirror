import { useEffect, useRef, useState } from "react";
import type { EngineeringView } from "@epm/domain";
import type { EngineeringApi, StructureProposalPreview, StructureProposalSummary } from "../../engineering-api.ts";
import { ProjectStructureMap } from "../project-map/ProjectStructureMap.tsx";
import { revealProjectNode } from "../project-map/navigation.ts";
import "./structure-proposal.css";

/** Review changes in the same map, before replacing any authoritative nodes. */
export function StructureProposalReview({ api, revision, disabled, onApplied, onPreviewChange, onBusyChange }: {
  api: EngineeringApi; revision: number; disabled: boolean; onApplied: (view: EngineeringView) => void;
  onPreviewChange: (visible: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [summary, setSummary] = useState<StructureProposalSummary>();
  const [preview, setPreview] = useState<StructureProposalPreview>();
  const [selected, setSelected] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [relations, setRelations] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void api.structureProposal().then(next => { if (current) setSummary(next); }).catch(() => { if (current) setSummary(undefined); });
    return () => { current = false; };
  }, [api, revision]);
  const setWorking = (value: boolean) => { setBusy(value); onBusyChange(value); };
  async function open() {
    if (busy || disabled || !summary?.proposal_id) return;
    setWorking(true); setError("");
    try {
      const next = await api.previewStructure(summary.proposal_id);
      if (!mounted.current) return;
      setPreview(next); setSelected(next.view.document.root_id); setExpanded([next.view.document.root_id]); setAcknowledged(false); onPreviewChange(true);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setWorking(false); }
  }
  async function apply() {
    if (!preview || !preview.approval_configured || busy || disabled || !acknowledged || preview.expected_revision !== revision) return;
    setWorking(true); setError("");
    try {
      const next = await api.commitStructure(preview.proposal_id, preview.token, preview.expected_revision);
      if (!mounted.current) return;
      setPreview(undefined); onPreviewChange(false); onApplied(next);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setWorking(false); }
  }
  const node = preview?.view.document.nodes.find(item => item.id === selected);
  if (!summary?.available && !preview) return null;
  if (!preview) return <section className="structure-proposal-invitation" aria-label="成果结构方案">
    <div><strong>{summary?.title}</strong><p>{summary?.current ? `已准备 ${summary.node_count} 项成果结构，可先展开核对，再决定采用。` : "工程已更新，这份结构方案需要重新核对版本。"}</p>{summary?.approval_configured === false && <small className="structure-proposal-auth-state">未连接可信人工授权；仍可查看完整方案。</small>}</div>
    <button type="button" disabled={disabled || busy || !summary?.current || !summary?.proposal_id} onClick={() => void open()}>{busy ? "正在核对影响…" : "查看新结构"}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
  return <section className="structure-proposal-review" aria-label="新成果结构预览">
    <header><div><strong>{preview.approval_configured ? "新结构 · 待采用" : "新结构 · 只读预览"}</strong><p>共 {preview.node_count} 项；旧任务保留历史，{preview.invalidated_run_ids.length} 次旧运行不计入新方案的完成结果。</p></div><button type="button" disabled={busy} onClick={() => { setPreview(undefined); onPreviewChange(false); setError(""); }}>返回当前工程</button></header>
    <ProjectStructureMap workspaceId={`${api.workspaceId ?? "host"}:proposal`} view={preview.view} selectedNodeId={selected} expandedNodeIds={expanded} showDependencies={relations} onDependenciesChange={setRelations} disabled={busy} onRequestNavigation={intent => {
      if (busy) return;
      if (intent.type === "toggle") { setSelected(intent.nodeId); setExpanded(current => current.includes(intent.nodeId) ? current.filter(id => id !== intent.nodeId) : [...current, intent.nodeId]); }
      else if (intent.type === "collapse") { setSelected(intent.nodeId); setExpanded(current => current.filter(id => id !== intent.nodeId)); }
      else if (intent.nodeId) { const id = intent.nodeId; setSelected(id); setExpanded(current => revealProjectNode(preview.view, id, current)); }
    }} />
    {node && <section className="structure-proposal-contract" aria-label="预览交付约定"><h3>{node.title}</h3><p>{node.objective}</p><div>
      <section><h4>负责什么</h4><ul>{node.delivery?.included.map((text, index) => <li key={index}>{text}</li>)}</ul><h4>不做什么</h4><ul>{node.delivery?.excluded.map((text, index) => <li key={index}>{text}</li>)}</ul></section>
      <section><h4>交付与完成条件</h4>{node.delivery?.outputs.map(output => <div key={output.id}><strong>{output.title}</strong><ul>{output.criterion_ids.map(id => <li key={id}>{node.criteria.find(item => item.id === id)?.text || "待补充条件"}</li>)}</ul></div>)}<h4>需要什么</h4>{node.delivery?.inputs.length ? <ul>{node.delivery.inputs.map(input => <li key={input.id}>{input.title} · {input.source_node_id ? <button type="button" onClick={() => { setSelected(input.source_node_id!); setExpanded(current => revealProjectNode(preview.view, input.source_node_id!, current)); }}>{preview.view.document.nodes.find(item => item.id === input.source_node_id)?.title || "来源待核对"}</button> : input.external_source}</li>)}</ul> : <p>本项无需额外外部输入；子项通过后仍须独立整体验收。</p>}</section>
    </div></section>}
    <footer><p>{preview.reason}</p>{!preview.approval_configured && <p className="structure-proposal-auth-warning" role="status"><strong>未连接可信人工授权</strong><span>当前可以完整查看这张图，但不能采用。连接可信授权后仍需由人明确确认。</span></p>}<label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy || !preview.approval_configured} />我已核对：采用后以新草稿推进，旧运行仅保留历史，不自动视为新成果已完成。</label>
      {preview.expected_revision !== revision && <p role="alert">当前工程已变化，请返回后重新预览。</p>}
      {error && preview.expected_revision === revision && <p role="alert">{error}</p>}
      <button type="button" title={preview.approval_configured ? undefined : "未连接可信人工授权"} disabled={!preview.approval_configured || !acknowledged || disabled || busy || preview.expected_revision !== revision} onClick={() => void apply()}>{busy ? "正在保存新结构…" : "采用这份成果结构"}</button>
    </footer>
  </section>;
}
