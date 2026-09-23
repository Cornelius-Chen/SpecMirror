import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineeringCapabilityCatalog, EngineeringChangePreview, EngineeringNode, EngineeringView } from "@epm/domain";
import { EngineeringApiError, engineeringApi, type EngineeringApi, type PlanImportPreview, type WorkPackagePreview, type WorkPackageRequest } from "../engineering-api.ts";
import { PlanEditor } from "./engineering/PlanEditor.tsx";
import { RunPanel } from "./engineering/RunPanel.tsx";
import { PlanImportDialog } from "./engineering/PlanImportDialog.tsx";
import { WorkPackageDialog } from "./engineering/WorkPackageDialog.tsx";
import { workPackageCommitReceipt } from "./engineering/work-package-state.ts";
import { NodeLabelsEditor, StepReadingView } from "./engineering/StepReadingView.tsx";
import { currentNodeRun, kindNames, nodeStatusLabel, ordered, statusNames, timeLabel } from "./engineering/shared.ts";
import { engineeringNodeName } from "./engineering/node-names.ts";
import { hasActiveExternalEngineeringRun, selectEngineeringView } from "./engineering/workspace-state.ts";
import "../engineering.css";

const editTabs = [{ id: "plan", label: "任务方案" }, { id: "bounds", label: "约束边界" }, { id: "criteria", label: "验收条件" }, { id: "actions", label: "执行动作" }, { id: "capabilities", label: "能力选用" }];
const mainTabs = [{ id: "reading", label: "步骤说明" }, { id: "edit", label: "编辑方案" }, { id: "runs", label: "运行与验收" }, { id: "history", label: "变更记录" }];
const cleanNode = (node: EngineeringNode): EngineeringNode => ({ ...node, ...(node.source_scope ? { source_scope: { ...node.source_scope, root: node.source_scope.root.trim(), allow: node.source_scope.allow.map((item) => item.trim()).filter(Boolean), deny: node.source_scope.deny.map((item) => item.trim()).filter(Boolean) } } : {}), constraints: Object.fromEntries(Object.entries(node.constraints).map(([key, values]) => [key, values.map((value: string) => value.trim()).filter(Boolean)])) as EngineeringNode["constraints"] });

