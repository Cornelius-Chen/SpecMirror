import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, ExternalLink, GitBranch, History, ListTree, Play, Plus, RotateCcw, Save, ShieldCheck, Undo2 } from "lucide-react";
import { api } from "../api.ts";
import { ExecutionSupervisionOverview } from "./ExecutionSupervisionOverview.tsx";
import { GuidedSupervisionDetails } from "./GuidedSupervisionDetails.tsx";
import { CodexCompanionBar } from "./CodexCompanionBar.tsx";
import { companionTaskContext } from "../companion.ts";
import type { CodexCompanionStatus, SupervisionCategory, SupervisionDetail, SupervisionDocument, SupervisionGoalResult, SupervisionProgress, SupervisionRun, SupervisionTask } from "../types.ts";

const categories: Array<{ id: SupervisionCategory; label: string; hint: string }> = [
  { id: "function", label: "功能", hint: "行为与结果" },
  { id: "visual", label: "视觉", hint: "画面与层级" },
  { id: "interaction", label: "交互", hint: "操作与反馈" },
  { id: "copy", label: "文案", hint: "语言与理解" },
  { id: "asset", label: "素材", hint: "来源与授权" }
];

const statusLabels: Record<SupervisionDetail["status"], string> = {
  draft: "草拟中", ready: "可派发", assigned: "执行中", reviewing: "待检查", accepted: "已通过", needs_revision: "需修订"
};

const checkLabels = { pass: "满足", partial: "部分满足", fail: "未满足", pending: "待验证" } as const;

function bumpVersion(version: string, prefix: string) {
  const current = Number(version.match(/\d+$/)?.[0] ?? 0);
  return `${prefix}${current + 1}`;
}

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

const comparisonLabels = {
  behavior: "行为场景对照",
  screenshot: "画面对照",
  copy: "文案对照",
  workflow: "流程顺序对照",
  asset: "素材授权对照"
} as const;

function changedDetailFields(before: SupervisionDetail, after: SupervisionDetail) {
  const fields: Array<[string, unknown, unknown]> = [
    ["设计标题", before.title, after.title], ["目标说明", before.intent, after.intent],
    ["验收条件", before.acceptance, after.acceptance], ["通用 Prompt", before.prompt.base, after.prompt.base],
    ["局部 Prompt", before.prompt.local, after.prompt.local], ["参考素材", before.prompt.resources, after.prompt.resources], ["允许修改", before.prompt.allowed_changes, after.prompt.allowed_changes],
    ["禁止修改", before.prompt.forbidden_changes, after.prompt.forbidden_changes], ["工程执行边界", before.execution, after.execution]
  ];
  return fields.filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right)).map(([label]) => label);
}

function ArtifactComparison({ detail }: { detail: SupervisionDetail }) {
  const output = detail.output!;
  const kind = output.artifact_kind;
  const isImage = Boolean(output.artifact_ref && (kind === "screenshot" || /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(output.artifact_ref)));
  return <section className={`artifact-comparison comparison-${kind}`} data-testid={`comparison-mode-${kind}`}>
    <header><strong>{comparisonLabels[kind]}</strong><span>按本类最容易检查的方式呈现</span></header>
    {kind === "screenshot" && <div className="visual-comparison">
      <article><small>设计目标</small><strong>{detail.title}</strong><p>{detail.intent}</p></article>
      <article><small>Agent 画面</small>{isImage ? <img src={output.artifact_ref} alt={`${detail.title} 产出`} loading="eager" fetchPriority="high" /> : <><strong>尚无可核对截图</strong><p>{output.summary}</p></>}</article>
    </div>}
    {kind === "copy" && <div className="copy-comparison">
      <article><small>你要求表达</small><p>{detail.intent}</p></article>
      <article><small>Agent 实际表达</small><p>{output.summary}</p></article>
    </div>}
    {kind === "workflow" && <ol className="workflow-comparison">{output.checks.map((check, index) => <li key={`${check.criterion}-${index}`}><span>{index + 1}</span><div><strong>{check.criterion}</strong><small>{checkLabels[check.result]} · {check.note}</small></div></li>)}</ol>}
    {kind === "behavior" && <div className="behavior-comparison">{output.checks.map((check, index) => <article key={`${check.criterion}-${index}`}><span>场景 {index + 1}</span><strong>{check.criterion}</strong><p>{check.note}</p></article>)}</div>}
    {kind === "asset" && <div className="asset-comparison">
      <article className="allowed"><small>已选参考素材</small>{detail.prompt.resources.length ? detail.prompt.resources.map((item) => <span key={item}>↗ {item}</span>) : <span>尚未指定素材引用</span>}<small>本任务允许</small>{detail.prompt.allowed_changes.map((item) => <span key={item}>✓ {item}</span>)}</article>
      <article className="forbidden"><small>明确禁止</small>{detail.prompt.forbidden_changes.map((item) => <span key={item}>× {item}</span>)}</article>
    </div>}
  </section>;
}

