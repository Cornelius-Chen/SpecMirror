import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, Folder, GitBranch, MessageSquare, PanelLeftClose, PanelLeftOpen, RefreshCw, Search } from "lucide-react";
import type { EngineeringNode, EngineeringView } from "@epm/domain";
import { createEngineeringApi } from "../engineering-api.ts";
import { EngineeringWorkspace, type EngineeringFocus } from "./EngineeringWorkspace.tsx";
import { statusNames, timeLabel } from "./engineering/shared.ts";
import { createTaskPresentationApi, subscribeTaskPresentation, TaskPresentationApiError, type TaskPresentationOperation, type TaskPresentationView } from "../task-presentation-api.ts";
import { TaskCollections, type TaskCollectionDialog } from "./TaskCollections.tsx";
import { ProjectStructureMap } from "./project-map/ProjectStructureMap.tsx";
import { FeedbackPanel } from "./project-map/FeedbackPanel.tsx";
import { GraphFeedbackCard } from "./project-map/GraphFeedbackCard.tsx";
import type { EngineeringFeedback, EngineeringFeedbackTarget } from "../../../../packages/domain/src/engineering-feedback.ts";
import { ProjectNodeInspector } from "./project-map/ProjectNodeInspector.tsx";
import { StructureProposalReview } from "./engineering/StructureProposalReview.tsx";
import { RecheckWorkPackageDialog } from "./engineering/RecheckWorkPackageDialog.tsx";
import { recheckWorkPackageCandidates } from "./engineering/recheck-work-package-state.ts";
import { NodeNameDialog } from "./engineering/NodeNameDialog.tsx";
import { CodexRunPlanOverlay } from "./CodexRunPlanOverlay.tsx";
import { ConnectedTaskList } from "./ConnectedTaskList.tsx";
import { CodexReadinessPanel } from "./Workspaces.tsx";
import { loadRunPlanProjections, loadTaskRunPlanProjections, type RunPlanProjection } from "../run-plan-api.ts";
import { fetchWithHumanApproval } from "../human-approval-client.ts";
import { detailTab, readProjectRoute, restoreProjectBrowsing, revealProjectNode, type ProjectBrowsingState } from "./project-map/navigation.ts";
import { readCurrentProject, rememberCurrentProject, restoreCurrentProject } from "./project-map/current-project.ts";
import { expireEngineeringObservations, hasActiveExternalEngineeringRun, selectEngineeringView } from "./engineering/workspace-state.ts";
import type { ProjectDetailTab, ProjectMapNavigationIntent } from "./project-map/types.ts";
import { projectNodeRunPlanActivities } from "./project-map/run-plan-activity.ts";
import "../unified-task-workspace.css";

type Task = { id: string; title: string; cwd: string; updatedAt: number; pinned: boolean; version: string; received: boolean; receivedAt: string | null };
type Detail = Task & { preview: string; token: string; historyUnavailable: boolean; nextCursor: string | null; turns: Array<{ id: string; status: string; messages: Array<{ role: string; text: string }> }> };
type AttentionCounts = { review: number; running: number; blocked: number };
export type TaskWorkspaceSummary = { id: string; thread_id: string | null; title: string; source_cwd: string; kind: "existing" | "managed"; root_node_id: string; revision: number; status: string; counts: { total: number; accepted: number; review: number; running: number; blocked: number }; attention_counts?: AttentionCounts; updated_at: string };
const attentionCounts = (workspace?: TaskWorkspaceSummary): AttentionCounts => workspace?.attention_counts ?? {
  review: Math.max(workspace?.counts.review ?? 0, workspace?.status === "review" ? 1 : 0),
  running: Math.max(workspace?.counts.running ?? 0, workspace?.status === "running" ? 1 : 0),
  blocked: Math.max(workspace?.counts.blocked ?? 0, ["blocked", "needs_revision", "paused"].includes(workspace?.status ?? "") ? 1 : 0)
};
type Surface = "map" | "conversation";
type CanvasMode = "embedded" | "focus";
type CanvasDensity = "auto" | "overview" | "structure" | "detail";
type RunPlanTransportState = "connecting" | "live" | "offline";
type RunPlanScopeSnapshot = { projections: RunPlanProjection[]; receivedAt: string };
const isProjectless = (cwd: string) => /[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}[\\/]/i.test(cwd);
const projectName = (cwd: string) => isProjectless(cwd) ? "独立任务" : cwd.split(/[\\/]/).filter(Boolean).at(-1) || "独立任务";
// Directory identity stays separate from its short display name, including same-name projects.
const projectKey = (cwd: string) => { const path = cwd.trim().replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, ""); return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLocaleLowerCase("en-US") : path; };
const dateLabel = (value: number) => new Date(value * 1000).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const workspaceErrors: Record<string, string> = { task_workspace_source_stale: "Codex 任务已有更新，请刷新任务后重新关联。", task_inbox_version_conflict: "Codex 任务已有更新，请刷新任务后重新关联。", task_workspace_existing_linked: "现有工程已关联其他任务，请刷新查看，或为此任务建立独立计划。", task_workspace_thread_already_linked: "此任务已有工程关联，请刷新查看。" };
async function request<T>(url: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const init: RequestInit = { signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) };
  const response = body === undefined
    ? await fetch(url, init)
    : await fetchWithHumanApproval(url, init, { method: "POST", url, workspace: "host", body });
  const result = await response.json();
  if (!response.ok) throw new Error(workspaceErrors[result.error] || result.error || `请求未完成（${response.status}），请重试。`);
  return result as T;
}