export interface EngineeringFocus { nodeId: string; tab?: string; requestId: number; field?: string }
interface EngineeringWorkspaceProps {
  onOpenLegacy?: () => void;
  api?: EngineeringApi;
  embedded?: boolean;
  inlineDetail?: boolean;
  focus?: EngineeringFocus;
  onView?: (view: EngineeringView) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onError?: (error: string) => void;
  onSelectionChange?: (nodeId: string) => void;
  onRequestSelection?: (nodeId: string) => void;
  onConnectionChange?: (connected: boolean) => void;
  externalView?: EngineeringView;
  externalBusy?: boolean;
  onTabChange?: (nodeId: string, tab: string) => void;
  refreshToken?: number;
  nodeNames?: Record<string, string>;
}
export function EngineeringWorkspace({ onOpenLegacy, api = engineeringApi, embedded = false, inlineDetail = false, focus, onView, onDirtyChange, onBusyChange, onError, onSelectionChange, onRequestSelection, onConnectionChange, externalView, externalBusy = false, onTabChange, refreshToken, nodeNames }: EngineeringWorkspaceProps) {
  const [view, setView] = useState<EngineeringView>();
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<EngineeringNode>();
  const [dirty, setDirty] = useState(false);
  const [invalidInput, setInvalidInput] = useState(false);
  const [runDraftDirty, setRunDraftDirty] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDirty, setImportDirty] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importEpoch, setImportEpoch] = useState(0);
  const [workPackageOpen, setWorkPackageOpen] = useState(false);
  const [workPackageDirty, setWorkPackageDirty] = useState(false);
  const [workPackageBusy, setWorkPackageBusy] = useState(false);
  const [workPackageEpoch, setWorkPackageEpoch] = useState(0);
  const [runDraftContent, setRunDraftContent] = useState("");
  const [discardRunDrafts, setDiscardRunDrafts] = useState(false);
  const [runEditorEpoch, setRunEditorEpoch] = useState(0);
  const [labelsDirty, setLabelsDirty] = useState(false);
  const [labelsBusy, setLabelsBusy] = useState(false);
  const [labelsEpoch, setLabelsEpoch] = useState(0);
  const [nodeLabels, setNodeLabels] = useState<Record<string, string[]>>({});
  const [editFocus, setEditFocus] = useState<{ label: string; requestId: number }>();
  const extraDirtyRef = useRef(false); extraDirtyRef.current = invalidInput || runDraftDirty || importDirty || importBusy || labelsDirty || labelsBusy || workPackageDirty || workPackageBusy;
  const [baseRevision, setBaseRevision] = useState(0);
  const [tab, setTab] = useState("reading");
  const editing = editTabs.some((item) => item.id === tab);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const connectionRef = useRef(false);
  const [catalog, setCatalog] = useState<EngineeringCapabilityCatalog>();
  const [catalogError, setCatalogError] = useState("");
  const [preview, setPreview] = useState<EngineeringChangePreview>();
  const [reason, setReason] = useState("");
  const [modal, setModal] = useState<"create" | "save" | "archive" | "pause" | "discard" | null>(null);
  const [childTitle, setChildTitle] = useState("");
  const [childKind, setChildKind] = useState<"task" | "step">("task");
  const [pendingSelection, setPendingSelection] = useState("");
  const [pendingTab, setPendingTab] = useState<string>();
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"controlled" | "external">("controlled");
  const [owners, setOwners] = useState<Array<{ id: string; label: string; available: boolean }>>([]);
  const [ownersError, setOwnersError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [treeVisible, setTreeVisible] = useState(false);
  const [controlVisible, setControlVisible] = useState(false);
  const currentView = useRef(view); const selectedRef = useRef(new URLSearchParams(window.location.search).get("node") ?? ""); const dirtyRef = useRef(false); const baseline = useRef("");
  const generation = useRef(0); const flight = useRef(false); const pending = useRef(false); const mutating = useRef(false); const mounted = useRef(true); const refreshRef = useRef<() => Promise<void>>(async () => {});
  const installDraft = useCallback((next: EngineeringView, id: string) => {
    const node = next.document.nodes.find((item) => item.id === id) ?? next.document.nodes.find((item) => item.id === next.document.root_id)!;
    selectedRef.current = node.id; dirtyRef.current = false; baseline.current = JSON.stringify(node);
    setSelectedId(node.id); setDraft(structuredClone(node)); setBaseRevision(next.document.revision); setDirty(false); setInvalidInput(false); setPreview(undefined);
    setExpanded((current) => new Set([...current, ...(next.derived[node.id]?.path ?? []), next.document.root_id]));
  }, []);
  const installView = useCallback((next: EngineeringView) => {
    const chosen = selectEngineeringView(currentView.current, next);
    if (chosen === currentView.current) return;
    currentView.current = chosen; setView(chosen); onView?.(chosen);
    if (!dirtyRef.current && !extraDirtyRef.current) installDraft(chosen, selectedRef.current || chosen.document.root_id);
  }, [installDraft, onView]);
  useEffect(() => { if (externalView) installView(externalView); }, [externalView, installView]);
  const refresh = useCallback(async () => {
    if (flight.current || mutating.current) { pending.current = true; return; }
    flight.current = true; setRefreshing(true); const token = generation.current;
    try { const next = await api.view(); if (mounted.current && token === generation.current) { installView(next); onError?.(""); } }
    catch (cause) { if (mounted.current && token === generation.current) { const detail = cause instanceof Error ? cause.message : String(cause); setError((current) => current || detail); onError?.(detail); } }
    finally { flight.current = false; if (mounted.current) { setRefreshing(false); if (pending.current && !mutating.current) { pending.current = false; void refreshRef.current(); } } }
  }, [installView, api, onError]);
  refreshRef.current = refresh;
  const previousRefresh = useRef(refreshToken);
  useEffect(() => { if (selectedId) onSelectionChange?.(selectedId); }, [selectedId, onSelectionChange]);
  useEffect(() => { if (selectedId) onTabChange?.(selectedId, tab); }, [selectedId, tab, onTabChange]);
  useEffect(() => { if (previousRefresh.current !== refreshToken) { previousRefresh.current = refreshToken; void refresh(); } }, [refreshToken, refresh]);
  useEffect(() => { onDirtyChange?.(dirty || invalidInput || runDraftDirty || importDirty || labelsDirty || workPackageDirty); }, [dirty, invalidInput, runDraftDirty, importDirty, labelsDirty, workPackageDirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy || importBusy || labelsBusy || workPackageBusy); }, [busy, importBusy, labelsBusy, workPackageBusy, onBusyChange]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirtyRef.current || extraDirtyRef.current || mutating.current) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, []);
  const appliedFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!view || !focus || workPackageOpen || workPackageBusy || appliedFocus.current === focus.requestId) return;
    if (!view.document.nodes.some((item) => item.id === focus.nodeId)) return;
    appliedFocus.current = focus.requestId;
    if ((dirtyRef.current || extraDirtyRef.current) && focus.nodeId !== selectedRef.current) { setPendingSelection(focus.nodeId); setPendingTab(focus.tab ?? "reading"); setModal("discard"); return; }
    if (!dirtyRef.current && !extraDirtyRef.current) installDraft(view, focus.nodeId); setTab(focus.tab ?? "reading");
  }, [focus, view, installDraft, workPackageBusy, workPackageOpen]);
  useEffect(() => { document.querySelector(".eng-editor-scroll")?.scrollTo({ top: 0 }); }, [selectedId, tab]);
  useEffect(() => {
    if (!focus?.field || focus.nodeId !== selectedId || tab !== "plan") return;
    const frame = requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-edit-target]")].find(item => item.dataset.editTarget === focus.field);
      if (!target) return;
      for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      target.querySelector<HTMLElement>("textarea,input,select,button")?.focus({ preventScroll: true });
    }); return () => cancelAnimationFrame(frame);
  }, [focus, selectedId, tab]);
  useEffect(() => {
    if (!modal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setModal(null); return; }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".eng-modal");
      const controls = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') ?? []).filter((item) => item.offsetParent !== null);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [modal, busy]);
  useEffect(() => {
    mounted.current = true; void refresh(); void loadOwners();
    const stream = new EventSource("/api/events"); let timer: ReturnType<typeof setTimeout> | undefined;
    stream.onopen = () => { connectionRef.current = true; setConnected(true); onConnectionChange?.(true); void refreshRef.current(); };
    stream.onerror = () => { connectionRef.current = false; setConnected(false); onConnectionChange?.(false); };
    stream.onmessage = (event) => { try { const item = JSON.parse(event.data) as { kind?: string; data?: { kind?: string } }; if (item.kind !== "engineering" && item.data?.kind !== "engineering") return; if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 80); } catch { /* Ignore unrelated or incomplete stream entries. */ } };
    const poll = setInterval(() => { if (!document.hidden && (hasActiveExternalEngineeringRun(currentView.current) || !connectionRef.current)) void refreshRef.current(); }, 15_000);
    const visible = () => { if (!document.hidden) void refreshRef.current(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; generation.current++; connectionRef.current = false; onConnectionChange?.(false); stream.onmessage = null; stream.onopen = null; stream.onerror = null; stream.close(); if (timer) clearTimeout(timer); clearInterval(poll); document.removeEventListener("visibilitychange", visible); };
  }, [refresh, onConnectionChange]);
  async function mutate(operation: () => Promise<EngineeringView>, success: string): Promise<boolean> {
    if (mutating.current || externalBusy) return false;
    mutating.current = true; generation.current++; setBusy(true); setError(""); setMessage("");
    try { const next = await operation(); installView(next); setMessage(success); return true; }
    catch (cause) { setError(cause instanceof EngineeringApiError && cause.status === 409 ? `${cause.message}。本地编辑已保留，请载入最新版本后重新核对。` : cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { mutating.current = false; setBusy(false); if (pending.current && !flight.current) { pending.current = false; void refresh(); } }
  }
  const choose = (id: string) => { if (workPackageOpen || workPackageBusy) return; if (id === selectedRef.current) { setTab("reading"); setTreeVisible(false); return; } if (onRequestSelection) { setTreeVisible(false); onRequestSelection(id); return; } if (dirtyRef.current || extraDirtyRef.current) { setPendingSelection(id); setPendingTab("reading"); setModal("discard"); return; } if (currentView.current) installDraft(currentView.current, id); setTab("reading"); setTreeVisible(false); setMessage(""); };
  const change = (node: EngineeringNode) => { dirtyRef.current = JSON.stringify(node) !== baseline.current; setDirty(dirtyRef.current); setDraft(node); setPreview(undefined); setMessage(""); };
  async function loadOwners() { setOwnersError(""); try { const sessions = await api.sessions(); setOwners(sessions.map((session) => { const age = Date.now() - Date.parse(session.last_seen_at); const available = Number.isFinite(age) && age >= -60_000 && age <= 30 * 60 * 1000; return { id: `codex:${session.session_id}`, available, label: `${session.model || "Codex"} · ${available ? "近期已连接" : "连接已过期"} · ${session.session_id.slice(-6)}` }; })); } catch (cause) { setOwnersError(cause instanceof Error ? cause.message : String(cause)); } }
  const loadCatalog = async () => { setCatalogError(""); try { setCatalog(await api.capabilities()); } catch (cause) { setCatalogError(cause instanceof Error ? cause.message : String(cause)); } };
  const openEditor = (nextTab: string, label?: string) => { setTab(nextTab); if (label) setEditFocus({ label, requestId: Date.now() }); if (nextTab === "capabilities" && !catalog) void loadCatalog(); };
  useEffect(() => { if (tab === "reading" && draft?.capabilities.length && !catalog && !catalogError) void loadCatalog(); }, [selectedId, tab, draft?.capabilities.length, catalog, catalogError]);
  const openCreate = () => { if (externalBusy) return; if (dirty || extraDirtyRef.current) { setError("当前有尚未保存的方案、导入计划或未提交的验收、能力反馈，请先处理已有编辑，再添加子任务。"); return; } setChildTitle(""); setChildKind(draft?.kind === "project" ? "task" : "step"); setModal("create"); };
  const openImport = () => { if (externalBusy) return; if (dirty || invalidInput || runDraftDirty || labelsDirty || labelsBusy) { setError("当前有未保存的方案、标签或未提交的验收、能力反馈。请先处理已有编辑，再导入详细计划。"); return; } setImportOpen(true); };
  const openWorkPackage = () => {
    if (externalBusy || busy || importBusy || labelsBusy || workPackageBusy) return;
    if (dirty || invalidInput || runDraftDirty || importDirty || labelsDirty) { setError("请先处理已有方案、导入或验收意见，再确认本轮分工。"); return; }
    setWorkPackageOpen(true); void loadOwners();
  };
  async function commitWorkPackage(prepared: WorkPackagePreview, input: WorkPackageRequest) {
    let ok = await mutate(() => api.commitWorkPackage(prepared.token, input), "本轮分工已确认。负责人可按约定领取执行；任务尚未启动。");
    if (!ok) {
      try {
        const observed = await api.view(), receipt = workPackageCommitReceipt(observed, prepared);
        if (receipt) {
          installView(observed); const currentReceipt = workPackageCommitReceipt(currentView.current ?? observed, prepared);
          setError(""); setMessage(currentReceipt === "ready" ? "已确认收到保存记录，无需重复验证。负责人可按约定领取执行。" : "已确认收到本轮保存记录；工程之后已有新变化，请查看当前状态，无需重复提交本轮分工。"); ok = true;
        }
      } catch { /* Preserve the initial error and input; never retry the mutation. */ }
    }
    if (ok) { installDraft(currentView.current!, prepared.root_id); setWorkPackageDirty(false); setTab("plan"); }
    return ok;
  }
  async function commitImported(prepared: PlanImportPreview, importReason: string) { const ok = await mutate(() => api.commitImport(prepared.token, prepared.expected_revision, importReason), "详细计划已导入为草稿，请逐步核对负责人和验收条件"); if (ok) { setExpanded((current) => new Set([...current, ...prepared.nodes.map((item) => item.id), prepared.parent_id])); setTab("plan"); } return ok; }
  async function prepareSave() { if (!draft || externalBusy) return; if (draft.source_scope && (!draft.source_scope.root.trim() || !draft.source_scope.allow.some((value) => value.trim()) || !draft.source_scope.checks.length || draft.source_scope.checks.some((check) => !check.title.trim() || !check.args.length || check.args.every((arg) => !arg.trim()) || !Number.isInteger(check.timeout_ms ?? 30000) || (check.timeout_ms ?? 30000) < 20 || (check.timeout_ms ?? 30000) > 120000))) { setTab("bounds"); setError("请补齐实际源工程目录、允许改动范围及至少一条有用途和参数的真实 Node 检查；超时需在 20–120000 毫秒之间。"); return; } if (importDirty) { setError("还有未导入的计划草稿，请先完成导入或清空草稿，再保存当前方案。"); return; } if (invalidInput) { setTab("capabilities"); setError("请先补齐能力表单的必填内容，或修正高级 JSON 输入，再保存方案。"); return; } const invalid = document.querySelector<HTMLTextAreaElement>(".eng-editor-fields textarea:invalid"); if (invalid) { invalid.reportValidity(); setError("请先补齐能力表单的必填内容，或修正高级 JSON 输入，再保存方案。"); return; } setBusy(true); setError(""); try { setPreview(await api.preview(cleanNode(draft), baseRevision)); setDiscardRunDrafts(false); setReason(""); setModal("save"); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }
  async function save() { if (!draft || !preview || !reason.trim() || (runDraftDirty && !discardRunDrafts)) return; const clearRunDrafts = runDraftDirty && discardRunDrafts; const savedId = draft.id; if (await mutate(() => api.save(cleanNode(draft), baseRevision, reason.trim()), "方案已保存，变更影响已记录")) { installDraft(currentView.current!, savedId); if (clearRunDrafts) { setRunEditorEpoch((value) => value + 1); setRunDraftDirty(false); setRunDraftContent(""); } setModal(null); } }
  async function create() { if (!view || !draft || !childTitle.trim()) return; const previousIds = new Set(view.document.nodes.map((node) => node.id)); if (await mutate(() => api.create(draft.id, childTitle.trim(), childKind, view.document.revision), "已添加子任务，可以继续细化方案")) { const created = currentView.current!.document.nodes.find((node) => !previousIds.has(node.id)); if (created) installDraft(currentView.current!, created.id); setTab("plan"); setModal(null); } }
  const node = view?.document.nodes.find((item) => item.id === selectedId); const derived = view?.derived[selectedId];
  const projectRoot = view?.document.nodes.find(item => item.id === view.document.root_id);
  const hasWorkPackageDrafts = !!view && !!projectRoot && !view.document.runs.some(run => run.node_id === projectRoot.id) && view.document.nodes.some(item => item.parent_id === projectRoot.id && item.status === "draft");
  const latestRun = view && node ? currentNodeRun(view, node.id) : undefined;
  const awaitingRun = !!latestRun && ["queued", "running", "review"].includes(latestRun.status);
  const externalMode = !!node && !derived?.child_ids.length && (mode === "external" || !!node.source_scope || node.actions.some((action) => action.type === "agent_artifact"));
  const ownerAvailable = !!node && owners.some((owner) => owner.id === node.owner && owner.available);
  const titleFor = (id: string, fallback = id) => { const item = view?.document.nodes.find((candidate) => candidate.id === id); return item ? engineeringNodeName(item, nodeNames) : fallback; };
  const displayed: Array<{ node: EngineeringNode; depth: number; children: EngineeringNode[] }> = [];
  const visibleIds = new Set<string>();
  if (view && query.trim()) for (const item of view.document.nodes) if (`${engineeringNodeName(item, nodeNames)} ${item.title} ${item.objective} ${item.owner} ${(nodeLabels[item.id] ?? []).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())) for (const id of [...(view.derived[item.id]?.path ?? []), item.id]) visibleIds.add(id);
  const walk = (parentId: string | null, depth: number) => { if (!view) return; for (const item of ordered(view.document.nodes.filter((candidate) => candidate.parent_id === parentId && (showArchived || candidate.status !== "archived")))) { if (query.trim() && !visibleIds.has(item.id)) continue; const children = view.document.nodes.filter((candidate) => candidate.parent_id === item.id && (showArchived || candidate.status !== "archived")); displayed.push({ node: item, depth, children }); if (expanded.has(item.id) || query) walk(item.id, depth + 1); } };
  walk(null, 0);
  const toggleExpanded = (id: string) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const dirtyNotice = dirty && view && view.document.revision !== baseRevision;
  return <div className={`engineering-workspace ${embedded ? "is-embedded" : ""} ${inlineDetail ? "is-inline-detail" : ""} ${controlVisible ? "controls-open" : ""}`} role="region" aria-label="工程工作台">
    {!embedded && <header className="eng-appbar"><div className="eng-brand"><span className="eng-brand-symbol" aria-hidden="true">映</span><strong>Mirror <span>映构</span></strong><span className="eng-brand-divider">/</span><span>工程工作台</span></div><div className="eng-appbar-actions"><button type="button" onClick={() => { if ((!dirtyRef.current && !extraDirtyRef.current) || window.confirm("当前编辑尚未保存，离开并返回任务列表？")) window.location.assign("/"); }}>所有任务</button><span className={`eng-live ${connected ? "" : "is-offline"}`}><i />{connected ? "实时同步" : "实时连接中断"}</span><button type="button" disabled={externalBusy || refreshing || busy} onClick={() => { setError(""); void refresh(); }}>{refreshing ? "同步中…" : "刷新"}</button>{onOpenLegacy && <button type="button" onClick={onOpenLegacy}>历史工作台 ↗</button>}</div></header>}
    {embedded && <div className="eng-embedded-toolbar"><button type="button" onClick={() => setTreeVisible((value) => !value)} aria-expanded={treeVisible}>步骤树</button><span className={`eng-live ${connected ? "" : "is-offline"}`}><i />{connected ? "实时同步" : "连接中断，请刷新"}</span><button type="button" disabled={externalBusy || refreshing || busy} onClick={() => { setError(""); void refresh(); }}>{refreshing ? "同步中…" : "刷新工程"}</button><button type="button" className="eng-primary" aria-expanded={controlVisible} onClick={() => setControlVisible((value) => !value)}>执行调度</button></div>}
    {!view ? <div className="eng-loading" role={error ? "alert" : "status"}><h1>{error ? "暂时无法载入工程" : "正在读取工程计划…"}</h1><p>{error || "正在准备任务树、约束和运行状态。"}</p>{error && <button type="button" onClick={() => { setError(""); void refresh(); }}>重试</button>}</div> : <>
      <div className="eng-workspace-body" inert={workPackageOpen}>
        <aside className={`eng-tree-pane ${treeVisible ? "is-open" : ""}`} aria-label="项目任务树"><div className="eng-project-heading"><span className="eng-eyebrow">当前项目</span><h1>{titleFor(view.document.root_id)}</h1><p>{view.derived[view.document.root_id]?.counts.accepted ?? 0} / {view.derived[view.document.root_id]?.counts.total ?? 0} 项已验收</p></div><div className="eng-tree-tools"><input aria-label="搜索任务" type="search" placeholder="查找任务、负责人、标签…" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className="eng-mobile-close" onClick={() => setTreeVisible(false)}>关闭任务树</button></div><div role="tree" aria-label="工程任务" className="eng-tree">{displayed.map(({ node: item, depth, children }, index) => <div key={item.id} role="treeitem" aria-level={depth + 1} aria-selected={selectedId === item.id} aria-expanded={children.length ? expanded.has(item.id) || !!query : undefined} tabIndex={selectedId === item.id ? 0 : -1} className={`eng-tree-row ${selectedId === item.id ? "is-selected" : ""}`} style={{ paddingLeft: `${12 + Math.min(depth, 4) * 12}px` }} onClick={() => choose(item.id)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(item.id); } else if (event.key === "ArrowRight" && children.length) { event.preventDefault(); setExpanded((current) => new Set([...current, item.id])); } else if (event.key === "ArrowLeft") { event.preventDefault(); if (expanded.has(item.id)) toggleExpanded(item.id); else if (item.parent_id) choose(item.parent_id); } else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const target = event.currentTarget.parentElement?.children[index + (event.key === "ArrowDown" ? 1 : -1)] as HTMLElement | undefined; target?.focus(); } }}><button type="button" tabIndex={-1} className="eng-tree-disclosure" aria-label={`${expanded.has(item.id) ? "收起" : "展开"} ${engineeringNodeName(item, nodeNames)}`} disabled={!children.length} onClick={(event) => { event.stopPropagation(); toggleExpanded(item.id); }}>{children.length ? expanded.has(item.id) || query ? "⌄" : "›" : "·"}</button><span className={`eng-tree-state is-${view.derived[item.id]?.status ?? item.status}`} aria-label={nodeStatusLabel(view, item)} /><span className="eng-tree-title" title={engineeringNodeName(item, nodeNames)}>{engineeringNodeName(item, nodeNames)}</span>{children.length > 0 && <small>{children.length}</small>}</div>)}</div><div className="eng-tree-footer"><label className="eng-check-row"><input type="checkbox" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); if (!event.target.checked && node?.status === "archived") choose(node.parent_id ?? view.document.root_id); }} /><span>显示已归档任务</span></label><button type="button" disabled={externalBusy || busy || dirty || invalidInput || runDraftDirty || node?.status === "archived"} onClick={openCreate}>＋ 在当前任务下添加</button><p>目标可以逐层拆分，深度不限。</p></div></aside>
        {node && draft && derived && <section className="eng-main-pane" aria-label="当前任务详情"><div className="eng-node-header"><nav className="eng-breadcrumb" aria-label="任务路径">{!embedded && <button type="button" className="eng-mobile-tree" onClick={() => setTreeVisible(true)}>☰ 任务树</button>}{derived.path.filter((id) => id !== node.id).map((id) => <span key={id}><button type="button" onClick={() => choose(id)}>{titleFor(id)}</button><span aria-hidden="true"> / </span></span>)}<span>{kindNames[node.kind]}</span></nav><div className="eng-title-line"><h1>{engineeringNodeName(node, nodeNames)}</h1><span className={`eng-status is-${derived.status}`}>{nodeStatusLabel(view, node)}</span></div><p className="eng-node-subtitle">{owners.find((owner) => owner.id === node.owner)?.label ?? (node.owner.startsWith("codex:") ? "已分配的 Codex 会话" : node.owner || "未分配")} <span>·</span> {derived.child_ids.length ? `${derived.child_ids.length} 个直接子任务` : "可继续拆分的执行单元"} <span>·</span> 更新于 {timeLabel(node.updated_at)}</p><NodeLabelsEditor key={`${api.workspaceId ?? "host"}:${selectedId}:${labelsEpoch}`} workspaceId={api.workspaceId ?? "host"} nodeId={selectedId} resetKey={labelsEpoch} disabled={externalBusy || busy || node.status === "archived"} onDirty={setLabelsDirty} onBusy={setLabelsBusy} onLabels={setNodeLabels} /></div>
          <div className="eng-task-tabs" role="tablist" aria-label="任务工作区">{mainTabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === "edit" ? editing : tab === item.id} onClick={() => setTab(item.id === "edit" ? "plan" : item.id)}>{item.label}</button>)}</div>{editing && <div className="eng-task-tabs eng-edit-tabs" role="tablist" aria-label="修改方案段落">{editTabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => openEditor(item.id)}>{item.label}</button>)}</div>}
          {(error || message || dirtyNotice) && <div className="eng-message-stack">{error && <div role="alert" className="eng-banner is-error"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div>}{message && <div role="status" className="eng-banner is-success">{message}</div>}{dirtyNotice && <div className="eng-banner">工程已有新变更，当前编辑仍保留。保存前请核对最新版本。<button type="button" onClick={() => { setPendingSelection(selectedId); setPendingTab(undefined); setModal("discard"); }}>载入最新版本</button></div>}</div>}
          <div className="eng-editor-scroll" role="tabpanel" aria-label={[...editTabs, ...mainTabs].find((item) => item.id === tab)?.label}>
            {tab === "reading" && <StepReadingView node={node} view={view} nodeNames={nodeNames} catalog={catalog} catalogError={catalogError} owners={owners} dirty={dirty || invalidInput} onEdit={openEditor} onSelect={choose} onRuns={() => setTab("runs")} onControls={() => setControlVisible(true)} />}
            {tab === "plan" && node.id === view.document.root_id && (hasWorkPackageDrafts || workPackageDirty) && <section className="eng-work-package-entry"><h3>本轮分工，一次确认</h3><p className="eng-muted">把整体配合、每项负责人和开工检查合在一起；确认后按约定领取执行。</p><button type="button" className="eng-primary" disabled={externalBusy || busy || importBusy || labelsBusy} onClick={openWorkPackage}>确认本轮分工并开工</button>{workPackageDirty && <p className="eng-notice">上次输入已保留，可以继续核对。</p>}</section>}{tab === "plan" && <section className="eng-section eng-import-entry"><div><h3>把详细计划一次接入任务树</h3><p className="eng-muted">粘贴或上传 Agent 构思的步骤，先看清层级、做法、约束和验收，再确认新增。</p>{importDirty && <p className="eng-notice">有尚未导入的计划输入，重新打开可继续。</p>}</div><button type="button" disabled={externalBusy || busy || node.status === "archived"} onClick={openImport}>导入详细计划</button></section>}
            <div hidden={!["plan", "bounds", "criteria", "actions", "capabilities"].includes(tab)}><PlanEditor key={selectedId} node={draft} view={view} nodeNames={nodeNames} tab={tab} focusField={editFocus} disabled={externalBusy || busy || node.status === "archived"} owners={owners} ownersError={ownersError} onOwners={() => void loadOwners()} onInvalidInput={setInvalidInput} catalog={catalog} catalogError={catalogError} onCatalog={() => void loadCatalog()} onChange={change} onSelect={choose} onCreate={openCreate} /></div>
            <div hidden={tab !== "runs"}><RunPanel key={`${selectedId}:${runEditorEpoch}`} api={api} onDraftDirtyChange={setRunDraftDirty} onDraftContentChange={setRunDraftContent} node={node} view={view} busy={externalBusy || busy || dirty || node.status === "archived"} onMutation={mutate} onSelect={choose} /></div>
            {tab === "history" && <section className="eng-section"><h2>方案变更与执行记录</h2><p className="eng-muted">历史记录与证据持续保留；更新方案不会改写过去的运行。</p>{view.document.changes.filter((item) => item.node_id === selectedId || item.affected_ids.includes(selectedId)).slice().reverse().map((item) => <div className="eng-history-item" key={item.id}><time>{timeLabel(item.at)}</time><strong>{item.reason}</strong><p>{titleFor(item.node_id)} · 影响 {item.affected_ids.length} 项任务</p><details><summary>查看前后方案</summary><div className="eng-field-row"><div><h3>变更前</h3><p className="eng-preserve">{item.before.title}<br />{item.before.objective}<br />{item.before.method}</p></div><div><h3>变更后</h3><p className="eng-preserve">{item.after.title}<br />{item.after.objective}<br />{item.after.method}</p></div></div></details></div>)}{view.document.events.filter((item) => item.node_id === selectedId).slice().reverse().map((item) => <div className="eng-history-item" key={item.id}><time>{timeLabel(item.at)}</time><p>{item.message}</p>{item.detail && <small className="eng-preserve">{item.detail}</small>}</div>)}{!view.document.events.some((item) => item.node_id === selectedId) && !view.document.changes.some((item) => item.node_id === selectedId || item.affected_ids.includes(selectedId)) && <p className="eng-empty-inline">这个任务还没有历史变更。</p>}</section>}
          </div>{(editing || dirty || invalidInput || runDraftDirty || importDirty || labelsDirty || workPackageDirty) && <footer className={`eng-save-bar ${dirty ? "is-dirty" : ""} ${editing ? "" : "is-reading"}`}><span>{dirty ? "有尚未保存的方案修改" : runDraftDirty ? "验收意见或能力反馈尚未提交" : importDirty ? "有尚未导入的计划草稿" : workPackageDirty ? "本轮分工输入已保留，尚未确认" : invalidInput ? "有尚未完整的能力输入" : labelsDirty ? "内容标签尚未保存" : "方案已保存"}</span><div className="eng-inline-actions"><button type="button" disabled={externalBusy || !dirty || busy} onClick={() => { setPendingSelection(selectedId); setPendingTab(undefined); setModal("discard"); }}>放弃修改</button><button type="button" className="eng-primary" disabled={externalBusy || !dirty || busy} onClick={() => void prepareSave()}>{busy ? "处理中…" : "预览影响并保存"}</button></div></footer>}
        </section>}
        {node && derived && <aside className="eng-context-pane" aria-label="执行调度">{embedded && <div className="eng-control-heading"><strong>执行与调度</strong><button type="button" onClick={() => setControlVisible(false)}>收起</button></div>}<section className="eng-context-section"><span className="eng-eyebrow">执行控制</span><h2>从计划走向结果</h2><p className="eng-muted">先检查方案，再按已确认的动作执行。</p><div className="eng-control-actions">{node.id === view.document.root_id && (hasWorkPackageDrafts || workPackageDirty) && <button type="button" className="eng-primary" disabled={externalBusy || busy || importBusy || labelsBusy} onClick={openWorkPackage}>确认本轮分工并开工</button>}<button type="button" disabled={externalBusy || busy || dirty || invalidInput || awaitingRun || ["running", "review", "accepted", "archived"].includes(node.status)} onClick={() => void mutate(() => api.ready(node.id, view.document.revision), "方案检查通过，可以加入执行队列")}>检查方案就绪</button><button type="button" className="eng-primary" disabled={externalBusy || busy || dirty || invalidInput || awaitingRun || node.status !== "ready" || (externalMode && !ownerAvailable)} onClick={() => { void mutate(() => api.dispatch([node.id], externalMode ? "external" : "controlled", view.document.revision), externalMode ? "方案已冻结，等待真实负责人领取" : "任务已提交执行调度").then((ok) => { if (ok) { setTab("runs"); setControlVisible(false); } }); }}>{derived.child_ids.length ? "开始整合检查" : externalMode ? "冻结并交给负责人" : derived.can_run ? "开始执行" : "加入执行队列"}</button>{["running", "ready", "blocked"].includes(node.status) && <button type="button" disabled={externalBusy || busy || dirty || invalidInput || runDraftDirty || importDirty} onClick={() => { setReason(""); setModal("pause"); }}>暂停当前任务链</button>}</div>{externalMode && !ownerAvailable && <p className="eng-notice">协作派发需要最近 30 分钟内已连接的真实 Codex 负责人。手填名称与历史会话不能接单。<button type="button" className="eng-text-button" onClick={() => { setTab("plan"); setControlVisible(false); void loadOwners(); }}>核对负责人并刷新会话 →</button></p>}{awaitingRun && <button type="button" className="eng-text-button" onClick={() => { setTab("runs"); setControlVisible(false); }}>查看当前运行与交接 →</button>}{dirty && <p className="eng-notice">保存当前编辑后才能执行或验收。</p>}{invalidInput && <p className="eng-notice">能力输入尚未完整。<button type="button" className="eng-text-button" onClick={() => { setTab("capabilities"); if (!catalog) void loadCatalog(); }}>前往补齐能力内容 →</button></p>}<details className="eng-disclosure"><summary>执行方式</summary><label><select aria-label="执行方式" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="controlled">受控执行 · 自动依次执行动作</option><option value="external">协作执行 · 交接给真实负责人</option></select></label><p className="eng-muted">受控执行自动处理已保存动作；协作执行先冻结交接，真实负责人领取后再提交产出。交付文件使用相同的范围校验。包含 Agent 产出或源工程核验时自动使用协作执行。</p></details></section>
          <section className="eng-context-section"><h3>当前等待条件</h3>{derived.blockers.length ? <ul className="eng-blockers">{derived.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul> : <p className="eng-success-text">没有前置阻塞</p>}{derived.uncovered_criteria.length > 0 && <p className="eng-notice">有 {derived.uncovered_criteria.length} 条上级验收条件尚未分配给子任务。</p>}</section>
          <section className="eng-context-section"><h3>所有任务共享的执行队列</h3><div className="eng-scheduler"><strong>{view.scheduler.active}<small> / {view.scheduler.max_parallel}</small></strong><span>正在执行</span><b>{view.scheduler.queued}</b><span>正在等待</span></div><p className="eng-muted">独立任务可以并行；前置结果、相同写入范围或共享资源会等待。</p><details className="eng-disclosure"><summary>选择多个任务加入队列</summary>{view.document.nodes.filter((item) => item.status === "ready" && !view.document.runs.some((run) => run.id === view.derived[item.id]?.latest_run_id && ["queued", "running", "review"].includes(run.status))).map((item) => <label key={item.id} className="eng-check-row"><input type="checkbox" checked={queuedIds.includes(item.id)} onChange={(event) => setQueuedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span>{engineeringNodeName(item, nodeNames)}</span></label>)}{!view.document.nodes.some((item) => item.status === "ready") && <p className="eng-empty-inline">暂时没有检查就绪的任务。</p>}<button type="button" disabled={externalBusy || busy || dirty || queuedIds.length === 0} onClick={() => void mutate(() => api.dispatch(queuedIds.filter((id) => view.document.nodes.some((item) => item.id === id && item.status === "ready")), view.document.nodes.some((item) => queuedIds.includes(item.id) && (!!item.source_scope || item.actions.some((action) => action.type === "agent_artifact"))) ? "external" : mode, view.document.revision), "所选任务已加入队列").then((ok) => { if (ok) setQueuedIds([]); })}>加入所选 {queuedIds.length} 项</button></details></section>
          <section className="eng-context-section eng-context-bottom"><h3>继承规则</h3>{derived.effective.rules.slice(0, 3).map((rule, index) => <p className="eng-context-rule" key={index}>{rule.text}<small>来自 {titleFor(rule.node_id, rule.title)}</small></p>)}{derived.effective.rules.length === 0 && <p className="eng-muted">尚未设置规则</p>}<button type="button" className="eng-text-button" onClick={() => setTab("bounds")}>查看完整约束 →</button>{node.parent_id !== null && <details className="eng-disclosure"><summary>任务管理</summary><button type="button" className="eng-danger" disabled={externalBusy || busy || dirty || invalidInput || runDraftDirty || importDirty || node.status === "archived"} onClick={() => { setReason(""); setModal("archive"); }}>归档当前任务</button><p className="eng-muted">保留历史；有活动子项或被依赖的任务无法归档。</p></details>}</section>
        </aside>}
      </div>
    </>}
    {node && view && <PlanImportDialog key={`${selectedId}:${importEpoch}`} open={importOpen} api={api} parent={node} revision={view.document.revision} onClose={() => setImportOpen(false)} onDirtyChange={setImportDirty} onBusyChange={setImportBusy} onCommit={commitImported} />}
    {view && projectRoot && (workPackageOpen || workPackageDirty) && <WorkPackageDialog key={`${api.workspaceId ?? "host"}:${projectRoot.id}:${workPackageEpoch}`} open={workPackageOpen} api={api} root={projectRoot} view={view} owners={owners} ownersError={ownersError} onOwners={loadOwners} disabled={externalBusy || busy || importBusy || labelsBusy} onClose={() => setWorkPackageOpen(false)} onDirtyChange={setWorkPackageDirty} onBusyChange={setWorkPackageBusy} onCommit={commitWorkPackage} />}
    {modal && <div className="eng-modal-backdrop"><section className="eng-modal" role="dialog" aria-modal="true" aria-label={modal === "create" ? "添加子任务" : modal === "save" ? "确认方案变更" : modal === "discard" ? "当前编辑尚未保存" : modal === "archive" ? "归档任务" : "暂停任务链"}>
      {modal === "create" && <><h2>添加子任务</h2><p>在「{node ? engineeringNodeName(node, nodeNames) : ""}」下继续拆分。创建后可以逐项补充方案。</p><label>子任务名称<input autoFocus value={childTitle} onChange={(event) => setChildTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && childTitle.trim()) void create(); }} /></label><label>类型<select value={childKind} onChange={(event) => setChildKind(event.target.value as typeof childKind)}><option value="task">任务</option><option value="step">步骤</option></select></label><div className="eng-modal-actions"><button type="button" disabled={externalBusy || busy} onClick={() => setModal(null)}>取消</button><button type="button" className="eng-primary" disabled={externalBusy || busy || !childTitle.trim()} onClick={() => void create()}>创建并细化</button></div></>}
      {modal === "save" && preview && <><h2>确认方案变更</h2><p>变更将影响以下任务。已有运行保留，失效结果需要重新执行与验收。</p><ul>{preview.reasons.map((item) => <li key={item}>{item}</li>)}</ul><div className="eng-impact-list">{preview.affected_ids.map((id) => <span key={id}>{titleFor(id)}</span>)}{preview.affected_ids.length === 0 && <span>没有关联任务受到影响</span>}</div><p>{preview.running_ids.length} 项正在运行 · {preview.invalidated_run_ids.length} 次运行结果将失效</p>{preview.classification && <p>这次修改：{{ none: "没有实质变化", presentation: "展示调整", permissions: "权限边界变化", contract: "交付约定变化" }[preview.classification]}。</p>}{preview.impact?.length ? <details open><summary>为什么影响这些部分</summary><ul className="eng-impact-explanation">{preview.impact.map(item => <li key={item.node_id}><strong>{titleFor(item.node_id)} · {{ needs_revision: "需要修改", needs_recheck: "需要复验", unaffected: "仍然有效" }[item.disposition]}</strong><p>{item.reason}</p><small>{item.path.map(id => titleFor(id)).join(" → ")}</small></li>)}</ul><p className="eng-muted">未列出的部分不等于已证明完全无影响；关系尚未说明的内容仍需核对。</p></details> : null}{preview.warnings.map((warning) => <p className="eng-notice" key={warning}>{warning}</p>)}<label>为什么调整方案<textarea autoFocus rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="记录调整目的，便于后续理解。" /></label>{runDraftDirty && <section className="eng-notice" aria-label="未提交意见的处理"><strong>以下意见尚未提交</strong><p className="eng-preserve">{runDraftContent}</p><p>它们不属于方案内容。保存新方案后，相关旧运行需要重新核对，这些未提交意见会被放弃。返回编辑可以保留当前内容。</p><label className="eng-check-row"><input type="checkbox" checked={discardRunDrafts} onChange={(event) => setDiscardRunDrafts(event.target.checked)} disabled={externalBusy || busy} /><span>同时放弃这些未提交的验收意见与能力反馈</span></label></section>}<div className="eng-modal-actions"><button type="button" disabled={externalBusy || busy} onClick={() => setModal(null)}>返回编辑</button><button type="button" className="eng-primary" disabled={externalBusy || busy || !reason.trim() || (runDraftDirty && !discardRunDrafts)} onClick={() => void save()}>确认保存变更</button></div></>}
      {modal === "discard" && <><h2>当前编辑尚未保存</h2><p>继续会放弃当前未保存的方案、内容标签或未提交的意见，并载入已保存内容。</p><div className="eng-modal-actions"><button type="button" onClick={() => { setModal(null); setTreeVisible(false); }}>继续编辑</button><button type="button" className="eng-danger" onClick={() => { if (currentView.current) installDraft(currentView.current, pendingSelection || selectedId); setRunEditorEpoch((value) => value + 1); setRunDraftDirty(false); setImportEpoch((value) => value + 1); setImportDirty(false); setImportOpen(false); setWorkPackageEpoch(value => value + 1); setWorkPackageDirty(false); setWorkPackageOpen(false); setLabelsDirty(false); setLabelsEpoch((value) => value + 1); if (pendingTab) setTab(pendingTab); setPendingTab(undefined); setModal(null); setTreeVisible(false); }}>放弃编辑并继续</button></div></>}
      {(modal === "archive" || modal === "pause") && <><h2>{modal === "archive" ? "归档任务" : "暂停当前任务链"}</h2><p>{modal === "archive" ? "归档后任务从活动树移除，历史方案与证据保留。" : "当前任务及依赖链会暂停；互不依赖的任务可以继续。"}</p><label>原因<textarea autoFocus rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="eng-modal-actions"><button type="button" disabled={externalBusy || busy} onClick={() => setModal(null)}>取消</button><button type="button" disabled={externalBusy || busy || !reason.trim()} className="eng-danger" onClick={() => { if (!node || !view) return; const action = modal; void mutate(() => action === "archive" ? api.archive(node.id, view.document.revision, reason) : api.pause(node.id, reason), action === "archive" ? "任务已归档" : "任务链已暂停").then((ok) => { if (ok) { if (action === "archive") installDraft(currentView.current!, node.parent_id ?? view.document.root_id); setModal(null); } }); }}>{modal === "archive" ? "确认归档" : "确认暂停"}</button></div></>}
      {error && <p className="eng-inline-error" role="alert">{error}</p>}
    </section></div>}
  </div>;
}
