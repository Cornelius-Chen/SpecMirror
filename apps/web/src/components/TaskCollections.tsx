import { useEffect, useRef, useState } from "react";
import { TaskPresentationApiError, type TaskPresentationOperation, type TaskPresentationView } from "../task-presentation-api.ts";

export type TaskCollectionDialog = { type: "manage" } | { type: "assign"; taskId: string; taskTitle: string };
interface Props {
  dialog: TaskCollectionDialog;
  view?: TaskPresentationView;
  loading: boolean;
  loadError: string;
  onRetry: () => void;
  onMutate: (operation: TaskPresentationOperation, expectedRevision: number) => Promise<TaskPresentationView>;
  onClose: () => void;
}
const equalIds = (a: string[], b: string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");

/** Classification is presentation metadata; this dialog never edits an engineering document. */
export function TaskCollections({ dialog, view, loading, loadError, onRetry, onMutate, onClose }: Props) {
  const initialIds = useRef(dialog.type === "assign" ? [...(view?.task_collection_ids[dialog.taskId] ?? [])] : []);
  const [selectedIds, setSelectedIds] = useState(initialIds.current);
  const [edit, setEdit] = useState<{ type: "create" | "rename" | "delete"; id?: string; initialTitle: string }>({ type: "create", initialTitle: "" });
  const [title, setTitle] = useState(""), [error, setError] = useState(""), [saving, setSaving] = useState(false), [discard, setDiscard] = useState(false);
  const [baseRevision, setBaseRevision] = useState(view?.revision), [conflict, setConflict] = useState(false);
  const modal = useRef<HTMLElement>(null);
  const dirty = dialog.type === "assign" ? !equalIds(selectedIds, initialIds.current) : edit.type !== "delete" && title !== edit.initialTitle;
  const state = useRef({ dirty, saving, onClose }); state.current = { dirty, saving, onClose };
  const missingIds = selectedIds.filter((id) => !view?.collections.some((row) => row.id === id));
  const targetMissing = edit.type !== "create" && !view?.collections.some((row) => row.id === edit.id);
  const needsReview = conflict || !!view && baseRevision !== undefined && view.revision !== baseRevision && (dirty || edit.type === "delete");
  const savedIds = dialog.type === "assign" ? view?.task_collection_ids[dialog.taskId] ?? [] : [];
  const savedTitle = view?.collections.find((row) => row.id === edit.id)?.title;
  function adoptLatest(keepDraft: boolean) {
    if (!view || saving || loading || loadError) return;
    setBaseRevision(view.revision); setConflict(false); setError("");
    if (dialog.type === "assign") { initialIds.current = [...savedIds]; if (!keepDraft) setSelectedIds([...savedIds]); }
    else if (edit.type === "rename") { setEdit((current) => ({ ...current, initialTitle: savedTitle ?? "" })); if (!keepDraft) setTitle(savedTitle ?? ""); }
    else if (edit.type === "create" && !keepDraft) setTitle("");
  }
  useEffect(() => {
    if (!view || saving || loading || loadError || view.revision === baseRevision) return;
    if (dirty || edit.type === "delete" || conflict) { setConflict(true); return; }
    // A pristine editor can follow new saved data. A draft must explicitly adopt its new base.
    setBaseRevision(view.revision);
    if (dialog.type === "assign") { initialIds.current = [...(view.task_collection_ids[dialog.taskId] ?? [])]; setSelectedIds([...initialIds.current]); }
    else if (edit.type === "rename") { const nextTitle = view.collections.find((row) => row.id === edit.id)?.title ?? ""; setEdit((current) => ({ ...current, initialTitle: nextTitle })); setTitle(nextTitle); }
  }, [view, baseRevision, saving, loading, loadError, dirty, conflict, dialog, edit.type, edit.id]);
  function close() { if (state.current.saving) return; if (state.current.dirty) setDiscard(true); else state.current.onClose(); }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLElement>("input:not(:disabled),button:not(:disabled)")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key !== "Tab") return;
      const controls = [...(modal.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)") ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  useEffect(() => {
    if (!dirty && !saving) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", beforeUnload); return () => removeEventListener("beforeunload", beforeUnload);
  }, [dirty, saving]);
  function startEdit(type: "create" | "rename" | "delete", id?: string, name = "") {
    if (dirty || saving) return;
    setEdit({ type, id, initialTitle: type === "rename" ? name : "" }); setTitle(type === "rename" ? name : ""); setError(""); setBaseRevision(view?.revision); setConflict(false);
  }
  async function submit() {
    if (!view || saving || loadError || baseRevision === undefined || needsReview || view.revision !== baseRevision) return;
    const operation: TaskPresentationOperation = dialog.type === "assign"
      ? { type: "set_task_collections", task_id: dialog.taskId, collection_ids: selectedIds }
      : edit.type === "create" ? { type: "create_collection", title: title.trim() }
      : edit.type === "rename" ? { type: "rename_collection", id: edit.id!, title: title.trim() }
      : { type: "delete_collection", id: edit.id! };
    setSaving(true); setError("");
    try {
      const next = await onMutate(operation, baseRevision);
      if (dialog.type === "assign") onClose();
      else { setEdit({ type: "create", initialTitle: "" }); setTitle(""); setBaseRevision(next.revision); setConflict(false); }
    } catch (cause) {
      const conflict = cause instanceof TaskPresentationApiError && cause.code === "presentation_revision_conflict";
      if (conflict) setConflict(true);
      setError(conflict ? "分类已被其他操作更新。已保留你的输入；请核对最新分类后，再次保存。" : (cause as Error).message);
    } finally { setSaving(false); }
  }
  return <div className="uw-modal-backdrop"><section ref={modal} className="uw-modal uw-collections-modal" role="dialog" aria-modal="true" aria-label={dialog.type === "manage" ? "管理任务分类" : "修改任务分类"}>
    <h2>{dialog.type === "manage" ? "管理任务分类" : "修改任务分类"}</h2>
    <p>{dialog.type === "assign" ? <><strong>{dialog.taskTitle}</strong><br />可同时加入多个分类。取消所有勾选后，此任务归入“待分类”。</> : "分类帮助整理任务。任务的原始标题、项目来源、执行与验收状态仍由原记录保留。"}</p>
    {loading && <p role="status">正在读取最新分类…</p>}
    {loadError && <div className="uw-error" role="alert">{loadError}<button type="button" disabled={loading || saving} onClick={onRetry}>重新读取分类</button></div>}
    {discard ? <div className="uw-discard-classification"><h3>分类修改尚未保存</h3><p>关闭会丢弃这次分类输入，已经保存的分类和工程方案不受影响。</p><div className="uw-modal-actions"><button type="button" autoFocus onClick={() => setDiscard(false)}>继续修改分类</button><button type="button" onClick={onClose}>放弃分类修改并关闭</button></div></div> : <>
      {dialog.type === "assign" ? <fieldset className="uw-collection-checks" disabled={saving || !view || !!loadError}><legend>此任务所属分类</legend>
        {view?.collections.map((collection) => <label key={collection.id}><input type="checkbox" checked={selectedIds.includes(collection.id)} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, collection.id] : ids.filter((id) => id !== collection.id))} /><span>{collection.title}</span></label>)}
        {!view?.collections.length && !loading && !loadError && <p>还没有自定义分类。关闭后可从左侧“管理分类”创建。</p>}
        {missingIds.map((id) => <label key={id}><input type="checkbox" checked onChange={() => setSelectedIds((ids) => ids.filter((item) => item !== id))} /><span>此分类已被删除，请取消选择后保存。</span></label>)}
      </fieldset> : <>
        <div className="uw-collection-manager">{view?.collections.map((collection) => <div className="uw-collection-manager-row" key={collection.id}><span>{collection.title}</span><button type="button" disabled={saving || dirty || !!loadError} aria-label={`重命名分类 ${collection.title}`} onClick={() => startEdit("rename", collection.id, collection.title)}>重命名</button><button type="button" disabled={saving || dirty || !!loadError} aria-label={`删除分类 ${collection.title}`} onClick={() => startEdit("delete", collection.id)}>删除</button></div>)}{view && !view.collections.length && <p className="uw-hint">还没有分类，可以先创建一个。</p>}</div>
        {edit.type === "delete" ? <div className="uw-collection-delete"><h3>删除「{view?.collections.find((row) => row.id === edit.id)?.title || "此分类"}」？</h3><p>将移除这个分类，以及 {Object.values(view?.task_collection_ids ?? {}).filter((ids) => ids.includes(edit.id!)).length} 项任务与它的分类关系。任务、原始对话、工程计划和验收记录会保留；其他分类关系也会保留。</p></div> : <label className="uw-collection-title">{edit.type === "create" ? "新分类名称" : "分类新名称"}<input aria-label={edit.type === "create" ? "新分类名称" : "分类新名称"} maxLength={60} value={title} disabled={saving || !!loadError || !view} onChange={(event) => setTitle(event.target.value)} /></label>}
        {edit.type !== "create" && <button type="button" className="uw-text-button" disabled={saving} onClick={() => { setEdit({ type: "create", initialTitle: "" }); setTitle(""); setError(""); setBaseRevision(view?.revision); setConflict(false); }}>取消本次{edit.type === "rename" ? "重命名" : "删除"}</button>}
      </>}
      {needsReview && <div className="uw-error uw-collection-conflict" role="alert"><strong>分类版本已变化，已保留你的输入。</strong><p>请对照最新已保存内容，明确核对后再保存草稿。</p>{!loadError && <div className="uw-collection-saved" aria-label="最新已保存的分类">{dialog.type === "assign" ? <p>此任务当前已保存：{savedIds.map((id) => view?.collections.find((row) => row.id === id)?.title).filter(Boolean).join("、") || "待分类"}</p> : edit.type === "rename" || edit.type === "delete" ? <p>此分类当前已保存：{savedTitle || "分类已删除"}</p> : <p>当前已保存的分类：{view?.collections.map((row) => row.title).join("、") || "暂无分类"}</p>}</div>}<div className="uw-modal-actions"><button type="button" disabled={saving || loading || !!loadError} onClick={() => adoptLatest(false)}>改用最新已保存内容</button><button type="button" disabled={saving || loading || !!loadError} onClick={() => adoptLatest(true)}>已核对，保留草稿继续</button></div></div>}
      {error && !needsReview && <div className="uw-error" role="alert">{error}</div>}
      {targetMissing && dialog.type === "manage" && <p className="uw-error" role="alert">此分类已不存在，请取消本次操作后重新选择。</p>}
      <div className="uw-modal-actions"><button type="button" disabled={saving} onClick={close}>关闭</button><button type="button" className="uw-primary" disabled={saving || loading || !!loadError || !view || needsReview || baseRevision === undefined || (dialog.type === "assign" ? !dirty || !!missingIds.length : targetMissing || edit.type !== "delete" && !title.trim())} onClick={() => void submit()}>{saving ? "正在保存分类…" : dialog.type === "assign" ? "保存任务分类" : edit.type === "create" ? "创建分类" : edit.type === "rename" ? "保存分类名称" : "确认删除分类"}</button></div>
    </>}
  </section></div>;
}
