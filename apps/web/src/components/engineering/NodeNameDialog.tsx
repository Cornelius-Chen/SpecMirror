import { useEffect, useRef, useState } from "react";
import type { EngineeringNode } from "@epm/domain";
import { createTaskPresentationApi, TaskPresentationApiError, type TaskPresentationView } from "../../task-presentation-api.ts";
import { kindNames } from "./shared.ts";

interface Props {
  node: EngineeringNode;
  workspaceId: string;
  presentation: TaskPresentationView;
  onSaved: (view: TaskPresentationView) => void;
  onClose: () => void;
}

/** A display name never changes the frozen plan or its acceptance records. */
export function NodeNameDialog({ node, workspaceId, presentation, onSaved, onClose }: Props) {
  const dialog = useRef<HTMLElement>(null);
  const [name, setName] = useState(presentation.workspace.node_names?.[node.id] ?? "");
  const [revision, setRevision] = useState(presentation.revision);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<TaskPresentationView>();
  const normalized = name.trim();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, []);
  async function loadLatest() {
    setBusy(true); setLatest(undefined);
    try { setLatest(await createTaskPresentationApi(workspaceId).load()); setError("名称信息已有更新。你的输入已保留，请先核对最新名称。"); }
    catch { setError("暂时无法读取最新名称。你的输入仍保留，请重试读取。"); }
    finally { setBusy(false); }
  }
  async function save(value: string | null) {
    if (busy || conflict) return;
    setBusy(true); setError("");
    const api = createTaskPresentationApi(workspaceId);
    try {
      const next = await api.mutate(revision, { type: "set_node_names", names: { [node.id]: value } });
      onSaved(next); onClose();
    } catch (cause) {
      if (cause instanceof TaskPresentationApiError && cause.status === 409) {
        setConflict(true);
        await loadLatest();
      } else setError((cause as Error).message);
    } finally { setBusy(false); }
  }
  return <div className="uw-modal-backdrop"><section ref={dialog} className="uw-modal uw-node-name-modal" role="dialog" aria-modal="true" aria-label="修改节点名称" onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }}>
    <h2>修改名称</h2><p>名称用来识别这一项，完整要求放在目标里。</p>
    <form onSubmit={event => { event.preventDefault(); if (normalized && normalized.length <= 24) void save(normalized); }}>
      <label>简短名称<input value={name} onChange={event => setName(event.target.value)} maxLength={24} disabled={busy} placeholder="例如：方案编辑" aria-describedby="node-name-preview" /></label>
      <p id="node-name-preview">显示为：<strong>{kindNames[node.kind]}：{normalized || "简短名称"}</strong></p>
      <p className="uw-hint">建议 4–10 字。改名会同步到地图和各处入口，已有目标与验收记录保留。</p>
      {error && <p className="uw-error" role="alert">{error}</p>}
      {conflict && !latest && <button type="button" disabled={busy} onClick={() => void loadLatest()}>重新读取最新名称</button>}
      {conflict && latest && <div className="uw-hint"><p>最新名称：{latest.workspace.node_names?.[node.id] ?? node.title}</p><button type="button" onClick={() => { setRevision(latest.revision); setConflict(false); setError(""); }}>已核对，保留我的输入</button></div>}
      <div className="uw-modal-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button>{presentation.workspace.node_names?.[node.id] && <button type="button" disabled={busy || conflict} onClick={() => void save(null)}>恢复原名</button>}<button type="submit" className="uw-primary" disabled={busy || conflict || !normalized || normalized.length > 24}>{busy ? "正在保存…" : "保存名称"}</button></div>
    </form>
  </section></div>;
}
