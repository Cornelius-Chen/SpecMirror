import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Boxes, Cable, Check, Clock3, GripVertical, Image, KeyRound, LockKeyhole, Plug, ShieldCheck, Sparkles, X } from "lucide-react";
import { api } from "../api.ts";
import type { Capability, CapabilityKind, PermissionContract, SupervisionDetail, SupervisionDocument } from "../types.ts";

const kindMeta: Record<CapabilityKind, { label: string; icon: typeof Bot }> = {
  agent: { label: "Agent", icon: Bot },
  skill: { label: "Skill", icon: Sparkles },
  api: { label: "API", icon: Plug },
  mcp: { label: "MCP", icon: Cable },
  asset: { label: "素材", icon: Image }
};

const contractLabels: Record<PermissionContract["status"], string> = { proposed: "待批准", approved: "已授权", revoked: "已撤销", expired: "已过期" };

export function CapabilityWorkspace() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [contracts, setContracts] = useState<PermissionContract[]>([]);
  const [document, setDocument] = useState<SupervisionDocument>();
  const [selectedDetailId, setSelectedDetailId] = useState<string>();
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [bundle, supervision] = await Promise.all([api.capabilities(), api.supervision()]);
    setCapabilities(bundle.capabilities); setContracts(bundle.contracts); setDocument(supervision);
    setSelectedDetailId((current) => current ?? supervision.details[0]?.id);
  }, []);
  useEffect(() => { void reload().catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }, [reload]);
  useEffect(() => { const stream = new EventSource("/api/events"); stream.onmessage = () => { void reload(); }; return () => stream.close(); }, [reload]);

  const selectedDetail = document?.details.find((item) => item.id === selectedDetailId);
  const relevantContracts = useMemo(() => contracts.filter((item) => item.detail_id === selectedDetailId).sort((a, b) => b.created_at.localeCompare(a.created_at)), [contracts, selectedDetailId]);

  async function assign(capabilityId: string) {
    if (!selectedDetailId) return;
    setBusy(true); setMessage("");
    try {
      const contract = await api.createPermissionContract(capabilityId, selectedDetailId);
      setContracts((current) => [...current, contract]);
      setMessage("授权草案已生成。只有你明确批准后，它才会进入本任务的运行快照。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function review(contract: PermissionContract, verdict: "approved" | "revoked") {
    setBusy(true); setMessage("");
    try {
      const next = await api.reviewPermissionContract(contract.id, verdict);
      setContracts((current) => current.map((item) => item.id === next.id ? next : item));
      setMessage(verdict === "approved" ? "已批准：权限只对当前设计任务、当前合同和有效期生效。" : "已撤销：后续运行不会再携带这份授权。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  if (!document) return <div className="supervision-loading">正在读取能力登记与授权合同…</div>;
  return <main className="capability-workspace" data-testid="capability-workspace">
    <header className="capability-header"><div><span className="page-index">CAPABILITY CONTROL</span><h1>能力与授权</h1><p>先把能力放入具体设计任务，再检查并批准最小权限。拖入不等于授权。</p></div><div className="capability-safety"><ShieldCheck size={18} /><span><strong>凭证永不进入本页</strong><small>需要密钥时只记录“服务端提供”</small></span></div></header>
    <div className="capability-columns">
      <section className="capability-library">
        <div className="column-title"><strong>能力库</strong><span>{capabilities.filter((item) => item.status === "available").length} 项当前可用</span></div>
        <div className="capability-list">{capabilities.map((capability) => {
          const MetaIcon = kindMeta[capability.kind].icon;
          return <article key={capability.id} draggable onDragStart={(event) => event.dataTransfer.setData("application/x-specmirror-capability", capability.id)} className={`${capability.status} ${selectedCapabilityId === capability.id ? "selected" : ""}`} data-testid={`capability-card-${capability.id}`} onClick={() => setSelectedCapabilityId(capability.id)}>
            <header><span><MetaIcon size={14} />{kindMeta[capability.kind].label}</span><GripVertical size={13} /></header><strong>{capability.title}</strong><p>{capability.description}</p><small>{capability.status === "available" ? "可生成授权草案" : "当前禁用 · 仅可预览边界"}</small>
            <button disabled={busy} onClick={(event) => { event.stopPropagation(); void assign(capability.id); }}>放入当前任务</button>
          </article>;
        })}</div>
      </section>

      <section className="capability-targets">
        <div className="column-title"><strong>设计任务</strong><span>选择授权作用对象</span></div>
        <div className="target-list">{document.details.map((detail) => <button key={detail.id} className={detail.id === selectedDetailId ? "active" : ""} onClick={() => setSelectedDetailId(detail.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("application/x-specmirror-capability"); if (id) void assign(id); }} data-testid={`capability-target-${detail.id}`}>
          <span>{detail.category}</span><strong>{detail.title}</strong><small>{contracts.filter((item) => item.detail_id === detail.id && item.status === "approved").length} 项有效授权</small>
        </button>)}</div>
        <div className="drop-instruction"><Boxes size={18} /><strong>拖到任务，或先选任务再点击能力</strong><span>系统只创建待批准合同，不会立即调用能力。</span></div>
      </section>

      <aside className="contract-inspector">
        <div className="column-title"><strong>授权合同</strong><span>{selectedDetail?.title}</span></div>
        {relevantContracts.length ? <div className="contract-list">{relevantContracts.map((contract) => {
          const capability = capabilities.find((item) => item.id === contract.capability_id);
          return <article key={contract.id} className={`contract-${contract.status}`}>
            <header><span className="contract-status">{contractLabels[contract.status]}</span><small><Clock3 size={11} />24 小时任务授权</small></header><h2>{capability?.title}</h2><p>{contract.purpose}</p>
            <div className="credential-boundary"><KeyRound size={13} /><span><strong>{contract.credential_mode === "none" ? "无需凭证" : "凭证仅由服务端提供"}</strong><small>本页不保存、不显示也不传递密钥</small></span></div>
            <details><summary>检查允许与禁止范围</summary><div className="contract-rules"><section><strong>允许</strong>{contract.allowed_actions.map((item) => <span key={item}>✓ {item}</span>)}</section><section><strong>禁止</strong>{contract.forbidden_actions.map((item) => <span key={item}>× {item}</span>)}</section></div></details>
            <div className="contract-actions">{contract.status === "proposed" && <button className="approve" disabled={busy || capability?.status !== "available"} onClick={() => review(contract, "approved")}><Check size={13} />批准最小权限</button>}{["proposed", "approved"].includes(contract.status) && <button disabled={busy} onClick={() => review(contract, "revoked")}><X size={13} />撤销</button>}</div>
          </article>;
        })}</div> : <div className="contract-empty"><LockKeyhole size={24} /><h2>当前任务尚无授权</h2><p>选择左侧能力并放入当前任务。你会先看到完整合同，再决定是否批准。</p></div>}
        {message && <p className="capability-message">{message}</p>}
      </aside>
    </div>
  </main>;
}
