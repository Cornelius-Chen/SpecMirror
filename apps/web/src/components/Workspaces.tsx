import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, FlaskConical, Inbox, KeyRound, LockKeyhole, Play, RefreshCcw, ShieldCheck, Square } from "lucide-react";
import { api } from "../api.ts";
import { cancelHumanApproval } from "../human-approval-client.ts";
import type { CodexReadiness, Entity, ProjectMap, RuntimeStatus, SupervisionRun } from "../types.ts";
import { StatusMark } from "./StatusMark.tsx";

export function InboxWorkspace({ data, reload }: { data: ProjectMap; reload(): Promise<void> }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!title.trim()) return; setBusy(true); await api.capture(title.trim()); setTitle(""); await reload(); setBusy(false); }
  return <WorkspaceShell title="Inbox" subtitle="捕获时零摩擦，评审时再结构化。">
    <form className="capture-line" onSubmit={submit}><Inbox size={18} /><input aria-label="新想法" placeholder="十秒内记下一个想法…" value={title} onChange={(event) => setTitle(event.target.value)} /><button disabled={busy || !title.trim()}>捕获</button></form>
    <EntityTable items={data.collections.ideas ?? []} columns={["title", "status", "created_at"]} empty="Inbox 为空。" />
  </WorkspaceShell>;
}

export function ClaimsWorkspace({ data }: { data: ProjectMap }) {
  return <WorkspaceShell title="Claims & Evidence" subtitle="置信度必须来自证据，不是手工填写的感觉。">
    <div className="split-ledger"><section><h3>关键主张</h3><EntityTable items={data.collections.claims ?? []} columns={["title", "kind", "status", "confidence"]} /></section><section><h3>证据账本</h3><EntityTable items={data.collections.evidence ?? []} columns={["title", "strength", "status", "source"]} /></section></div>
    <h3 className="section-title">决策依据健康</h3><EntityTable items={data.collections.decisionHealth ?? []} columns={["title", "health", "confidence", "reason"]} empty="尚无需要计算的决策依据。" />
  </WorkspaceShell>;
}

export function ChangesWorkspace({ data, formalExecutionReady = false }: { data: ProjectMap; formalExecutionReady?: boolean }) {
  const [message, setMessage] = useState("");
  async function action(id: string, dispatch: boolean) { const result = dispatch ? await api.dispatch(id) : await api.compile(id); setMessage(JSON.stringify(result, null, 2)); }
  return <WorkspaceShell title="Change Sets" subtitle="固定起始 SHA、依赖 DAG、写域、基线与验收命令。">
    <div className="change-ledger">{(data.collections.changes ?? []).map((change) => {
      const goalIds = Array.isArray(change.goal_ids) ? change.goal_ids.map(String) : [];
      const requiresCodex = (data.collections.goals ?? []).some((goal) => goalIds.includes(goal.id) && goal.required_gateway === "codex-app-server");
      return <article key={change.id} className="change-row"><div><StatusMark status={change.status} /><h3>{change.title}</h3><code>{change.id} · {String(change.start_sha)}</code></div><div className="change-actions"><button onClick={() => action(change.id, false)}><RefreshCcw size={14} />编译</button><button className="primary" disabled={requiresCodex && !formalExecutionReady} title={requiresCodex && !formalExecutionReady ? "Mock 不能把正式 Goal 标成已完成" : undefined} onClick={() => action(change.id, true)}><Play size={14} />{requiresCodex && !formalExecutionReady ? "等待真实 Codex" : "受控派发"}</button></div></article>;
    })}</div>
    {message && <pre className="action-output">{message}</pre>}
  </WorkspaceShell>;
}

type LiveControlEvent = { id: number; message: string; type: string; goalId?: string; at?: string; data?: { direction?: string; phase?: string; itemType?: string } };