export function UnifiedTaskWorkspace() {
  const initial = useRef(readProjectRoute(new URLSearchParams(location.search)));
  const initialCanvas = useRef(new URLSearchParams(location.search));
  const [selected, setSelected] = useState(initial.current.taskId);
  const [surface, setSurface] = useState<Surface>(initial.current.surface);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>(initialCanvas.current.get("canvas") === "focus" ? "focus" : "embedded");
  const initialDensity = initialCanvas.current.get("density");
  const [canvasDensity, setCanvasDensity] = useState<CanvasDensity>(["overview", "structure", "detail"].includes(initialDensity ?? "") ? initialDensity as CanvasDensity : "auto");
  const [tasks, setTasks] = useState<Task[]>([]), [workspaces, setWorkspaces] = useState<TaskWorkspaceSummary[]>([]);
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [archived, setArchived] = useState(false), [filter, setFilter] = useState("all");
  const [grouping, setGrouping] = useState<"project" | "collection">("project"), [collectionFilter, setCollectionFilter] = useState("all");
  const completeCatalog = filter !== "all" || grouping === "collection";
  const [cursor, setCursor] = useState<string | null>(null), [syncedAt, setSyncedAt] = useState(""), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false), [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [error, setError] = useState(""), [workspaceError, setWorkspaceError] = useState(""), [operationError, setOperationError] = useState("");
  const [detail, setDetail] = useState<Detail>(), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState("");
  const [snapshot, setSnapshot] = useState<{ scope: string; view: EngineeringView }>(), [engineeringError, setEngineeringError] = useState("");
  const [collapsed, setCollapsed] = useState(false), [mobileListOpen, setMobileListOpen] = useState(false);
  const [collectionDialog, setCollectionDialog] = useState<TaskCollectionDialog | null>(null);
  const [presentation, setPresentation] = useState<TaskPresentationView>(), [presentationLoading, setPresentationLoading] = useState(true), [presentationError, setPresentationError] = useState("");
  const [phasePresentation, setPhasePresentation] = useState<TaskPresentationView>(), [phaseError, setPhaseError] = useState("");
  const [nameDialog, setNameDialog] = useState<{ node: EngineeringNode; workspaceId: string; presentation: TaskPresentationView }>();
  const presentationApi = useMemo(() => createTaskPresentationApi(), []), presentationGeneration = useRef(0), phaseGeneration = useRef(0);
  const [linkMode, setLinkMode] = useState<"create" | "link_existing" | null>(null), [linking, setLinking] = useState(false), [receiving, setReceiving] = useState(false);
  const [editorDirty, setDirty] = useState(false), [editorBusy, setEditorBusy] = useState(false), [leaveDialog, setLeaveDialog] = useState(false), [editorEpoch, setEditorEpoch] = useState(0);
  const [feedbackBusy, setFeedbackBusy] = useState(false), [structureBusy, setStructureBusy] = useState(false);
  const [recordBusy, setRecordBusy] = useState(false), [recordDirty, setRecordDirty] = useState(false);
  const [recordsVisible, setRecordsVisible] = useState(false), [recordsOpened, setRecordsOpened] = useState(false);
  const [codexGateOpen, setCodexGateOpen] = useState(false);
  const [recheckScope, setRecheckScope] = useState<string | null>(null);
  const [recordRequest, setRecordRequest] = useState<{ target: EngineeringFeedbackTarget; sequence: number; feedbackId?: string }>();
  const busy = editorBusy || feedbackBusy || recordBusy || structureBusy || recheckScope !== null;
  const [connectionAvailable, setConnectionAvailable] = useState(false), [observationAt, setObservationAt] = useState(Date.now);
  const [feedbackDirty, setFeedbackDirty] = useState(false);
  const [feedbackTarget, setFeedbackTarget] = useState<{ target: EngineeringFeedbackTarget; scopeNodeIds?: readonly string[]; feedbackId?: string; sequence: number }>();
  const dirty = editorDirty || feedbackDirty || recordDirty;
  const [focus, setFocus] = useState<EngineeringFocus | undefined>(initial.current.nodeId ? { nodeId: initial.current.nodeId, tab: initial.current.tab ?? "reading", requestId: 1 } : undefined);
  const [browsing, setBrowsing] = useState<ProjectBrowsingState>();
  const [structurePreviewScope, setStructurePreviewScope] = useState<string | null>(null);
  const [runPlanSnapshots, setRunPlanSnapshots] = useState<Record<string, RunPlanScopeSnapshot>>({});
  const [runPlanRequest, setRunPlanRequest] = useState<{ scope: string; mode: "initial" | "refresh" }>();
  const [runPlanFailure, setRunPlanFailure] = useState<{ scope: string; message: string }>();
  const [runPlanTransport, setRunPlanTransport] = useState<RunPlanTransportState>("connecting");
  const routeConsumed = useRef(false), navigationSequence = useRef(1);
  const lastDetailTab = useRef<ProjectDetailTab>(initial.current.tab ?? "reading");
  const recordAnchor = useRef<HTMLDivElement>(null);
  const pendingNavigation = useRef<(() => void) | null>(null), selection = useRef(selected), generation = useRef(0), detailGeneration = useRef(0), workspaceReadGeneration = useRef(0);
  const runPlanReadGeneration = useRef(0), runPlanReadController = useRef<AbortController | null>(null), runPlanSnapshotsRef = useRef<Record<string, RunPlanScopeSnapshot>>({});
  selection.current = selected;
  const existing = workspaces.find((workspace) => workspace.kind === "existing");
  const workspace = selected === "@existing" ? existing : workspaces.find((item) => item.thread_id === selected);
  useEffect(() => {
    // Wait for the authoritative catalog. Explicit task routes always take precedence.
    if (selected || workspaceLoading || workspaceError) return;
    const restored = restoreCurrentProject(workspaces, readCurrentProject());
    if (restored) setSelected(restored);
  }, [selected, workspaceLoading, workspaceError, workspaces]);
  useEffect(() => {
    if (workspace && !workspaceLoading && !workspaceError) rememberCurrentProject(workspace);
  }, [workspace?.id, workspace?.thread_id, workspaceLoading, workspaceError]);
  const task = tasks.find((item) => item.id === selected) || (detail?.id === selected ? detail : undefined);
  const scopedApi = useMemo(() => createEngineeringApi(workspace?.id), [workspace?.id]);
  useEffect(() => { setStructurePreviewScope(null); setFeedbackTarget(undefined); setRecordsVisible(false); setRecordsOpened(false); setRecordRequest(undefined); }, [workspace?.id]);
  const phaseApi = useMemo(() => createTaskPresentationApi(workspace?.id), [workspace?.id]);
  const activeScope = useRef(workspace?.id); activeScope.current = workspace?.id;
  // Runtime observation is scoped independently of engineering authority. Never
  // fall back to another workspace just because two tasks share a directory.
  const runPlanScope = workspace?.id ?? (!workspaceLoading && !workspaceError && task?.cwd
    ? `task:${task.id}:${projectKey(task.cwd)}` : undefined);
  const runPlanTarget = useRef<{ scope?: string; workspaceId?: string; sessionId?: string; cwd?: string }>({});
  runPlanTarget.current = { scope: runPlanScope, workspaceId: workspace?.id, sessionId: task?.id, cwd: task?.cwd };
  const loadRunPlans = useCallback(async () => {
    const requestGeneration = ++runPlanReadGeneration.current;
    runPlanReadController.current?.abort();
    const controller = new AbortController();
    runPlanReadController.current = controller;
    const { scope, workspaceId, sessionId, cwd } = runPlanTarget.current;
    if (!scope) { setRunPlanRequest(undefined); setRunPlanFailure(undefined); return; }
    setRunPlanRequest({ scope, mode: runPlanSnapshotsRef.current[scope] ? "refresh" : "initial" });
    try {
      const result = workspaceId
        ? await loadRunPlanProjections(workspaceId, controller.signal)
        : await loadTaskRunPlanProjections(sessionId!, cwd!, controller.signal);
      if (workspaceId && result.workspace_id !== workspaceId) throw new Error("Codex 本轮计划返回了其他工程的状态，已拒绝显示。");
      if (!controller.signal.aborted && requestGeneration === runPlanReadGeneration.current && runPlanTarget.current.scope === scope) {
        const snapshot = { projections: result.projections, receivedAt: new Date().toISOString() };
        runPlanSnapshotsRef.current = { ...runPlanSnapshotsRef.current, [scope]: snapshot };
        setRunPlanSnapshots(runPlanSnapshotsRef.current);
        setRunPlanFailure(undefined);
      }
    } catch (cause) {
      if (!controller.signal.aborted && requestGeneration === runPlanReadGeneration.current && runPlanTarget.current.scope === scope) {
        setRunPlanFailure({ scope, message: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      if (!controller.signal.aborted && requestGeneration === runPlanReadGeneration.current && runPlanTarget.current.scope === scope) setRunPlanRequest(undefined);
      if (runPlanReadController.current === controller) runPlanReadController.current = null;
    }
  }, []);
  useEffect(() => {
    setRunPlanFailure(undefined);
    void loadRunPlans();
    return () => { ++runPlanReadGeneration.current; runPlanReadController.current?.abort(); };
  }, [runPlanScope, refresh, loadRunPlans]);
  useEffect(() => {
    if (!recordsVisible || !recordRequest?.feedbackId) return;
    const frame = requestAnimationFrame(() => {
      const row = [...recordAnchor.current?.querySelectorAll<HTMLElement>("[data-feedback-id]") ?? []].find(item => item.dataset.feedbackId === recordRequest.feedbackId);
      const button = row?.querySelector<HTMLButtonElement>(".pni-feedback-title");
      if (button && !button.disabled && button.getAttribute("aria-expanded") !== "true") button.click();
      row?.scrollIntoView({ block: "nearest", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [recordsVisible, recordRequest?.sequence]);
  const latestView = useRef(snapshot); latestView.current = snapshot;
  const onNodeSelection = useCallback((id: string) => {
    if (!workspace?.id || activeScope.current !== workspace.id) return;
    setBrowsing((current) => current?.scope === workspace.id && current.selectedNodeId !== id ? { ...current, selectedNodeId: id, focusNodeId: latestView.current?.scope === workspace.id ? latestView.current.view.document.root_id : current.focusNodeId, expandedNodeIds: latestView.current?.scope === workspace.id ? revealProjectNode(latestView.current.view, id, current.expandedNodeIds) : current.expandedNodeIds } : current);
  }, [workspace?.id]);
  const onEditorTab = useCallback((id: string, next: string) => {
    const tab = detailTab(next); if (!workspace?.id || !tab || activeScope.current !== workspace.id) return;
    lastDetailTab.current = tab;
    setBrowsing((current) => current?.scope === workspace.id && current.selectedNodeId === id && current.tab && current.tab !== tab ? { ...current, tab } : current);
  }, [workspace?.id]);
  const view = snapshot?.scope === workspace?.id ? snapshot?.view : undefined;
  const activeExternal = hasActiveExternalEngineeringRun(view);
  const displayView = useMemo(() => view ? expireEngineeringObservations(view, observationAt) : undefined, [view, observationAt]);
  const observationUnavailable = Boolean(engineeringError) || !connectionAvailable || Boolean(activeExternal && !view?.observation);
  useEffect(() => {
    setObservationAt(Date.now());
    if (!activeExternal) return;
    const tick = () => { if (!document.hidden) setObservationAt(Date.now()); };
    const timer = setInterval(tick, 5_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [activeExternal, workspace?.id, view?.observation?.captured_at]);
  const nodeNames = phasePresentation?.workspace_id === workspace?.id ? phasePresentation?.workspace.node_names : undefined;
  const runPlanSnapshot = runPlanScope ? runPlanSnapshots[runPlanScope] : undefined;
  const runPlans = runPlanSnapshot?.projections ?? [];
  const runPlansLoading = runPlanRequest?.scope === runPlanScope && runPlanRequest?.mode === "initial";
  const runPlansRefreshing = runPlanRequest?.scope === runPlanScope && runPlanRequest?.mode === "refresh";
  const runPlansError = runPlanFailure?.scope === runPlanScope ? runPlanFailure?.message ?? "" : "";
  const runPlanActivityByNode = useMemo(() => projectNodeRunPlanActivities(runPlans, runPlanTransport, Boolean(runPlansError) || runPlansLoading), [runPlans, runPlanTransport, runPlansError, runPlansLoading]);
  const title = task?.title || workspace?.title || "任务工作区";
  const cwd = task?.cwd || workspace?.source_cwd || "";
  const updateView = useCallback((next: EngineeringView) => {
    if (!workspace || activeScope.current !== workspace.id) return;
    const previous = latestView.current?.scope === workspace.id ? latestView.current.view : undefined;
    const chosen = selectEngineeringView(previous, next);
    if (chosen === previous) return;
    const replacement = { scope: workspace.id, view: chosen };
    latestView.current = replacement; setSnapshot(replacement);
    const derived = next.derived[next.document.root_id];
    const active = next.document.nodes.filter((node) => node.status !== "archived").map((node) => next.derived[node.id]?.status ?? node.status);
    if (derived) setWorkspaces((rows) => rows.map((row) => row.id === workspace.id && row.revision <= next.document.revision ? {
      ...row, revision: next.document.revision, status: derived.status, counts: derived.counts, root_node_id: next.document.root_id, updated_at: next.document.updated_at,
      attention_counts: { review: active.filter((status) => status === "review").length, running: active.filter((status) => status === "running").length, blocked: active.filter((status) => ["blocked", "needs_revision", "paused"].includes(status)).length },
      title: row.thread_id ? row.title : next.document.nodes.find((node) => node.id === next.document.root_id)?.title || row.title
    } : row));
  }, [workspace?.id]);
  const loadWorkspaces = useCallback(async () => {
    const token = ++workspaceReadGeneration.current; setWorkspaceError("");
    try { const result = await request<{ data: TaskWorkspaceSummary[] }>("/api/task-workspaces"); if (token !== workspaceReadGeneration.current) return; setWorkspaces((rows) => result.data.map((row) => { const current = rows.find((item) => item.id === row.id); return current && current.revision > row.revision ? current : { ...row, attention_counts: row.attention_counts ?? (current?.revision === row.revision ? current.attention_counts : undefined) }; })); }
    catch (cause) { if (token === workspaceReadGeneration.current) setWorkspaceError((cause as Error).message); }
    finally { if (token === workspaceReadGeneration.current) setWorkspaceLoading(false); }
  }, []);
  const loadPresentation = useCallback(async () => {
    const token = ++presentationGeneration.current; setPresentationLoading(true); setPresentationError("");
    try { const next = await presentationApi.load(); if (token === presentationGeneration.current) setPresentation((current) => current && current.revision > next.revision ? current : next); return next; }
    catch (cause) { if (token === presentationGeneration.current) setPresentationError(`任务分类暂时无法读取。${(cause as Error).message}`); return undefined; }
    finally { if (token === presentationGeneration.current) setPresentationLoading(false); }
  }, [presentationApi]);
  useEffect(() => { void loadPresentation(); }, [loadPresentation]);
  useEffect(() => subscribeTaskPresentation((next) => {
    const shared = { revision: next.revision, collections: next.collections, task_collection_ids: next.task_collection_ids };
    setPresentation((current) => current && current.revision > next.revision ? current : current ? { ...current, ...shared } : { ...next, workspace_id: null, workspace: { current_phase_id: null, node_labels: {} } });
    // A workspace's names and revision must come from the same scoped snapshot.
    // Global/other-workspace updates cannot advance a stale local names revision.
    setPhasePresentation((current) => next.workspace_id !== activeScope.current ? current : current?.workspace_id === next.workspace_id && current.revision > next.revision ? current : next);
  }), []);
  useEffect(() => { if (presentation && collectionFilter !== "all" && collectionFilter !== "unclassified" && !presentation.collections.some((row) => row.id === collectionFilter)) setCollectionFilter("all"); }, [presentation, collectionFilter]);
  useEffect(() => {
    if (!workspace?.id) return;
    const token = ++phaseGeneration.current, scope = workspace.id;
    setPhaseError(""); setPhasePresentation(undefined);
    void phaseApi.load().then((next) => {
      if (token === phaseGeneration.current && activeScope.current === scope) setPhasePresentation((current) => current?.workspace_id === scope && current.revision > next.revision ? current : next);
    }).catch((cause) => { if (token === phaseGeneration.current && activeScope.current === scope) setPhaseError(`名称与内容标签暂时无法读取。${(cause as Error).message}`); });
    return () => { if (token === phaseGeneration.current) phaseGeneration.current++; };
  }, [phaseApi, workspace?.id]);
  async function mutateCollections(operation: TaskPresentationOperation, expectedRevision?: number) {
    if (!presentation) throw new Error("请先读取任务分类。");
    try { const next = await presentationApi.mutate(expectedRevision ?? presentation.revision, operation); setPresentation((current) => current && current.revision > next.revision ? current : next); return next; }
    catch (cause) { if (cause instanceof TaskPresentationApiError && cause.code === "presentation_revision_conflict") await loadPresentation(); throw cause; }
  }
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (!linkMode && !leaveDialog && !codexGateOpen) return;
    const dialog = document.querySelector<HTMLElement>(".uw-modal");
    const previous = document.activeElement as HTMLElement | null;
    dialog?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !linking) { setLinkMode(null); setLeaveDialog(false); setCodexGateOpen(false); pendingNavigation.current = null; }
      if (event.key !== "Tab") return;
      const controls = [...(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)") ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [linkMode, leaveDialog, codexGateOpen, linking]);
  useEffect(() => {
    if (canvasMode !== "focus" || linkMode || leaveDialog || codexGateOpen || nameDialog || collectionDialog) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (recordsVisible) { setRecordsVisible(false); return; }
      if (browsing?.tab) { setBrowsing((current) => current ? { ...current, tab: null } : current); return; }
      setCanvasMode("embedded");
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [canvasMode, linkMode, leaveDialog, codexGateOpen, nameDialog, collectionDialog, recordsVisible, browsing?.tab]);
  useEffect(() => {
    const controller = new AbortController(), gen = ++generation.current;
    setLoading(true); setPaging(false); setError(""); setCursor(null);
    (async () => {
      const rows = new Map<string, Task>(), seenCursors = new Set<string>(); let nextCursor: string | null = null;
      do {
        const params: URLSearchParams = new URLSearchParams({ search: query, archived: String(archived), ...(nextCursor ? { cursor: nextCursor } : {}) });
        const result: { data: Task[]; nextCursor: string | null; syncedAt: string } = await request(`/api/task-inbox?${params}`, controller.signal);
        if (gen !== generation.current) return;
        for (const task of result.data) rows.set(task.id, task);
        setTasks([...rows.values()]); setCursor(result.nextCursor); setSyncedAt(result.syncedAt);
        nextCursor = result.nextCursor;
        if (completeCatalog && nextCursor) { if (seenCursors.has(nextCursor)) throw new Error("任务目录分页重复，已停止读取。请刷新重试。"); seenCursors.add(nextCursor); }
      } while (completeCatalog && nextCursor && !controller.signal.aborted);
    })()
      .catch((cause) => { if (!controller.signal.aborted) { setTasks([]); setError(cause.message); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, archived, refresh, completeCatalog]);
  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces, refresh]);
  useEffect(() => {
    setRunPlanTransport("connecting");
    const stream = new EventSource("/api/events"); let timer: ReturnType<typeof setTimeout> | undefined, workspaceChanged = false, refreshAllRunPlans = false;
    const runPlanScopes = new Set<string>();
    const flush = () => {
      timer = undefined;
      if (workspaceChanged) void loadWorkspaces();
      const scope = activeScope.current;
      if (refreshAllRunPlans || Boolean(scope && runPlanScopes.has(scope))
        || Boolean(!scope && runPlanTarget.current.scope && runPlanScopes.size)) void loadRunPlans();
      workspaceChanged = false; refreshAllRunPlans = false; runPlanScopes.clear();
    };
    stream.onopen = () => setRunPlanTransport("live");
    stream.onerror = () => setRunPlanTransport("offline");
    stream.onmessage = (event) => { try {
      const item = JSON.parse(event.data) as { kind?: string; workspaceId?: string; data?: { kind?: string; workspaceId?: string } };
      const kind = item.kind ?? item.data?.kind, eventScope = item.workspaceId ?? item.data?.workspaceId;
      if (kind !== "engineering" && kind !== "run-plan-projection") return;
      setRunPlanTransport("live");
      if (kind === "engineering") workspaceChanged = true;
      if (eventScope) runPlanScopes.add(eventScope); else refreshAllRunPlans = true;
      if (!timer) timer = setTimeout(flush, 200);
    } catch { /* Ignore unrelated events. */ } };
    const timerId = setInterval(() => { if (!document.hidden) { void loadWorkspaces(); void loadRunPlans(); } }, 30000);
    return () => { stream.onmessage = null; stream.onopen = null; stream.onerror = null; stream.close(); clearInterval(timerId); if (timer) clearTimeout(timer); };
  }, [loadWorkspaces, loadRunPlans]);
  useEffect(() => { setEngineeringError(""); }, [workspace?.id]);
  useEffect(() => { setRecheckScope(null); }, [workspace?.id]);
  useEffect(() => {
    if (selected === "@existing" || !selected || (surface !== "conversation" && (loading || tasks.some((item) => item.id === selected)))) return;
    const controller = new AbortController(), gen = ++detailGeneration.current; setDetailLoading(true); setDetailError("");
    request<Detail>(`/api/task-inbox/${encodeURIComponent(selected)}`, controller.signal).then((next) => { if (gen === detailGeneration.current) setDetail(next); }).catch((cause) => { if (!controller.signal.aborted) setDetailError(cause.message); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, surface, refresh, loading]);
  useEffect(() => {
    if (selected !== "@existing" || !existing?.thread_id) return;
    setSelected(existing.thread_id);
  }, [existing?.thread_id, selected]);
  useEffect(() => {
    if (!view || !workspace) return;
    const restored = restoreProjectBrowsing(view, workspace.id, routeConsumed.current ? undefined : initial.current);
    routeConsumed.current = true;
    setBrowsing((current) => {
      if (current?.scope === workspace.id) {
        const exists = (id: string) => view.document.nodes.some((node) => node.id === id);
        if (!exists(current.selectedNodeId)) return restoreProjectBrowsing(view, workspace.id);
        const expandedNodeIds = revealProjectNode(view, current.selectedNodeId, current.expandedNodeIds);
        const normalized = current.focusNodeId !== view.document.root_id || expandedNodeIds.length !== current.expandedNodeIds.length || expandedNodeIds.some((id, index) => id !== current.expandedNodeIds[index]);
        return normalized ? { ...current, focusNodeId: view.document.root_id, expandedNodeIds } : current;
      }
      return restored;
    });
  }, [view, workspace?.id]);
  const currentBrowsing = browsing?.scope === workspace?.id ? browsing : undefined;
  useEffect(() => {
    const url = new URL(location.href);
    for (const key of ["workspace", "node", "map_node", "tab", "expanded", "canvas", "density"]) url.searchParams.delete(key);
    if (selected && selected !== "@existing") url.searchParams.set("task", selected); else url.searchParams.delete("task");
    if (selected === "@existing") url.searchParams.set("workspace", "engineering");
    url.searchParams.set("view", surface);
    if (surface === "map" && canvasMode === "focus") url.searchParams.set("canvas", "focus");
    if (surface === "map" && canvasDensity !== "auto") url.searchParams.set("density", canvasDensity);
    if (currentBrowsing) {
      url.searchParams.set("node", currentBrowsing.selectedNodeId);
      url.searchParams.set("map_node", currentBrowsing.focusNodeId);
      url.searchParams.set("expanded", currentBrowsing.expandedNodeIds.join(","));
      if (currentBrowsing.tab) url.searchParams.set("tab", currentBrowsing.tab);
    } else if (!routeConsumed.current && selected === initial.current.taskId) {
      if (initial.current.nodeId) url.searchParams.set("node", initial.current.nodeId);
      if (initial.current.focusNodeId) url.searchParams.set("map_node", initial.current.focusNodeId);
      if (initial.current.expandedNodeIds !== null) url.searchParams.set("expanded", initial.current.expandedNodeIds.join(","));
      if (initial.current.tab) url.searchParams.set("tab", initial.current.tab);
    }
    history.replaceState(null, "", url);
  }, [selected, surface, currentBrowsing, canvasMode, canvasDensity]);
  function navigate(action: () => void) {
    if (busy || linking) { setOperationError("当前操作正在保存，请等待完成后再切换任务。"); return; }
    if (dirty) { pendingNavigation.current = action; setLeaveDialog(true); return; }
    action();
  }
  function select(id: string) {
    if (id === selected) { setMobileListOpen(false); return; }
    navigate(() => { detailGeneration.current++; routeConsumed.current = true; setSelected(id); setSurface("map"); setCanvasMode("embedded"); setDetail(undefined); setDetailError(""); setDetailLoading(false); setFocus(undefined); setBrowsing(undefined); setDirty(false); setOperationError(""); setMobileListOpen(false); });
  }
  function commitMapSelection(id: string, _nextFocus: string, tab: ProjectDetailTab | null, expansion?: string[]) {
    if (!view || !workspace || !view.document.nodes.some((node) => node.id === id)) return;
    if (id !== currentBrowsing?.selectedNodeId) { setFeedbackTarget(undefined); setRecordsVisible(false); setRecordsOpened(false); setRecordRequest(undefined); }
    // Keep one persistent graph. nextFocus is retained at the boundary for old
    // callers and deep links, but a selection can only reveal nodes in the root graph.
    setBrowsing((current) => ({ scope: workspace.id, focusNodeId: view.document.root_id, selectedNodeId: id, expandedNodeIds: expansion ?? revealProjectNode(view, id, current?.scope === workspace.id ? current.expandedNodeIds : [view.document.root_id]), tab, showDependencies: current?.scope === workspace.id ? current.showDependencies : true }));
    setFocus({ nodeId: id, tab: tab ?? "reading", requestId: ++navigationSequence.current });
    setSurface("map"); setOperationError("");
  }
  function openNode(id: string, nextTab: ProjectDetailTab = "reading", field?: string) {
    if (!view || !currentBrowsing) return;
    const node = view.document.nodes.find((item) => item.id === id); if (!node) return;
    const nextFocus = id === currentBrowsing.selectedNodeId ? currentBrowsing.focusNodeId : node.parent_id ?? id;
    const action = () => { setRecordsVisible(false); commitMapSelection(id, nextFocus, nextTab); if (field) setFocus(current => current ? { ...current, field } : current); };
    if (id === currentBrowsing.selectedNodeId && !busy) action(); else navigate(action);
  }
  function requestEditorSelection(id: string) {
    if (!view || !currentBrowsing || id === currentBrowsing.selectedNodeId) return;
    const node = view.document.nodes.find(item => item.id === id);
    if (!node) return;
    navigate(() => commitMapSelection(id, node.parent_id ?? id, "reading"));
  }
  function feedbackAt(target: EngineeringFeedbackTarget, scopeNodeIds?: readonly string[], feedbackId?: string) {
    const action = () => { if (target.node_id !== currentBrowsing?.selectedNodeId) commitMapSelection(target.node_id, view?.document.root_id ?? target.node_id, null); setFeedbackTarget({ target, scopeNodeIds, feedbackId, sequence: ++navigationSequence.current }); };
    if (target.node_id === currentBrowsing?.selectedNodeId && !dirty && !busy) action(); else navigate(action);
  }
  function selectFeedback(item: EngineeringFeedback) { feedbackAt(item.target, item.scope_node_ids, item.id); }
  function openFeedbackRecords(feedbackId?: string) {
    if (!feedbackTarget || !currentBrowsing) return;
    const action = () => { setBrowsing((current) => current ? { ...current, tab: null } : current); setRecordsOpened(true); setRecordsVisible(true); setRecordRequest({ target: feedbackTarget.target, feedbackId: feedbackId ?? feedbackTarget.feedbackId, sequence: ++navigationSequence.current }); };
    if (!feedbackDirty && !busy && !linking) action(); else navigate(action);
  }
  const feedbackView = useCallback((next: EngineeringView) => { updateView(next); setRefresh(value => value + 1); }, [updateView]);
  function mapNavigation(intent: ProjectMapNavigationIntent) {
    if (!view || !currentBrowsing) return;
    if (intent.type === "open") { openNode(intent.nodeId, intent.section === "edit" ? "plan" : intent.section === "runs" ? "runs" : "reading"); return; }
    if (intent.type === "toggle" || intent.type === "collapse") {
      if (!view.document.nodes.some((node) => node.id === intent.nodeId && node.status !== "archived")) return;
      const expanded = currentBrowsing.expandedNodeIds;
      const expansion = intent.type === "collapse" ? [view.document.root_id] : expanded.includes(intent.nodeId) ? expanded.filter((id) => id !== intent.nodeId) : [...expanded, intent.nodeId];
      const nextId = intent.type === "collapse" ? view.document.root_id : intent.nodeId;
      const action = () => {
        if (nextId === currentBrowsing.selectedNodeId) setBrowsing((current) => current ? { ...current, focusNodeId: view.document.root_id, expandedNodeIds: expansion } : current);
        else commitMapSelection(nextId, view.document.root_id, null, expansion);
      };
      if (nextId === currentBrowsing.selectedNodeId && !busy && !linking) action(); else navigate(action);
      return;
    }
    const id = intent.nodeId ?? currentBrowsing.focusNodeId;
    const nextFocus = intent.type === "focus" ? id : currentBrowsing.focusNodeId;
    if (intent.type === "select") {
      if (id === currentBrowsing.selectedNodeId) return;
      navigate(() => commitMapSelection(id, view.document.root_id, null));
      return;
    }
    if (id === currentBrowsing.selectedNodeId && nextFocus === currentBrowsing.focusNodeId) return;
    navigate(() => commitMapSelection(id, nextFocus, null));
  }
  function navigateInspector(id: string) {
    if (!view) return;
    const node = view.document.nodes.find((item) => item.id === id); if (!node) return;
    navigate(() => commitMapSelection(id, node.parent_id ?? id, null));
  }
  async function more() {
    if (!cursor || paging) return; const gen = generation.current; setPaging(true); setError("");
    try { const result = await request<{ data: Task[]; nextCursor: string | null }>(`/api/task-inbox?${new URLSearchParams({ cursor, search: query, archived: String(archived) })}`); if (gen !== generation.current) return; setTasks((rows) => [...new Map([...rows, ...result.data].map((item) => [item.id, item])).values()]); setCursor(result.nextCursor); }
    catch (cause) { if (gen === generation.current) setError((cause as Error).message); }
    finally { if (gen === generation.current) setPaging(false); }
  }
  async function link() {
    if (!task || !linkMode || linking) return; const target = task, mode = linkMode; setLinking(true); setOperationError("");
    try {
      const result = await request<TaskWorkspaceSummary>("/api/task-workspaces", undefined, { thread_id: target.id, source_version: target.version, mode });
      workspaceReadGeneration.current++;
      setWorkspaces((rows) => [...rows.filter((item) => item.id !== result.id), result]);
      if (selection.current === target.id) { setLinkMode(null); setSurface("map"); setBrowsing({ scope: result.id, focusNodeId: result.root_node_id, selectedNodeId: result.root_node_id, expandedNodeIds: [result.root_node_id], tab: "plan", showDependencies: false }); setFocus({ nodeId: result.root_node_id, tab: "plan", requestId: ++navigationSequence.current }); }
      void loadWorkspaces();
    } catch (cause) { setOperationError((cause as Error).message); }
    finally { setLinking(false); }
  }
  async function older() {
    if (!detail?.nextCursor || detailLoading) return; const target = detail, gen = detailGeneration.current; setDetailLoading(true); setDetailError("");
    try { const result = await request<Detail>(`/api/task-inbox/${encodeURIComponent(target.id)}?${new URLSearchParams({ cursor: target.nextCursor! })}`); if (result.historyUnavailable) throw new Error("更早对话暂时无法读取，请重试。"); if (gen === detailGeneration.current) setDetail((current) => current?.id === target.id ? { ...current, turns: [...current.turns, ...result.turns.filter((turn) => !current.turns.some((old) => old.id === turn.id))], nextCursor: result.nextCursor } : current); }
    catch (cause) { if (gen === detailGeneration.current) setDetailError((cause as Error).message); }
    finally { if (gen === detailGeneration.current) setDetailLoading(false); }
  }
  async function receive() {
    if (!detail || receiving) return; const target = detail; setReceiving(true); setDetailError("");
    try { const result = await request<{ at: string }>(`/api/task-inbox/${encodeURIComponent(target.id)}/receive`, undefined, { version: target.version, token: target.token }); setTasks((rows) => rows.map((row) => row.id === target.id && row.version === target.version ? { ...row, received: true, receivedAt: result.at } : row)); if (selection.current === target.id) setDetail((current) => current?.version === target.version ? { ...current, received: true, receivedAt: result.at } : current); }
    catch (cause) { if (selection.current === target.id) setDetailError((cause as Error).message); }
    finally { setReceiving(false); }
  }
  const projectPaths = [...new Map(tasks.map((row) => [projectKey(row.cwd), row.cwd])).values()];
  function projectQualifier(path: string) {
    if (isProjectless(path)) return "";
    const peers = projectPaths.filter((candidate) => projectName(candidate) === projectName(path) && projectKey(candidate) !== projectKey(path));
    if (!peers.length) return "";
    const parentParts = (candidate: string) => candidate.replaceAll("\\", "/").split("/").filter(Boolean).slice(0, -1);
    const parts = parentParts(path);
    for (let length = 1; length <= parts.length; length++) {
      const suffix = parts.slice(-length).join(" / ");
      if (peers.every((peer) => parentParts(peer).slice(-length).join(" / ").toLowerCase() !== suffix.toLowerCase())) return suffix;
    }
    return parts.join(" / ") || "独立目录";
  }
  const groups = new Map<string, { title: string; cwd?: string; rows: Task[] }>();
  for (const row of tasks) {
    const linked = workspaces.find((item) => item.thread_id === row.id);
    if (filter === "review" && !attentionCounts(linked).review || filter === "blocked" && !attentionCounts(linked).blocked || filter === "linked" && !linked) continue;
    if (grouping === "project") {
      const key = isProjectless(row.cwd) ? "@projectless" : projectKey(row.cwd), group = groups.get(key) || { title: projectName(row.cwd), ...(isProjectless(row.cwd) ? {} : { cwd: row.cwd }), rows: [] };
      group.rows.push(row); groups.set(key, group);
    } else {
      if (!presentation) continue;
      const memberships = (presentation.task_collection_ids[row.id] ?? []).filter((id) => presentation.collections.some((item) => item.id === id));
      for (const key of memberships.length ? memberships : ["unclassified"]) {
        if (collectionFilter !== "all" && collectionFilter !== key) continue;
        const group = groups.get(key) || { title: key === "unclassified" ? "待分类" : presentation.collections.find((item) => item.id === key)!.title, rows: [] };
        group.rows.push(row); groups.set(key, group);
      }
    }
  }
  const selectedCollections = (presentation?.task_collection_ids[selected] ?? []).map((id) => presentation?.collections.find((item) => item.id === id)).filter((item) => !!item);
  const shownTaskCount = new Set([...groups.values()].flatMap((group) => group.rows.map((row) => row.id))).size;
  return <main className={`unified-workspace ${collapsed ? "tasks-collapsed" : ""} ${selected ? "has-task" : ""} ${mobileListOpen ? "mobile-list-open" : ""} ${canvasMode === "focus" && surface === "map" ? "canvas-focused" : ""}`} aria-label="统一任务工作区">
    <header className="uw-appbar"><div className="uw-brand"><span className="uw-mark">映</span><strong>Mirror 映构</strong><span>任务工作区</span></div><div className="uw-appbar-actions"><span>计划 · 执行 · 验收</span>{selected && <button type="button" aria-pressed={collapsed} onClick={() => { setCollapsed((value) => !value); setMobileListOpen(false); }}>{collapsed ? "显示任务列表" : "收起任务列表"}</button>}<button type="button" onClick={() => setCodexGateOpen(true)}>Codex 运行门禁</button><button type="button" onClick={() => navigate(() => location.assign("/?workspace=archive"))}>历史档案</button></div></header>
    <div className="uw-body">
      <aside className="uw-sidebar" aria-label="Codex 任务列表"><div className="uw-sidebar-heading"><h1>我的任务</h1><button type="button" aria-label="收起任务列表" title="收起任务列表" onClick={() => { setCollapsed(true); setMobileListOpen(false); }}><PanelLeftClose size={17} /></button></div>
        <div className="uw-grouping uw-segments" role="group" aria-label="任务组织方式"><button type="button" aria-pressed={grouping === "project"} onClick={() => setGrouping("project")}>按项目</button><button type="button" aria-pressed={grouping === "collection"} onClick={() => setGrouping("collection")}>按分类</button></div>
        {grouping === "collection" && <div className="uw-collection-navigation"><label>任务分类<select aria-label="按自定义分类筛选任务" value={collectionFilter} disabled={!presentation} onChange={(event) => setCollectionFilter(event.target.value)}><option value="all">全部分类</option><option value="unclassified">待分类</option>{presentation?.collections.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label><button type="button" onClick={() => setCollectionDialog({ type: "manage" })}>管理分类</button></div>}
        {grouping === "collection" && presentationLoading && <p className="uw-classification-notice" role="status">正在读取分类…</p>}
        {grouping === "collection" && presentationError && <div className="uw-error" role="alert">{presentationError}<button type="button" disabled={presentationLoading} onClick={() => void loadPresentation()}>重试分类读取</button></div>}
        <label className="uw-search"><Search size={15} /><input aria-label="搜索全部任务标题" placeholder="搜索全部任务标题" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="uw-list-tools"><div className="uw-segments"><button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>当前</button><button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>归档</button></div><button type="button" aria-label="刷新所有任务" disabled={loading} onClick={() => { setRefresh((n) => n + 1); void loadPresentation(); }}><RefreshCw size={14} /></button></div>
        <label className="uw-filter"><span>工程状态</span><select aria-label="按工程状态筛选任务" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="review">待验收</option><option value="blocked">受阻</option><option value="linked">已有工程计划</option></select><ChevronDown size={13} /></label>
        <div className="uw-task-list" aria-busy={loading}>
          <ConnectedTaskList refresh={refresh} listedIds={[...groups.values()].flatMap(group => group.rows.map(row => row.id))} search={query} selected={selected} onSelect={select} accepts={id => {
            const linked = workspaces.find(item => item.thread_id === id);
            if (filter === "review" && !attentionCounts(linked).review || filter === "blocked" && !attentionCounts(linked).blocked || filter === "linked" && !linked) return false;
            if (grouping !== "collection" || collectionFilter === "all") return true;
            if (!presentation) return false;
            const memberships = (presentation.task_collection_ids[id] ?? []).filter(key => presentation.collections.some(item => item.id === key));
            return collectionFilter === "unclassified" ? !memberships.length : memberships.includes(collectionFilter);
          }} />
          {!workspaceLoading && existing && !existing.thread_id && grouping === "project" && !archived && (filter !== "review" || attentionCounts(existing).review > 0) && (filter !== "blocked" || attentionCounts(existing).blocked > 0) && (!query || existing.title.includes(query)) && <section className="uw-task-group"><h2><GitBranch size={13} />现有工程</h2><button type="button" className={`uw-task ${selected === "@existing" ? "is-selected" : ""}`} aria-pressed={selected === "@existing"} onClick={() => select("@existing")}><span className="uw-task-title">{existing.title}</span><span className="uw-task-meta"><span>待关联 Codex 任务</span><span>{attentionCounts(existing).review} 项待验收</span></span></button><p className="uw-group-path">此工程尚未计入 Codex 任务目录</p></section>}
          {loading && <p className="uw-empty" role="status">{completeCatalog ? `正在读取全部${archived ? "归档" : "当前"}任务目录…` : "正在同步任务目录…"}</p>}
          {!loading && [...groups].map(([key, group]) => <section className="uw-task-group" key={key} aria-label={group.cwd || group.title}>
            <h2 title={group.cwd}><Folder size={13} /><span className="uw-group-name">{group.title}</span><span>{group.rows.length}</span></h2>
            {group.cwd && projectQualifier(group.cwd) && <p className="uw-group-path" title={group.cwd}>{projectQualifier(group.cwd)}</p>}
            {group.rows.map((row) => { const linked = workspaces.find((item) => item.thread_id === row.id); return <button type="button" className={`uw-task ${selected === row.id ? "is-selected" : ""}`} key={row.id} title={row.cwd} aria-pressed={selected === row.id} onClick={() => select(row.id)}>
              <span className="uw-task-title">{row.pinned && <span aria-label="已置顶">★ </span>}{row.title}</span>
              <span className="uw-task-meta"><span className={attentionCounts(linked).review ? "needs-review" : attentionCounts(linked).blocked ? "is-blocked" : ""}>{linked ? attentionCounts(linked).review ? `${attentionCounts(linked).review} 项待验收` : attentionCounts(linked).blocked ? `${attentionCounts(linked).blocked} 项受阻` : statusNames[linked.status] || "已建立计划" : "尚未建立计划"}</span><time>{dateLabel(row.updatedAt)}</time></span>
              {grouping === "collection" && <span className="uw-task-origin" title={row.cwd}>{projectName(row.cwd)}{projectQualifier(row.cwd) ? ` · ${projectQualifier(row.cwd)}` : ""}</span>}
              {linked && <span className="uw-task-progress">{linked.counts.accepted} / {linked.counts.total} 项已验收{!row.received ? " · 对话有更新" : ""}</span>}
            </button>; })}
          </section>)}
          {!loading && !error && !groups.size && !(grouping === "collection" && (presentationLoading || presentationError)) && <p className="uw-empty">{grouping === "collection" ? "当前目录中没有同时符合分类、状态和标题的任务。" : filter !== "all" ? `当前${archived ? "归档" : "活动"}目录内，没有符合此状态${query ? "和搜索标题" : ""}的任务。` : query ? "Codex 目录没有返回匹配此标题的任务。" : "Codex 目录未返回此范围的任务。"}</p>}
          {error && <div className="uw-error" role="alert">{error}<button type="button" onClick={() => cursor ? void more() : setRefresh((n) => n + 1)}>重试任务目录</button></div>}
          {cursor && <button type="button" className="uw-load-more" disabled={paging || loading} onClick={() => void more()}>{paging ? "正在读取…" : "加载更早任务"}</button>}
        </div><footer className="uw-sidebar-footer">本机 Codex · {archived ? "归档" : "当前"}{query ? "搜索范围" : "目录"}已载入 {tasks.length} 项{cursor ? " · 还有更多" : " · 已读完"}{!loading && (grouping === "collection" || filter !== "all") ? ` · 符合 ${shownTaskCount} 项任务` : ""}<br />{syncedAt ? `同步于 ${new Date(syncedAt).toLocaleTimeString("zh-CN")}` : "等待读取任务目录"}{!loading && selected && selected !== "@existing" && ![...groups.values()].some((group) => group.rows.some((row) => row.id === selected)) && (grouping === "collection" || filter !== "all" || query) && <p>正在查看的任务不在本页 Codex 目录中。</p>}</footer>
      </aside>
      <section className="uw-current-task" aria-label="当前 Codex 任务">
        <div className="uw-task-heading"><div className="uw-task-heading-main"><button type="button" className="uw-show-tasks" aria-label="展开任务列表" onClick={() => { setCollapsed(false); setMobileListOpen(true); }}><PanelLeftOpen size={18} /></button><div><span className="uw-eyebrow">{selected ? `${projectName(cwd)} · ${selected === "@existing" ? "现有工程" : "Codex 任务"}` : "全部工程，同一条推进路径"}</span><h1>{selected ? title : "从任务开始，推进到可验收的结果"}</h1></div></div>{workspace && <span className={`uw-status is-${workspace.status}`}>{statusNames[workspace.status] || "已建立计划"}</span>}</div>
        {selected && selected !== "@existing" && <div className="uw-task-collections" aria-label="当前任务分类">{selectedCollections.length ? selectedCollections.map((row) => <span className="uw-collection-tag" key={row.id}>{row.title}</span>) : <span className="uw-classification-notice">{presentationLoading ? "正在读取分类…" : presentationError ? "分类暂不可用" : "待分类"}</span>}<button type="button" disabled={!task || !presentation || presentationLoading || !!presentationError || busy || linking} onClick={() => setCollectionDialog({ type: "assign", taskId: selected, taskTitle: title })}>修改分类</button>{presentationError && <button type="button" disabled={presentationLoading} onClick={() => void loadPresentation()}>重试分类读取</button>}</div>}
        {selected && <nav className="uw-surfaces" aria-label="当前任务视图">{([{ id: "map", label: "工程地图" }, { id: "conversation", label: "原始对话" }] as const).map((item) => <button type="button" key={item.id} aria-current={surface === item.id ? "page" : undefined} disabled={item.id === "conversation" && selected === "@existing"} onClick={() => setSurface(item.id)}>{item.label}{item.id === "map" && dirty && <span className="uw-dirty-dot" aria-hidden="true" title="有未保存的方案编辑" />}</button>)}</nav>}
        {workspaceError && <div className="uw-error" role="alert">工程关联暂时无法读取：{workspaceError}<button type="button" onClick={() => void loadWorkspaces()}>重试关联目录</button></div>}
        {operationError && !linkMode && <div className="uw-error" role="alert">{operationError}<button type="button" onClick={() => setOperationError("")}>关闭</button></div>}
        {!selected && workspaceLoading && <div className="uw-overview" role="status">正在恢复当前工程…</div>}
        {!selected && !workspaceLoading && !workspaceError && <div className="uw-overview uw-welcome"><GitBranch size={32} strokeWidth={1.4} /><h2>选择任务，管理它的完整过程</h2><p>任务、步骤和交付沿同一工程计划推进。每一步都能修改做法、继承约束、选择能力，并以实际证据验收。</p><ol className="uw-workflow"><li><strong>构思与拆分</strong><span>明确目标、做法和验收条件</span></li><li><strong>约束与执行</strong><span>分配负责人，冻结版本后推进</span></li><li><strong>交付与核对</strong><span>逐步验收，上级单独整合</span></li></ol><button className="uw-primary uw-mobile-start" type="button" onClick={() => { setCollapsed(false); setMobileListOpen(true); }}>选择我的任务 <ArrowRight size={15} /></button></div>}
        {selected && !workspace && workspaceLoading && surface !== "conversation" && <div className="uw-overview" role="status">正在核对当前工程关联…</div>}
        {selected && !workspace && !workspaceLoading && !workspaceError && surface !== "conversation" && <div className="uw-overview">
          {task && <CodexRunPlanOverlay key={runPlanScope} presentation="inline" projections={runPlans} loading={runPlansLoading} refreshing={runPlansRefreshing} error={runPlansError} transportState={runPlanTransport} lastSyncedAt={runPlanSnapshot?.receivedAt} nodeNames={{}} onRetry={() => void loadRunPlans()} onOpenNode={() => undefined} />}
          <details className="uw-task-plan-setup" open={!runPlans.length}><summary>工程结构与任务边界 · 尚未建立</summary>
            <section className="uw-onboarding"><h2>建立这项任务的工程计划</h2><p>本轮计划先展示 Agent 正在做什么。建立工程后，可进一步划分子项目、分配负责人，并把成果放回对应节点。</p>{workspaceLoading || loading && !task ? <p className="uw-empty">正在核对任务与工程关联…</p> : <div className="uw-connect-options"><div><h3>建立独立计划</h3><p>为「{task?.title || title}」建立单独的工程。其他任务的方案和证据保留在各自工作区。</p><button className="uw-primary" type="button" disabled={!task || !!workspaceError} onClick={() => { setOperationError(""); setLinkMode("create"); }}>建立任务计划 <ArrowRight size={14} /></button></div>{existing && !existing.thread_id && <div><h3>继续已存在的工程</h3><p><strong>{existing.title}</strong><br />{existing.counts.total} 项末级任务 · {attentionCounts(existing).review} 项待验收</p><button type="button" disabled={!task || !!workspaceError} onClick={() => { setOperationError(""); setLinkMode("link_existing"); }}>关联已有工程</button></div>}</div>}<p className="uw-hint">接入只建立任务与工程的关联。执行负责人、写入边界和验收条件仍由具体步骤明确指定。</p></section>
          </details>{detailError && <div className="uw-error" role="alert">{detailError}<button type="button" onClick={() => setRefresh((n) => n + 1)}>重试任务信息</button></div>}
        </div>}
        {workspace && <div className="uw-project-surface" data-workspace-id={workspace.id} data-engineering-revision={view?.document.revision} hidden={surface !== "map"}>
          {engineeringError && <div className="uw-error" role="alert">{engineeringError}<button type="button" onClick={() => setRefresh((n) => n + 1)}>重试工程内容</button></div>}
          {phaseError && <p className="uw-classification-notice">{phaseError}；工程内容仍可使用。</p>}
          {!view && !engineeringError && <p className="uw-empty">正在核对当前工程状态…</p>}
          {view && recheckWorkPackageCandidates(view).some(item => !item.unavailable) && <div className="uw-task-collections"><button type="button" disabled={dirty || busy || linking || observationUnavailable} onClick={() => setRecheckScope(workspace.id)}>修正检查并复验</button><span className="uw-hint">保留历史运行，一次确认本轮检查修正。</span></div>}
          {view && <StructureProposalReview key={workspace.id} api={scopedApi} revision={view.document.revision} disabled={dirty || busy || linking} onBusyChange={setStructureBusy} onPreviewChange={visible => setStructurePreviewScope(visible ? workspace.id : null)} onApplied={next => { updateView(next); setFocus({ nodeId: next.document.root_id, tab: "reading", requestId: ++navigationSequence.current }); setEditorEpoch(value => value + 1); setRefresh(value => value + 1); setBrowsing(current => current?.scope === workspace.id ? { ...current, selectedNodeId: next.document.root_id, focusNodeId: next.document.root_id, expandedNodeIds: [next.document.root_id], tab: null } : current); }} />}
          {view && currentBrowsing && structurePreviewScope !== workspace.id && <div className="execution-story uw-project-story">
            <div className="uw-map-frame"><ProjectStructureMap key={workspace.id} workspaceId={workspace.id} view={displayView ?? view} nodeNames={nodeNames} runPlanActivityByNode={runPlanActivityByNode} focusNodeId={currentBrowsing.focusNodeId} selectedNodeId={currentBrowsing.selectedNodeId} expandedNodeIds={currentBrowsing.expandedNodeIds} showDependencies={currentBrowsing.showDependencies} observationUnavailable={observationUnavailable} disabled={busy || linking} canvasMode={canvasMode} onCanvasModeChange={setCanvasMode} density={canvasDensity} onDensityChange={setCanvasDensity} onRequestNavigation={mapNavigation} onDependenciesChange={(visible) => setBrowsing((current) => current?.scope === workspace.id ? { ...current, showDependencies: visible } : current)} onFeedback={feedbackAt} feedbackTarget={feedbackTarget?.target} feedbackScopeNodeIds={feedbackTarget?.scopeNodeIds} feedbackId={feedbackTarget?.feedbackId} onDismissFeedback={(afterDismiss) => navigate(() => { setFeedbackTarget(undefined); afterDismiss?.(); })} onOpenDetail={(id: string, section: "read" | "edit" | "runs") => openNode(id, section === "edit" ? "plan" : section === "runs" ? "runs" : "reading")} contextPanel={feedbackTarget && <GraphFeedbackCard key={`${workspace.id}:${feedbackTarget.target.node_id}:${feedbackTarget.target.kind}:${feedbackTarget.target.id ?? ""}:${feedbackTarget.scopeNodeIds?.join(",") ?? ""}:${editorEpoch}`} api={scopedApi} view={displayView ?? view} target={feedbackTarget.target} scopeNodeIds={feedbackTarget.scopeNodeIds} selectedFeedbackId={feedbackTarget.feedbackId} nodeNames={nodeNames} observationUnavailable={observationUnavailable} disabled={editorDirty || editorBusy || recordDirty || recordBusy || structureBusy || linking} onView={feedbackView} onDirtyChange={setFeedbackDirty} onBusyChange={setFeedbackBusy} onClose={() => navigate(() => setFeedbackTarget(undefined))} onSelectFeedback={selectFeedback} onOpenDetail={openNode} onOpenRecords={openFeedbackRecords} />} /></div>
            <CodexRunPlanOverlay projections={runPlans} loading={runPlansLoading} refreshing={runPlansRefreshing} error={runPlansError} transportState={runPlanTransport} lastSyncedAt={runPlanSnapshot?.receivedAt} nodeNames={Object.fromEntries(view.document.nodes.map((node) => [node.id, nodeNames?.[node.id] ?? node.title]))} onRetry={() => void loadRunPlans()} onOpenNode={(nodeId) => mapNavigation({ type: "focus", nodeId, reason: "locate" })} />
          </div>}
          {(recordsVisible || currentBrowsing?.tab) && structurePreviewScope !== workspace.id && <button type="button" className="uw-drawer-scrim" aria-label="收起侧边详情" onClick={() => recordsVisible ? setRecordsVisible(false) : setBrowsing((current) => current ? { ...current, tab: null } : current)} />}
          {view && currentBrowsing && recordsOpened && <div ref={recordAnchor} className="uw-feedback-records" hidden={!recordsVisible || structurePreviewScope === workspace.id}><div className="uw-detail-heading"><strong>意见处理记录</strong><button type="button" onClick={() => setRecordsVisible(false)}>收起记录{recordDirty ? "，保留草稿" : ""}</button></div><FeedbackPanel key={`${workspace.id}:${currentBrowsing.selectedNodeId}:${editorEpoch}`} api={scopedApi} view={displayView ?? view} observationUnavailable={observationUnavailable} nodeId={currentBrowsing.selectedNodeId} targetRequest={recordRequest} disabled={editorDirty || editorBusy || feedbackDirty || feedbackBusy || structureBusy || linking} onView={feedbackView} onDirtyChange={setRecordDirty} onBusyChange={setRecordBusy} onEdit={(id, field) => openNode(id, "plan", field)} /></div>}
          <div className="uw-project-detail" role="complementary" aria-label="本项说明与结果" hidden={!currentBrowsing?.tab || structurePreviewScope === workspace.id}>
            <div className="uw-detail-heading"><strong>本项说明与结果</strong><button type="button" onClick={() => setBrowsing((current) => current ? { ...current, tab: null } : current)}>收起详情，保留地图{dirty ? "与草稿" : ""}</button></div>
            {view && currentBrowsing?.tab && <ProjectNodeInspector api={scopedApi} view={displayView ?? view} nodeNames={nodeNames} onRename={!busy && phasePresentation?.workspace_id === workspace.id ? () => { const node = view.document.nodes.find(item => item.id === currentBrowsing.selectedNodeId); if (node && node.status !== "archived") setNameDialog({ node, workspaceId: workspace.id, presentation: phasePresentation }); } : undefined} nodeId={currentBrowsing.selectedNodeId} labels={phasePresentation?.workspace_id === workspace.id ? phasePresentation.workspace.node_labels[currentBrowsing.selectedNodeId] : undefined} onOpenDetail={openNode} onNavigateNode={navigateInspector} onFeedback={feedbackAt} observationUnavailable={observationUnavailable} />}
            <div className="uw-engineering-container"><EngineeringWorkspace key={`${workspace.id}:${editorEpoch}`} embedded inlineDetail nodeNames={nodeNames} api={scopedApi} focus={focus} externalView={view} externalBusy={feedbackBusy || feedbackDirty || recordBusy || recordDirty || structureBusy || linking} onView={updateView} onSelectionChange={onNodeSelection} onRequestSelection={requestEditorSelection} onConnectionChange={setConnectionAvailable} onTabChange={onEditorTab} onError={setEngineeringError} refreshToken={refresh} onDirtyChange={setDirty} onBusyChange={setEditorBusy} /></div>
          </div>
          {(editorDirty && !currentBrowsing?.tab || recordDirty && !recordsVisible) && <div className="uw-draft-reminder" role="status">当前节点有未保存的内容。<button type="button" onClick={() => recordDirty ? setRecordsVisible(true) : currentBrowsing && openNode(currentBrowsing.selectedNodeId, lastDetailTab.current)}>继续处理草稿</button></div>}
          <details className="uw-source uw-project-source"><summary>任务来源</summary><p>{selected === "@existing" ? "此工程尚未绑定 Codex 任务。选择左侧相应任务后，可通过“关联已有工程”继续使用当前计划。" : "当前 Codex 任务的工程计划、执行和验收均使用此关联。对话阅读记录不改变工程验收状态。"}</p><dl><dt>来源目录</dt><dd>{cwd}</dd><dt>工程</dt><dd>{workspace.title}</dd><dt>更新时间</dt><dd>{timeLabel(workspace.updated_at)}</dd></dl></details>
        </div>}
        {selected && surface === "conversation" && <div className="uw-conversation"><div className="uw-conversation-heading"><MessageSquare size={19} /><div><h2>任务原始对话</h2><p>这是当前任务的来源与沟通记录。工程交付请返回“工程地图”，在对应节点的运行与验收中核对实际证据。</p></div></div>{detailError && <div className="uw-error" role="alert">{detailError}<button type="button" onClick={() => setRefresh((n) => n + 1)}>刷新对话</button></div>}{detailLoading && detail?.id !== selected && <p className="uw-empty">正在按需读取对话…</p>}{detail?.id === selected && <><div className="uw-conversation-tools"><span>最近更新 {dateLabel(detail.updatedAt)}</span><button type="button" disabled={receiving || detail.received} onClick={() => void receive()}><Check size={14} />{receiving ? "正在保存…" : detail.received ? "此版本已读" : "标记此版本已读"}</button></div><details className="uw-source"><summary>最初请求与来源目录</summary><p>{detail.preview || "暂无请求摘要。"}</p><p>{detail.cwd}</p></details>{detail.historyUnavailable && <div className="uw-error" role="alert">对话暂时无法读取。工程计划仍可使用，刷新后可重新读取来源记录。<button type="button" onClick={() => setRefresh((n) => n + 1)}>重试读取对话</button></div>}{!detail.historyUnavailable && !detail.turns.length && <p className="uw-empty">此任务暂无已保存的文本对话。</p>}{detail.turns.map((turn) => <section className="uw-turn" key={turn.id}><div className="uw-turn-status">{({ completed: "本轮回复结束", inProgress: "本轮尚未结束", failed: "本轮失败", interrupted: "本轮已中断" } as Record<string, string>)[turn.status] || "历史对话"}</div>{turn.messages.map((message, index) => <article className={`uw-message ${message.role}`} key={index}><h3>{message.role === "user" ? "你的请求" : "Agent 回复"}</h3><div>{message.text || "此条没有可显示的文本。"}</div></article>)}</section>)}{detail.nextCursor && <button type="button" disabled={detailLoading} onClick={() => void older()}>{detailLoading ? "正在读取…" : "查看更早对话"}</button>}</>}</div>}
      </section>
    </div>
    {recheckScope && recheckScope === workspace?.id && view && <RecheckWorkPackageDialog key={workspace.id} view={view} api={scopedApi} disabled={editorBusy || feedbackBusy || recordBusy || structureBusy || linking} onClose={() => setRecheckScope(null)} onUpdated={next => { updateView(next); setRefresh(value => value + 1); }} />}
    {nameDialog && <NodeNameDialog key={`${nameDialog.workspaceId}:${nameDialog.node.id}`} {...nameDialog} onSaved={next => { if (activeScope.current === next.workspace_id) setPhasePresentation(current => current && current.revision > next.revision ? current : next); }} onClose={() => setNameDialog(undefined)} />}
    {codexGateOpen && <div className="uw-modal-backdrop"><section className="uw-modal uw-codex-gate-modal" role="dialog" aria-modal="true" aria-label="Codex 运行门禁"><div className="uw-modal-heading"><div><h2>Codex 运行门禁</h2><p>先核对本机运行条件；只有第二次明确点击才会打开 Windows Hello。</p></div><button type="button" onClick={() => setCodexGateOpen(false)}>关闭</button></div><CodexReadinessPanel workspaceId={workspace?.id ?? "host"} /></section></div>}
    {collectionDialog && <TaskCollections key={collectionDialog.type === "assign" ? collectionDialog.taskId : "manage"} dialog={collectionDialog} view={presentation} loading={presentationLoading} loadError={presentationError} onRetry={() => void loadPresentation()} onMutate={mutateCollections} onClose={() => setCollectionDialog(null)} />}
    {linkMode && <div className="uw-modal-backdrop"><section className="uw-modal" role="dialog" aria-modal="true" aria-label={linkMode === "create" ? "建立任务计划" : "关联已有工程"}><h2>{linkMode === "create" ? "建立任务计划" : "关联已有工程"}</h2><p>当前任务：<strong>{task?.title}</strong></p>{linkMode === "create" ? <p>将建立独立工程，从当前任务目标开始细化。工程资料保存在映构宿主中，来源项目的文件不会因此改写。</p> : <><p>关联工程：<strong>{existing?.title}</strong></p><p>{existing?.counts.total} 项末级任务 · {attentionCounts(existing).review} 项待验收。保留现有方案、运行和证据，后续从当前任务继续管理。</p></>}<p className="uw-hint">关联后仍需在步骤中明确负责人、执行边界与验收条件。</p>{operationError && <div className="uw-error" role="alert">{operationError}</div>}<div className="uw-modal-actions"><button type="button" disabled={linking} onClick={() => setLinkMode(null)}>取消</button><button type="button" className="uw-primary" disabled={linking} onClick={() => void link()}>{linking ? "正在建立关联…" : linkMode === "create" ? "建立并细化方案" : "确认关联并继续"}</button></div></section></div>}
    {leaveDialog && <div className="uw-modal-backdrop"><section className="uw-modal" role="dialog" aria-modal="true" aria-label="当前方案尚未保存"><h2>当前内容尚未保存</h2><p>切换会放弃当前未保存的方案、内容标签或未提交的反馈。可以返回处理，保存或提交后再继续。</p><div className="uw-modal-actions"><button type="button" autoFocus onClick={() => { pendingNavigation.current = null; setLeaveDialog(false); }}>返回继续编辑</button><button type="button" onClick={() => { const action = pendingNavigation.current; pendingNavigation.current = null; setDirty(false); setFeedbackDirty(false); setRecordDirty(false); setEditorEpoch((n) => n + 1); setLeaveDialog(false); action?.(); }}>放弃编辑并继续</button></div></section></div>}
  </main>;
}