export function DesignSupervisionWorkspace({ formalExecutionReady = false }: { formalExecutionReady?: boolean }) {
  const [document, setDocument] = useState<SupervisionDocument>();
  const [history, setHistory] = useState<SupervisionDocument[]>([]);
  const [runs, setRuns] = useState<SupervisionRun[]>([]);
  const [progress, setProgress] = useState<SupervisionProgress>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [taskDraft, setTaskDraft] = useState<SupervisionTask>();
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<SupervisionDetail>();
  const [reviewNote, setReviewNote] = useState("");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [compiledGoal, setCompiledGoal] = useState<SupervisionGoalResult>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [taskDirty, setTaskDirty] = useState(false);
  const [planImportOpen, setPlanImportOpen] = useState(false);
  const [planText, setPlanText] = useState("");
  const [companion, setCompanion] = useState<CodexCompanionStatus>();
  const [companionError, setCompanionError] = useState<string>();
  const companionRefreshId = useRef(0);
  const refreshFlight = useRef<Promise<void> | null>(null);
  const refreshPending = useRef(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<"overview" | "details">("overview");

  const refreshOnce = useCallback(async () => {
    // Only a mutation invalidates a snapshot; incoming SSE events must not starve it.
    const refreshId = companionRefreshId.current;
    const companionRequest = api.codexCompanionStatus().then((nextCompanion) => {
      if (refreshId !== companionRefreshId.current) return;
      setCompanion(nextCompanion); setCompanionError(undefined);
    }).catch(() => {
      if (refreshId !== companionRefreshId.current) return;
      setCompanion(undefined); setCompanionError("伴随连接读取失败；反馈暂不可用，已有任务和产出仍可审查。");
    });
    await Promise.all([api.supervision(), api.supervisionHistory(), api.supervisionRuns(), api.supervisionProgress()]).then(([next, nextHistory, nextRuns, nextProgress]) => {
      setDocument(next); setHistory(nextHistory); setRuns(nextRuns); setProgress(nextProgress);
      setSelectedTaskId((current) => current && next.tasks.some((task) => task.id === current) ? current : [...next.tasks].sort((a, b) => a.order - b.order)[0]?.id);
    }).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    await companionRequest;
  }, []);
  const refresh = useCallback(() => {
    if (refreshFlight.current) {
      refreshPending.current = true;
      return refreshFlight.current;
    }
    const drain = async () => {
      do {
        refreshPending.current = false;
        await refreshOnce();
      } while (refreshPending.current);
    };
    refreshFlight.current = drain().finally(() => { refreshFlight.current = null; });
    return refreshFlight.current;
  }, [refreshOnce]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const stream = new EventSource("/api/events");
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    stream.onmessage = () => {
      // Collapse replay bursts into one refresh window, including a single trailing request.
      if (scheduled) return;
      scheduled = setTimeout(() => { scheduled = undefined; void refresh(); }, 80);
    };
    return () => { stream.close(); if (scheduled) clearTimeout(scheduled); refreshPending.current = false; };
  }, [refresh]);

  const orderedTasks = useMemo(() => [...(document?.tasks ?? [])].sort((a, b) => a.order - b.order), [document]);
  const selectedTask = useMemo(() => document?.tasks.find((item) => item.id === selectedTaskId), [document, selectedTaskId]);
  const companionContext = companionTaskContext(companion, selectedTaskId);
  useEffect(() => setFeedbackText(""), [selectedTaskId, companion?.selected_session_id]);
  const taskDetails = useMemo(() => document?.details.filter((item) => item.task_id === selectedTaskId) ?? [], [document, selectedTaskId]);
  const selected = useMemo(() => taskDetails.find((item) => item.id === selectedId), [taskDetails, selectedId]);
  const selectedServerSignature = selected ? `${selected.id}|${selected.version}|${selected.status}|${selected.output?.produced_at ?? ""}|${selected.output?.reviewer_status ?? ""}` : "";
  const latestRun = useMemo(() => runs.filter((run) => run.detail_id === selectedId).sort((left, right) => left.requested_at.localeCompare(right.requested_at)).at(-1), [runs, selectedId]);
  const previousDetail = useMemo(() => [...history].reverse().map((snapshot) => snapshot.details.find((item) => item.id === selectedId)).find(Boolean), [history, selectedId]);
  const changedFields = useMemo(() => previousDetail && draft ? changedDetailFields(previousDetail, draft) : [], [previousDetail, draft]);
  const selectedHistory = useMemo(() => history.find((snapshot) => snapshot.version === historyVersion), [history, historyVersion]);
  const selectedHistoryDetail = useMemo(() => selectedHistory?.details.find((item) => item.id === selectedId), [selectedHistory, selectedId]);
  const historyChangedFields = useMemo(() => selectedHistoryDetail && draft ? changedDetailFields(selectedHistoryDetail, draft) : [], [selectedHistoryDetail, draft]);
  const selectedTaskSignature = selectedTask ? `${selectedTask.id}|${selectedTask.version}|${selectedTask.status}|${selectedTask.title}|${selectedTask.objective}` : "";
  useEffect(() => {
    if (!selectedTask) return;
    setTaskDraft(structuredClone(selectedTask));
    setTaskDirty(false);
    setSelectedId((current) => taskDetails.some((detail) => detail.id === current) ? current : taskDetails[0]?.id);
    setCompiledGoal(undefined);
  }, [selectedTaskId, selectedTaskSignature]);
  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : undefined);
    setReviewNote(selected?.output?.reviewer_note ?? "");
    setMessage(undefined);
    setCompiledGoal(undefined);
    setHistoryOpen(false);
    setHistoryVersion(undefined);
    setDirty(false);
  }, [selectedId]);
  useEffect(() => {
    if (!dirty && selected) {
      setDraft(structuredClone(selected));
      setReviewNote(selected.output?.reviewer_note ?? "");
    }
  }, [selectedServerSignature, dirty]);

  const accepted = document?.details.filter((item) => item.status === "accepted").length ?? 0;

  function update(patch: Partial<SupervisionDetail>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setCompiledGoal(undefined);
    setDirty(true);
  }

  function updateExecution(key: keyof NonNullable<SupervisionDetail["execution"]>, value: string[]) {
    setDraft((current) => current ? {
      ...current,
      execution: {
        ownership_modules: current.execution?.ownership_modules ?? [],
        write_globs: current.execution?.write_globs ?? [],
        shared_contracts: current.execution?.shared_contracts ?? [],
        acceptance_commands: current.execution?.acceptance_commands ?? [],
        [key]: value
      }
    } : current);
    setCompiledGoal(undefined);
    setDirty(true);
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setMessage(undefined);
    try {
      const nextDetail: SupervisionDetail = {
        ...draft,
        version: bumpVersion(draft.version, "v"),
        status: "ready",
        prompt: { ...draft.prompt, version: bumpVersion(draft.prompt.version, "p") },
        output: undefined
      };
      const next = await api.saveSupervisionDetail(nextDetail);
      setDocument(next);
      const [nextHistory, nextProgress] = await Promise.all([api.supervisionHistory(), api.supervisionProgress()]);
      setHistory(nextHistory); setProgress(nextProgress);
      setDraft(structuredClone(next.details.find((item) => item.id === draft.id)));
      setCompiledGoal(undefined);
      setDirty(false);
      setMessage("已原子保存为新设计版本；旧产出保留在历史与运行记录中，新版本等待重新执行。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function review(verdict: "accepted" | "needs_revision") {
    if (!draft?.output) return;
    setBusy(true); setMessage(undefined);
    try {
      const next = await api.reviewSupervisionDetail(draft.id, verdict, reviewNote);
      setDocument(next);
      const [nextHistory, nextRuns, nextProgress] = await Promise.all([api.supervisionHistory(), api.supervisionRuns(), api.supervisionProgress()]);
      setHistory(nextHistory); setRuns(nextRuns); setProgress(nextProgress);
      setDraft(structuredClone(next.details.find((item) => item.id === draft.id)));
      setDirty(false);
      setMessage(verdict === "accepted" ? "该设计条目已通过检查。" : `已要求只重做“${categories.find((item) => item.id === draft.category)?.label}”类别。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function dispatch() {
    if (!draft) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await api.dispatchSupervisionDetail(draft.id);
      setDocument(result.document);
      setHistory(await api.supervisionHistory());
      setRuns((current) => [...current.filter((run) => run.id !== result.run.id), result.run]);
      setProgress(result.progress);
      setDraft(structuredClone(result.document.details.find((item) => item.id === draft.id)));
      setDirty(false);
      setMessage(`第 ${result.run.attempt} 次 ${draft.category} 类别 Mock 演练已回挂；它不计为完成证据。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function updateTask(patch: Partial<SupervisionTask>) {
    setTaskDraft((current) => current ? { ...current, ...patch } : current);
    setTaskDirty(true);
    setCompiledGoal(undefined);
  }

  async function saveTask() {
    if (!taskDraft) return;
    setBusy(true); setMessage(undefined);
    try {
      const next = await api.saveSupervisionTask({ ...taskDraft, version: bumpVersion(taskDraft.version, "t"), status: "ready" });
      setDocument(next);
      setTaskDraft(structuredClone(next.tasks.find((task) => task.id === taskDraft.id)));
      setTaskDirty(false);
      setMessage(`任务结构已保存到 ${next.plan.version}；需要重新冻结后才能编译 Goal。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function freezeTask() {
    if (!selectedTaskId) return;
    setBusy(true); setMessage(undefined);
    try {
      const next = await api.freezeSupervisionTask(selectedTaskId);
      setDocument(next);
      setTaskDraft(structuredClone(next.tasks.find((task) => task.id === selectedTaskId)));
      setTaskDirty(false);
      setMessage(`当前任务已冻结为 ${next.plan.version} / ${next.tasks.find((task) => task.id === selectedTaskId)?.version}；后续 Agent 只能按此快照执行。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function importPlan() {
    if (!planText.trim()) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await api.importSupervisionPlan(planText);
      setDocument(result.document);
      setSelectedTaskId(result.imported_task_ids[0] ?? result.document.tasks[0]?.id);
      setPlanImportOpen(false);
      setPlanText("");
      setMessage(`Codex Plan 已导入为 ${result.imported_task_ids.length} 个任务；它们仍可编辑，尚未冻结或派发。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function addTask() {
    setBusy(true); setMessage(undefined);
    try {
      const result = await api.createSupervisionTask();
      setDocument(result.document);
      setSelectedTaskId(result.task.id);
      setSelectedId(result.detail.id);
      setMessage("已新增独立 Plan 任务；先修改任务目标和任务内设计，再冻结。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function addDetail(category: SupervisionCategory) {
    if (!selectedTaskId) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await api.createSupervisionDetail(category, selectedTaskId);
      setDocument(result.document);
      setSelectedId(result.detail.id);
      const [nextHistory, nextProgress] = await Promise.all([api.supervisionHistory(), api.supervisionProgress()]);
      setHistory(nextHistory); setProgress(nextProgress);
      setMessage(`已新增${categories.find((item) => item.id === category)?.label}设计草稿；先完善内容并保存，不会自动派发 Agent。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function sendCompanionFeedback() {
    if (!selectedTaskId || !feedbackText.trim() || !companionContext.canSendFeedback || !companionContext.session) return;
    setBusy(true); setMessage(undefined);
    ++companionRefreshId.current;
    try {
      const result = await api.sendCodexCompanionFeedback(selectedTaskId, feedbackText, companionContext.session.session_id);
      ++companionRefreshId.current;
      setCompanion(result.status);
      setFeedbackText("");
      setMessage("监督反馈已排队；Codex 会在下一个安全回合边界收到，不会中断正在执行的工具。 ");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { ++companionRefreshId.current; setBusy(false); void refresh(); }
  }

  async function bindCompanionSession(sessionId: string) {
    setBusy(true); setMessage(undefined);
    ++companionRefreshId.current;
    try {
      const next = await api.bindCodexCompanionSession(sessionId);
      ++companionRefreshId.current;
      setCompanion(next); setCompanionError(undefined); setFeedbackText("");
      setMessage("已绑定所选 Codex 会话；只有属于此会话的任务可以发送反馈。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { ++companionRefreshId.current; setBusy(false); void refresh(); }
  }

  async function compileGoal() {
    if (!draft) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await api.compileSupervisionGoal(draft.id);
      setCompiledGoal(result);
      setMessage(result.validation?.valid
        ? `已编译成边界明确的正式 Goal；尚未派发。你可先检查工程执行边界，再决定运行。`
        : `Goal 合同未通过门禁：${result.validation?.findings.map((item) => item.message).join("；")}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function dispatchGoal() {
    if (!draft || !compiledGoal) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await api.dispatchSupervisionGoal(draft.id);
      setCompiledGoal(result);
      if (result.document) setDocument(result.document);
      if (result.run) setRuns((current) => [...current.filter((run) => run.id !== result.run!.id), result.run!]);
      if (result.progress) setProgress(result.progress);
      setDirty(false);
      setMessage(result.run?.mode === "mock"
        ? "正式 Goal 已进入完整调度链；当前仍由确定性 Mock 执行，结果会明确标为非真实证据。"
        : "正式 Goal 已进入独立 worktree、Reviewer 与 Integrator 链路，结束后会自动回挂本条设计。"
      );
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function stopRun(run: SupervisionRun) {
    setBusy(true); setMessage(undefined);
    try {
      await api.stopSupervisionRun(run.id);
      await refresh();
      setMessage("已发出精确暂停指令；已完成的文件和运行记录会保留，可从同一任务继续。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function resumeRun(run: SupervisionRun) {
    setBusy(true); setMessage(undefined);
    try {
      await api.resumeSupervisionRun(run.id);
      await refresh();
      setMessage("任务已从保留状态继续，仍使用原来的设计与权限快照。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function openHistory() {
    const latest = [...history].reverse().find((snapshot) => snapshot.details.some((item) => item.id === selectedId));
    setHistoryVersion((current) => current ?? latest?.version);
    setHistoryOpen((current) => !current);
  }

  function restoreHistoryDraft() {
    if (!selectedHistoryDetail) return;
    setDraft((current) => current ? {
      ...current,
      title: selectedHistoryDetail.title,
      intent: selectedHistoryDetail.intent,
      acceptance: structuredClone(selectedHistoryDetail.acceptance),
      prompt: structuredClone(selectedHistoryDetail.prompt),
      execution: selectedHistoryDetail.execution ? structuredClone(selectedHistoryDetail.execution) : undefined
    } : current);
    setCompiledGoal(undefined);
    setDirty(true);
    setHistoryOpen(false);
    setMessage(`已把 ${selectedHistory?.version} 的设计内容载入编辑区；尚未保存，也未派发。`);
  }

  const companionBar = <CodexCompanionBar status={companion} tasks={orderedTasks} taskId={selectedTaskId} busy={busy} error={companionError} onBind={(sessionId) => void bindCompanionSession(sessionId)} onSelectTask={setSelectedTaskId} onRefresh={() => void refresh()} fallback={<details className="companion-plan-fallback"><summary>断线备用：手动导入 Plan</summary><div className="plan-importer"><textarea aria-label="手动导入 Plan 内容" value={planText} rows={3} placeholder={"粘贴 Plan，例如：\n1. 建立事件同步\n2. 验证任务边界"} onChange={(event) => setPlanText(event.target.value)} /><div><small>导入生成可审查任务，不会自动冻结或派发。</small><button disabled={busy || !planText.trim()} onClick={() => void importPlan()}>解析为任务树</button></div></div></details>} />;

  if (!document) return <section className="supervision-loading">{message ?? "正在读取版本化 Plan 任务…"}</section>;
  if (!draft || !selectedTask || !taskDraft) return <section className="supervision-workspace supervision-empty-mode" data-testid="supervision-workspace">{companionBar}<div className="supervision-loading">{document.tasks.length ? "当前任务尚无设计分项，可选择其他任务审查。" : "等待 Codex 同步 Plan；连接后将在这里显示任务。"}</div>{message && <aside className="overview-message">{message}</aside>}</section>;

  const executionReady = !dirty && !taskDirty && selectedTask.status === "frozen" && draft.status !== "draft" && Boolean(
    draft.execution?.ownership_modules.length && draft.execution.write_globs.length && draft.execution.acceptance_commands.length
  );
  const formalControls = <section className="formal-goal-controls" data-testid="formal-goal-controls">
    <header><div><ShieldCheck size={14} /><strong>正式执行链</strong></div><span>Goal · Worktree · Reviewer · Integrator</span></header>
    <p>先把本条设计冻结成工程合同，再显式派发。Agent 结果会回到当前条目逐项对照。</p>
    {compiledGoal && <div className="compiled-goal-mark"><GitBranch size={13} /><span>合同已通过门禁</span><small>{compiledGoal.goal.id}</small></div>}
    <div><button disabled={busy || !executionReady} onClick={compileGoal}>编译正式 Goal</button><button className="primary" disabled={busy || !formalExecutionReady || !compiledGoal || compiledGoal.validation?.valid === false} onClick={dispatchGoal}>派发正式 Goal</button></div>
    {!executionReady && <small>{dirty || taskDirty ? "当前任务有未保存修改；先保存并重新冻结，派发才会使用你正在看的内容。" : selectedTask.status !== "frozen" ? "先检查并冻结当前 Plan 任务；未冻结任务不能编译 Goal。" : "在“工程执行边界”中补齐模块、写入范围与验收命令。"}</small>}
    {executionReady && !formalExecutionReady && <small>正式派发等待真实 Codex 的服务端凭证、显式开关与 Gateway 门禁；确定性 Mock 只能用于上方演练。</small>}
  </section>;

  const workspaceHeader = <header className="supervision-header">
    <div><span className="page-index">CODEX PLAN / {document.plan.version} · {document.plan.status === "frozen" ? "全部冻结" : document.plan.status === "partially_frozen" ? "部分冻结" : "编辑中"}</span><h1>{document.title}</h1><p>{workspaceMode === "overview" ? "用人能理解的方式观看 Codex 怎样执行、停在哪里、下一步需要谁。" : "逐条对照 Plan 要求与 Codex 产出；只有发现偏差时才调整 Prompt。"} <small>{progress?.nextBestAction.reason}</small></p></div>
    <div className="supervision-header-actions">
      <div className="supervision-mode-switch" role="group" aria-label="监督视图"><button className={workspaceMode === "overview" ? "active" : ""} onClick={() => setWorkspaceMode("overview")}>执行监督</button><button className={workspaceMode === "details" ? "active" : ""} onClick={() => setWorkspaceMode("details")}>设计与产出</button></div>
      <div className="supervision-summary"><span><b>{progress?.designProgress ?? 0}%</b> 设计推进</span><span><b>{progress?.evidenceCoverage ?? 0}%</b> 证据覆盖</span><span><b>{accepted}</b> 条已通过</span></div>
    </div>
  </header>;

  if (workspaceMode === "details") return <section className="supervision-workspace supervision-guided-mode" data-testid="supervision-workspace">
    {workspaceHeader}
    {companionBar}
    <GuidedSupervisionDetails
      document={document}
      tasks={orderedTasks}
      task={selectedTask}
      details={taskDetails}
      detail={draft}
      progress={progress}
      companion={companion}
      latestRun={latestRun}
      dirty={dirty}
      busy={busy}
      message={message}
      reviewNote={reviewNote}
      formalControls={formalControls}
      onSelectTask={setSelectedTaskId}
      onSelectDetail={setSelectedId}
      onUpdateDetail={(next) => update(next)}
      onReviewNote={setReviewNote}
      onSave={() => void save()}
      onDispatch={() => void dispatch()}
      onReview={(verdict) => void review(verdict)}
      onRefresh={() => void refresh()}
    />
  </section>;

  if (workspaceMode === "overview") return <section className="supervision-workspace supervision-overview-mode" data-testid="supervision-workspace">
    {workspaceHeader}
    {companionBar}
    <ExecutionSupervisionOverview
      task={selectedTask}
      details={taskDetails}
      selectedDetail={draft}
      runs={runs}
      progress={progress}
      companion={companion}
      feedbackText={feedbackText}
      busy={busy}
      onSelectDetail={setSelectedId}
      onFeedbackText={setFeedbackText}
      onSendFeedback={sendCompanionFeedback}
      onOpenDetails={() => setWorkspaceMode("details")}
      onApproveCurrent={() => void review("accepted")}
      onPause={(run) => void stopRun(run)}
      onResume={(run) => void resumeRun(run)}
    />
    {message && <aside className="overview-message">{message}</aside>}
  </section>;

  return <section className="supervision-workspace" data-testid="supervision-workspace">
    {workspaceHeader}

    {companionBar}

    <section className="plan-task-board" data-testid="plan-task-board">
      <header><div><ListTree size={15} /><strong>Codex Plan 任务</strong><span>{orderedTasks.length} 项 · 每项独立监督</span></div><div><button onClick={() => setPlanImportOpen((open) => !open)}>导入 Codex Plan</button><button onClick={addTask} disabled={busy}><Plus size={13} />新增任务</button></div></header>
      {planImportOpen && <div className="plan-importer"><textarea value={planText} rows={5} placeholder={"粘贴 Codex Plan Mode 输出，例如：\n1. 建立 SSE 事件流\n2. 更新图表与状态\n3. 验证断线恢复"} onChange={(event) => setPlanText(event.target.value)} /><div><small>导入只生成可编辑任务，不会自动冻结、编译或派发。</small><button className="primary" disabled={busy || !planText.trim()} onClick={importPlan}>解析为任务树</button></div></div>}
      <div className="plan-task-list">{orderedTasks.map((task) => {
        const details = document.details.filter((detail) => detail.task_id === task.id);
        const acceptedCount = details.filter((detail) => detail.status === "accepted").length;
        return <button key={task.id} className={task.id === selectedTaskId ? "active" : ""} onClick={() => setSelectedTaskId(task.id)}>
          <span className={`task-order task-${task.status}`}>{task.order + 1}</span><div><strong>{task.title}</strong><small>{details.length} 个设计维度 · {acceptedCount}/{details.length} 已通过 · {progress?.byTask[task.id]?.progress ?? 0}%</small></div><em>{task.status === "frozen" ? "已冻结" : task.status === "ready" ? "待冻结" : "待完善"}</em>
        </button>;
      })}</div>
    </section>

    <div className="supervision-columns">
      <aside className="design-tree" aria-label="设计线">
        <div className="column-title"><strong>任务内设计线</strong><span>{selectedTask.title}</span></div>
        {categories.map((category) => {
          const items = taskDetails.filter((item) => item.category === category.id);
          return <section key={category.id} className="design-category">
            <header><div><strong>{category.label}</strong><span>{category.hint}</span></div><span className="category-actions"><b>{items.length}</b><button className="detail-add" disabled={busy} aria-label={`新增${category.label}设计条目`} title={`新增${category.label}设计条目`} onClick={() => addDetail(category.id)}><Plus size={11} /></button></span></header>
            {items.map((item) => <button key={item.id} className={`detail-select ${item.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(item.id)}>
              <span>{item.title}</span><small className={`detail-status status-${item.status}`}>{statusLabels[item.status]}</small>
            </button>)}
          </section>;
        })}
      </aside>

      <main className="design-editor">
        <div className="column-title"><strong>设计与 Prompt</strong><span>你可直接修改</span></div>
        <div className="editor-scroll">
          <section className={`task-definition task-definition-${selectedTask.status}`}>
            <header><div><span>Plan 任务 · {selectedTask.version}</span><strong>{selectedTask.status === "frozen" ? "已冻结执行快照" : taskDirty ? "有未保存修改" : "可继续调整"}</strong></div><div><button disabled={busy || !taskDirty} onClick={saveTask}><Save size={12} />保存任务</button><button className="primary" disabled={busy || taskDirty || dirty || selectedTask.status === "frozen"} onClick={freezeTask}><ShieldCheck size={12} />冻结当前任务</button></div></header>
            <label>任务名称<input value={taskDraft.title} onChange={(event) => updateTask({ title: event.target.value })} /></label>
            <label>任务主要结果<textarea rows={2} value={taskDraft.objective} onChange={(event) => updateTask({ objective: event.target.value })} /></label>
            <div className="task-structure-fields"><label>执行顺序<input type="number" min={0} value={taskDraft.order + 1} onChange={(event) => updateTask({ order: Math.max(0, Number(event.target.value || 1) - 1) })} /></label><label>依赖任务<select multiple value={taskDraft.dependencies} onChange={(event) => updateTask({ dependencies: [...event.currentTarget.selectedOptions].map((option) => option.value) })}>{orderedTasks.filter((task) => task.id !== taskDraft.id).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div>
            <p>{selectedTask.status === "frozen" ? `后续 Goal 必须引用 ${document.plan.version} / ${selectedTask.version}；修改任务或设计会自动解除冻结。` : "先完善本任务及下面的设计维度；确认后冻结，Agent 才能接收这一版。"}</p>
          </section>
          <div className="detail-heading"><span>{categories.find((item) => item.id === draft.category)?.label}设计 · {draft.version}</span><strong>{draft.title}</strong></div>
          <div className="version-compare"><span><History size={12} />文档 {document.version} · 历史 {history.length} 版</span><strong>{previousDetail ? changedFields.length ? `相对上一版修改：${changedFields.join("、")}` : "设计文字与上一版一致" : "这是当前第一版快照"}</strong></div>
          <button className="history-toggle" type="button" onClick={openHistory}><History size={13} />{historyOpen ? "收起版本比较" : "查看与恢复历史版本"}</button>
          {historyOpen && <section className="history-browser" data-testid="history-browser">
            <aside>{[...history].reverse().filter((snapshot) => snapshot.details.some((item) => item.id === draft.id)).slice(0, 8).map((snapshot) => <button key={snapshot.version} className={snapshot.version === historyVersion ? "active" : ""} onClick={() => setHistoryVersion(snapshot.version)}><strong>{snapshot.version}</strong><small>{new Date(snapshot.updated_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></button>)}</aside>
            <div>{selectedHistoryDetail ? <>
              <header><div><span>选择的历史版本</span><strong>{selectedHistory?.version} · {selectedHistoryDetail.prompt.version}</strong></div><button onClick={restoreHistoryDraft}><Undo2 size={12} />载入编辑区</button></header>
              <div className="history-diff-tags">{historyChangedFields.length ? historyChangedFields.map((field) => <span key={field}>{field}</span>) : <span>与当前编辑内容一致</span>}</div>
              <div className="history-intent-compare"><article><small>当时的目标</small><p>{selectedHistoryDetail.intent}</p></article><article><small>当前编辑内容</small><p>{draft.intent}</p></article></div>
              <p className="history-safety">载入只改变当前编辑框；必须再点“保存新版本”，系统才会写入 YAML。不会自动创建 Goal 或派发 Agent。</p>
            </> : <p>选择左侧版本查看差异。</p>}</div>
          </section>}
          <label>设计标题<input value={draft.title} onChange={(event) => update({ title: event.target.value })} /></label>
          <label>为什么要做<textarea value={draft.intent} rows={3} onChange={(event) => update({ intent: event.target.value })} /></label>
          <label>怎样才算完成<textarea value={draft.acceptance.join("\n")} rows={4} onChange={(event) => update({ acceptance: lines(event.target.value) })} /></label>

          <section className="prompt-editor">
            <header><div><strong>执行 Prompt</strong><span>{draft.prompt.version} · 随设计一起保存版本</span></div></header>
            <label>通用要求<textarea value={draft.prompt.base} rows={3} onChange={(event) => update({ prompt: { ...draft.prompt, base: event.target.value } })} /></label>
            <label>本条细节<textarea value={draft.prompt.local} rows={3} onChange={(event) => update({ prompt: { ...draft.prompt, local: event.target.value } })} /></label>
            <label>参考素材与上下文<textarea aria-label="参考素材与上下文" value={draft.prompt.resources.join("\n")} rows={3} placeholder="每行一个本地路径、URL 或素材 ID；会冻结到本次运行快照" onChange={(event) => update({ prompt: { ...draft.prompt, resources: lines(event.target.value) } })} /></label>
            <div className="prompt-boundaries">
              <label>允许修改<textarea value={draft.prompt.allowed_changes.join("\n")} rows={4} onChange={(event) => update({ prompt: { ...draft.prompt, allowed_changes: lines(event.target.value) } })} /></label>
              <label>禁止修改<textarea value={draft.prompt.forbidden_changes.join("\n")} rows={4} onChange={(event) => update({ prompt: { ...draft.prompt, forbidden_changes: lines(event.target.value) } })} /></label>
            </div>
          </section>
          <details className="execution-scope" data-testid="execution-scope">
            <summary><span>工程执行边界</span><small>高级设置 · 决定 Agent 能改哪里、怎样验收</small></summary>
            <div className="execution-scope-grid">
              <label>所有权模块（最多 2 个）<textarea value={(draft.execution?.ownership_modules ?? []).join("\n")} rows={2} onChange={(event) => updateExecution("ownership_modules", lines(event.target.value))} /></label>
              <label>允许写入的文件范围<textarea value={(draft.execution?.write_globs ?? []).join("\n")} rows={4} onChange={(event) => updateExecution("write_globs", lines(event.target.value))} /></label>
              <label>共享契约锁<textarea value={(draft.execution?.shared_contracts ?? []).join("\n")} rows={2} placeholder="没有可留空" onChange={(event) => updateExecution("shared_contracts", lines(event.target.value))} /></label>
              <label>验收命令<textarea value={(draft.execution?.acceptance_commands ?? []).join("\n")} rows={3} onChange={(event) => updateExecution("acceptance_commands", lines(event.target.value))} /></label>
            </div>
          </details>
          <div className="editor-actions"><span>{message}</span><button onClick={save} disabled={busy}><Save size={14} />{busy ? "保存中" : "保存新版本"}</button></div>
        </div>
      </main>

      <aside className="output-review" aria-label="Agent 产出对照">
        <div className="column-title"><strong>Agent 产出对照</strong><span>{selectedTask.title} · 它实际做出了什么</span></div>
        {draft.output ? <div className="output-scroll">
          <div className={`source-badge source-${draft.output.source}`}><Bot size={14} />{draft.output.source === "mock" ? "确定性 Mock · 非真实 Agent" : draft.output.agent_label}</div>
          {latestRun && <div className="run-snapshot"><span><History size={12} />第 {latestRun.attempt} 次运行</span><span>{categories.find((item) => item.id === latestRun.category)?.label}类别独占</span><span>{latestRun.mode === "external" ? "当前/外部 Agent 回执 · 待人工验收" : latestRun.goal_id ? "正式 Goal 全链路" : "快速 Mock 演练"}</span><span>{latestRun.permission_snapshot.resource_refs.length} 项素材 · {latestRun.permission_snapshot.allowed_changes.length} 项允许 · {latestRun.permission_snapshot.forbidden_changes.length} 项禁止</span></div>}
          <h2>{draft.title}</h2>
          <p className="output-summary">{draft.output.summary}</p>
          {draft.output.artifact_ref && <a className="artifact-link" href={draft.output.artifact_ref} target="_blank" rel="noreferrer">查看可检查产出 <ExternalLink size={13} /></a>}
          <ArtifactComparison detail={draft} />
          <section className="comparison-list"><header><strong>逐项对照</strong><span>{draft.output.checks.length} 项</span></header>
            {draft.output.checks.map((check, index) => <article key={`${check.criterion}-${index}`} className={`check-${check.result}`}>
              <span>{check.result === "pass" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{checkLabels[check.result]}</span>
              <strong>{check.criterion}</strong><p>{check.note}</p>
            </article>)}
          </section>
          <label className="review-note">你的检查意见<textarea value={reviewNote} rows={4} placeholder="例如：移动端标题仍太小，只重做视觉层级。" onChange={(event) => setReviewNote(event.target.value)} /></label>
          <div className="review-actions"><button className="accept" disabled={busy} onClick={() => review("accepted")}><CheckCircle2 size={14} />通过本条</button><button className="revise" disabled={busy} onClick={() => review("needs_revision")}><RotateCcw size={14} />只重做本类</button></div>
          <button className="dispatch-button" disabled={busy || dirty} onClick={dispatch}><Play size={14} />{busy ? "运行中" : dirty ? "先保存当前修改" : "确定性 Mock 演练（不计完成）"}</button>
          {formalControls}
          {message && <p className="review-message">{message}</p>}
        </div> : <div className="output-empty"><Bot size={28} /><h2>尚无 Agent 产出</h2><p>本条设计已经可以单独派发。运行会冻结本条 Prompt 与权限边界，产出回来后按验收条件逐项对照。</p><span>{categories.find((item) => item.id === draft.category)?.label}类别 · {statusLabels[draft.status]}</span><button className="dispatch-button" disabled={busy || dirty} onClick={dispatch}><Play size={14} />{busy ? "运行中" : dirty ? "先保存当前修改" : "确定性 Mock 演练（不计完成）"}</button>{formalControls}{message && <p className="review-message">{message}</p>}</div>}
      </aside>
    </div>
  </section>;
}