export function GoalsWorkspace({ data, reload, events = [], readonly = false }: { data: ProjectMap; reload(): Promise<void>; events?: LiveControlEvent[]; readonly?: boolean }) {
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  const [supervisionRuns, setSupervisionRuns] = useState<SupervisionRun[]>([]);
  const [supervisionTitles, setSupervisionTitles] = useState<Record<string, string>>({});
  const [runtimeError, setRuntimeError] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [actionMessage, setActionMessage] = useState("");
  const [busyRun, setBusyRun] = useState<string>();
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const [status, runs, document] = await Promise.all([api.status(), api.supervisionRuns(), api.supervision()]);
        if (!disposed) { setRuntime(status); setSupervisionRuns(runs); setSupervisionTitles(Object.fromEntries(document.details.map((detail) => [detail.id, detail.title]))); setRuntimeError(""); }
      } catch (error) { if (!disposed) setRuntimeError(error instanceof Error ? error.message : String(error)); }
    };
    void refresh(); const interval = setInterval(() => { void refresh(); }, 2500);
    return () => { disposed = true; clearInterval(interval); };
  }, [refreshNonce]);
  const activeSupervision = supervisionRuns.filter((run) => ["queued", "running"].includes(run.status));
  const activeIds = [...(runtime?.active ?? []), ...activeSupervision.filter((run) => !run.goal_id).map((run) => run.id)];
  const goals = data.collections.goals ?? [];
  const agentRuns = data.collections.runs ?? [];
  const latestSupervision = [...supervisionRuns].reverse().filter((run, index, all) => all.findIndex((item) => item.detail_id === run.detail_id) === index);
  async function runAction(id: string, action: "stop" | "resume", supervision = false) {
    setBusyRun(id); setActionMessage("");
    try {
      if (supervision) await (action === "stop" ? api.stopSupervisionRun(id) : api.resumeSupervisionRun(id));
      else await (action === "stop" ? api.stopRun(id) : api.resumeRun(id));
      await reload();
      const [status, nextRuns] = await Promise.all([api.status(), api.supervisionRuns()]);
      setRuntime(status); setSupervisionRuns(nextRuns);
      setActionMessage(action === "stop" ? "运行已停止，worktree 与线程信息已保留。" : "运行已从保留现场恢复；完成后会重新回挂设计条目。");
    } catch (error) { setActionMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusyRun(undefined); }
  }
  return <WorkspaceShell title="Goals & Runs" subtitle="Goal 是持久目标与可验证停止条件，不是开放式积压。">
    {runtimeError && <div className="workspace-error"><span>运行状态暂时不可用：{runtimeError} · 系统会自动重试</span><button onClick={() => setRefreshNonce((value) => value + 1)}>立即重试</button></div>}
    {actionMessage && <div className="run-action-message">{actionMessage}</div>}
    {readonly
      ? <section className="archive-control-notice"><LockKeyhole size={16} /><div><strong>历史运行仅供查阅</strong><span>真实 Codex 运行与本机确认只在当前任务工作区提供。</span></div></section>
      : <CodexReadinessPanel />}
    <section className="scheduler-board">
      <header><div><span className="page-index">WORKER POOL</span><h3>多任务调度器</h3></div><p>{activeIds.length}/{runtime?.maxWorkers ?? 3} 槽位占用 · {runtime?.gateway ?? "mock"}</p></header>
      <div className="worker-slots">{Array.from({ length: runtime?.maxWorkers ?? 3 }, (_, index) => {
        const activeId = activeIds[index];
        const goal = goals.find((item) => item.id === activeId);
        const supervision = activeSupervision.find((item) => item.id === activeId || item.goal_id === activeId);
        return <article key={index} className={activeId ? "busy" : "idle"}><span>Worker {index + 1}</span>{activeId ? <><strong>{goal?.title ?? `设计分类运行 · ${supervision?.category}`}</strong><small>{activeId}</small></> : <><strong>空闲 · 可接独立任务</strong><small>无写域或类别冲突</small></>}</article>;
      })}</div>
      <div className="scheduler-queues"><span><Play size={12} />可运行 {(runtime?.runnable ?? []).length}</span><span><LockKeyhole size={12} />等待 {(runtime?.waiting ?? []).length}</span><span className={(runtime?.blocked ?? []).length ? "danger" : ""}><ShieldCheck size={12} />阻塞 {(runtime?.blocked ?? []).length}</span></div>
    </section>
    <section className="live-agent-flow" data-testid="live-agent-flow">
      <header><div><span className="page-index">CODEX INPUT / OUTPUT</span><h3>受控输入输出实时流</h3></div><p>只显示脱敏后的合同输入、Agent 输出与阶段状态</p></header>
      <div>{events.length ? [...events].reverse().map((event) => <article key={event.id}>
        <time>{event.at ? new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }) : `#${event.id}`}</time>
        <span className={`event-direction direction-${event.data?.direction ?? "status"}`}>{event.data?.direction === "input" ? "输入" : event.data?.direction === "output" ? "输出" : "状态"}</span>
        <div><strong>{event.goalId ?? event.type}</strong><p>{event.message}</p></div>
        <small>{event.data?.phase ?? event.type}</small>
      </article>) : <div className="empty-ledger">尚无受控 Worker 事件；派发后将在这里对照输入与输出。</div>}</div>
    </section>
    <h3 className="section-title">Goal 依赖与停止条件</h3>
    <div className="goal-timeline">{goals.map((goal) => <article key={goal.id}><div className="timeline-pin" /><div className="goal-main"><StatusMark status={goal.status} /><h3>{goal.title}</h3><p>{String(goal.outcome)}</p><code>{(goal.write_globs as string[])?.join(" · ")}</code></div><ArrowRight size={16} /></article>)}</div>
    <h3 className="section-title">设计分类运行</h3>
    <div className="supervision-run-ledger">{latestSupervision.length ? latestSupervision.map((run) => <article key={run.id}><Bot size={15} /><div><strong>{supervisionTitles[run.detail_id] ?? run.detail_id}</strong><span>{run.category} · 第 {run.attempt} 次 · {run.goal_id ? "正式 Goal" : "快速演练"} · {run.mode === "mock" ? "确定性 Mock" : "Codex"}</span></div><div className="run-row-actions"><StatusMark status={run.status} />{!readonly && run.agent_run_id && ["queued", "running"].includes(run.status) && <button disabled={busyRun === run.id} onClick={() => runAction(run.id, "stop", true)}>停止</button>}{!readonly && run.agent_run_id && ["failed", "stopped", "needs_revision"].includes(run.status) && <button disabled={busyRun === run.id} onClick={() => runAction(run.id, "resume", true)}>恢复</button>}</div></article>) : <div className="empty-ledger">尚无设计分类运行。</div>}</div>
    <h3 className="section-title">运行记录</h3>
    <div className="agent-run-ledger">{agentRuns.length ? agentRuns.map((run) => {
      const supervised = supervisionRuns.some((item) => item.agent_run_id === run.id);
      return <article key={run.id}><div><strong>{run.goal_id as string}</strong><span>{run.id} · {String(run.gateway)}</span></div><StatusMark status={String(run.status)} />{!readonly && !supervised && ["planning", "implementing", "reviewing", "integrating"].includes(String(run.status)) && <button disabled={busyRun === run.id} onClick={() => runAction(run.id, "stop")}>停止并保留</button>}{!readonly && !supervised && ["failed", "blocked", "stopped"].includes(String(run.status)) && <button disabled={busyRun === run.id} onClick={() => runAction(run.id, "resume")}>从现场恢复</button>}</article>;
    }) : <div className="empty-ledger">尚无 AgentRun。</div>}</div>
    <h3 className="section-title">Reviewer 证据</h3><EntityTable items={data.collections.reviews ?? []} columns={["title", "status", "requirements_diff_tests", "evidence_complete"]} empty="尚无 Reviewer 记录。" />
  </WorkspaceShell>;
}

export function CodexReadinessPanel({ workspaceId = "host" }: { workspaceId?: string }) {
  const [readiness, setReadiness] = useState<CodexReadiness>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<"start" | "stop">();
  const approvalController = useRef<AbortController | undefined>(undefined);
  const approvalAttempt = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const refresh = async () => { try { const next = await api.codexReadiness(); if (!disposed) setReadiness(next); } catch (error) { if (!disposed) setMessage(error instanceof Error ? error.message : String(error)); } };
    void refresh(); const interval = setInterval(() => { void refresh(); }, 2500);
    return () => { mounted.current = false; disposed = true; clearInterval(interval); approvalAttempt.current += 1; approvalController.current?.abort(); cancelHumanApproval(); };
  }, []);
  async function smoke(action: "start" | "stop") {
    const attempt = ++approvalAttempt.current;
    const controller = new AbortController();
    approvalController.current = controller;
    setBusy(true); setMessage("");
    try {
      await (action === "start" ? api.startCodexSmoke(controller.signal, workspaceId) : api.stopCodexSmoke(controller.signal, workspaceId));
      if (attempt !== approvalAttempt.current) return;
      const next = await api.codexReadiness(controller.signal);
      if (attempt !== approvalAttempt.current) return;
      setReadiness(next);
      setMessage("");
    } catch (error) { if (attempt === approvalAttempt.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (attempt === approvalAttempt.current) { approvalController.current = undefined; setBusy(false); setPendingAction(undefined); } }
  }
  function cancelApproval() {
    const wasBusy = busy;
    const attempt = ++approvalAttempt.current;
    approvalController.current?.abort();
    approvalController.current = undefined;
    cancelHumanApproval();
    setBusy(false);
    setPendingAction(undefined);
    if (!wasBusy) { setMessage("已取消系统验证，没有启动烟测。"); return; }
    setMessage("已取消系统验证；正在核对烟测状态…");
    void new Promise((resolve) => setTimeout(resolve, 300)).then(async () => {
      const next = await api.codexReadiness();
      if (!mounted.current || attempt !== approvalAttempt.current) return;
      setReadiness(next);
      setMessage(next.smoke.status === "idle"
        ? "已取消系统验证，没有启动烟测。"
        : next.smoke.status === "running"
          ? "验证取消时烟测已经启动；可在这里确认后停止。"
          : "系统验证已取消；烟测已结束，请查看当前结果。");
    }).catch((error) => {
      if (mounted.current && attempt === approvalAttempt.current) setMessage(`系统验证已取消；烟测状态暂时无法核对：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (!readiness) return <section className="codex-readiness loading">正在核对真实 Codex 安全门禁…</section>;
  const smokePassed = readiness.smoke.status === "passed";
  const smokeEvidenceVerified = readiness.smoke.evidence_status === "verified" && Boolean(readiness.smoke.receipt);
  const smokeEvidenceInvalid = readiness.smoke.evidence_status === "invalid";
  const smokePassedTitle = smokeEvidenceVerified ? "最小执行链路已通过" : smokeEvidenceInvalid ? "曾通过，记录待核对" : "曾通过，仅保留摘要";
  const startedAt = Date.parse(readiness.smoke.started_at ?? "");
  const finishedAt = Date.parse(readiness.smoke.finished_at ?? "");
  const elapsedSeconds = Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
    ? Math.round((finishedAt - startedAt) / 1000) : undefined;
  const duration = elapsedSeconds === undefined ? undefined : elapsedSeconds < 60
    ? `${elapsedSeconds} 秒` : `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`;
  return <section className="codex-readiness" data-testid="codex-readiness">
    <header><div><span className="page-index">LIVE CODEX GATE</span><h3>真实 Codex 启用门禁</h3></div><div className={`readiness-state ${readiness.ready_to_run ? "ready" : "waiting"}`}><KeyRound size={14} /><strong>{readiness.ready_to_run ? "可以执行安全烟测" : "真实执行尚未就绪"}</strong><small>{readiness.selected_model ? `${readiness.selected_model} · ` : ""}Codex {readiness.locked_codex_version}</small></div></header>
    <p>Mirror 只核对本机 Codex 登录状态，不展示登录内容。可复用现有 ChatGPT 登录，也可使用隔离的服务端 API Key。</p>
    <div className="readiness-checks">{readiness.checks.map((check) => {
      const status = check.id === "smoke" && smokePassed && !smokeEvidenceVerified ? "waiting" : check.status;
      const note = check.id === "smoke" && smokePassed ? smokeEvidenceVerified ? "临时 README 任务通过" : smokePassedTitle : check.note;
      return <article key={check.id} className={`check-${status}`}><span>{["ready", "passed"].includes(status) ? "✓" : status === "running" ? "…" : "○"}</span><div><strong>{check.title}</strong><small>{note}</small></div></article>;
    })}</div>
    <footer><div><FlaskConical size={14} /><span>
      <strong>{smokePassed ? smokePassedTitle : readiness.smoke.status === "running" ? "真实烟测进行中" : "临时仓库烟测"}</strong>
      <small>{smokePassed ? "仅验证临时仓库 README 任务；实际工程和双 Agent 协作尚未验证。" : readiness.smoke.message}</small>
      {(duration || smokeEvidenceVerified || smokeEvidenceInvalid || smokePassed) && <small className="codex-smoke-meta">
        {duration && <span>耗时 {duration}</span>}
        {smokeEvidenceVerified ? <a href="/api/codex/smoke/receipt" download>下载运行记录</a> : smokeEvidenceInvalid ? <span>运行记录已变化，需重新核对</span> : smokePassed && <span>这次只保留了通过摘要</span>}
      </small>}
    </span></div>{readiness.smoke.status === "running" ? <button disabled={busy} onClick={() => { setMessage(""); setPendingAction("stop"); }}><Square size={12} />停止并保留</button> : <button className="primary" disabled={busy || !readiness.ready_to_run} onClick={() => { setMessage(""); setPendingAction("start"); }}><Play size={12} />{readiness.ready_to_run ? "开始真实安全烟测" : "等待门禁就绪"}</button>}</footer>
    {pendingAction && <div className="codex-approval-confirm" role="group" aria-label="准备打开 Windows Hello"><div><strong>{pendingAction === "start" ? "准备打开本机验证" : "准备确认停止烟测"}</strong><span>下一步会短暂切走窗口焦点，请先退出全屏游戏。浏览器仍可能显示手机二维码；看到二维码请取消。服务器只接受本机平台验证，跨设备结果会被拒绝。</span></div><div><button type="button" onClick={cancelApproval}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => void smoke(pendingAction)}>{busy ? "等待 Windows Hello…" : pendingAction === "start" ? "我已准备，打开 Windows Hello" : "确认并打开 Windows Hello"}</button></div></div>}
    {message && <div className="codex-readiness-message">{message}</div>}
  </section>;
}

function WorkspaceShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <main className="workspace-page"><header><span className="page-index">PROJECT CONTROL / {title.toUpperCase()}</span><h1>{title}</h1><p>{subtitle}</p></header>{children}</main>;
}

function EntityTable({ items, columns, empty = "暂无记录。" }: { items: Entity[]; columns: string[]; empty?: string }) {
  if (!items.length) return <div className="empty-ledger">{empty}</div>;
  return <div className="entity-table"><div className="table-row table-head">{columns.map((column) => <span key={column}>{humanColumn(column)}</span>)}</div>{items.map((item) => <div className="table-row" key={item.id}>{columns.map((column) => <span key={column}>{column === "status" ? <StatusMark status={String(item[column])} /> : formatValue(item[column])}</span>)}</div>)}</div>;
}

function formatValue(value: unknown) { if (typeof value === "number" && value <= 1) return `${Math.round(value * 100)}%`; return value == null ? "—" : String(value); }
function humanColumn(column: string) { return ({ title: "标题", status: "状态", health: "决策健康", reason: "计算说明", created_at: "捕获时间", kind: "类型", confidence: "置信度", strength: "强度", source: "来源", id: "运行", goal_id: "Goal", gateway: "Gateway", finished_at: "结束时间", requirements_diff_tests: "需求—差异—测试", evidence_complete: "证据完整" } as Record<string, string>)[column] ?? column; }
