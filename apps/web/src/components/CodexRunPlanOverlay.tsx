import { Bot, Check, ChevronDown, ChevronUp, Circle, CircleDashed, LoaderCircle, LocateFixed, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RunPlanProjection } from "../run-plan-api.ts";
import { groupRunPlanProjections, latestRunPlanProjections, projectionState, runPlanMotion, runPlanSessionLabel, visibleRunPlanSteps, type RunPlanGroupId } from "./run-plan-presentation.ts";

type Props = {
  presentation?: "overlay" | "inline";
  projections: RunPlanProjection[];
  loading: boolean;
  refreshing: boolean;
  error: string;
  transportState: "connecting" | "live" | "offline";
  lastSyncedAt?: string;
  nodeNames: Readonly<Record<string, string>>;
  onRetry: () => void;
  onOpenNode: (nodeId: string) => void;
};

const stateLabel: Record<Exclude<RunPlanProjection["binding"]["state"], "run">, string> = {
  owner: "已对齐负责节点",
  workspace: "项目级观察",
  ambiguous: "归属不唯一",
  unassigned: "尚未归属节点"
};

const transportLabel = {
  connecting: { short: "连接中", detail: "正在连接实时更新通道" },
  live: { short: "实时更新", detail: "计划更新通道正常；这不代表工程任务已经开始执行" },
  offline: { short: "轮询更新", detail: "实时更新通道中断，保留上次状态并定时重试" }
} as const;

function bindingLabel(projection: RunPlanProjection, live = true) {
  if (!live && projection.binding.state === "run") return "上次关联运行";
  if (projection.binding.state === "run" && (projection.lifecycle !== "active" || projection.connection !== "current")) return "已关联运行";
  if (projection.binding.state === "run") return projectionState(projection).key === "executing" ? "执行中" : projection.binding.execution_authorized ? "已关联运行" : "等待领取";
  return stateLabel[projection.binding.state];
}

function updateTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "时间未知";
}

function StepIcon({ status }: { status: RunPlanProjection["steps"][number]["status"] }) {
  if (status === "completed") return <Check size={12} aria-hidden="true" />;
  if (status === "in_progress") return <LoaderCircle size={12} aria-hidden="true" />;
  return <Circle size={10} aria-hidden="true" />;
}

export function CodexRunPlanOverlay({ presentation = "overlay", projections, loading, refreshing, error, transportState, lastSyncedAt, nodeNames, onRetry, onOpenNode }: Props) {
  const [open, setOpen] = useState(presentation === "inline");
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [expandedPlans, setExpandedPlans] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<{ scope: string; ids: ReadonlySet<RunPlanGroupId> }>({ scope: "", ids: new Set() });
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const ordered = useMemo(() => [...projections].sort((a, b) => {
    const priority = (item: RunPlanProjection) => item.lifecycle === "active" && item.connection === "current" ? 3 : item.lifecycle === "active" ? 2 : 1;
    return priority(b) - priority(a) || b.updated_at.localeCompare(a.updated_at);
  }), [projections]);
  const groups = useMemo(() => groupRunPlanProjections(ordered), [ordered]);
  const scope = JSON.stringify([...new Set(projections.map(item => item.workspace_id ?? `${item.session_id}:${item.source_cwd}`))].sort());
  function toggleGroup(id: RunPlanGroupId) {
    setExpandedGroups(value => {
      const ids = new Set(value.scope === scope ? value.ids : []);
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      return { scope, ids };
    });
  }
  const latest = latestRunPlanProjections(ordered), latestReports = new Set(latest);
  const current = latest.filter((item) => item.lifecycle === "active" && item.connection === "current");
  const executing = current.filter((item) => projectionState(item).key === "executing");
  const waiting = current.filter((item) => projectionState(item).key === "waiting");
  const reported = current.filter((item) => projectionState(item).key === "reported");
  const pending = current.filter((item) => projectionState(item).key === "idle");
  const stale = latest.filter((item) => item.lifecycle === "active" && item.connection === "stale");
  const ended = latest.filter((item) => item.lifecycle === "turn_ended");
  const live = transportState === "live" && !error && !loading;
  const headline = loading
    ? "正在读取"
    : error
      ? ordered.length ? "同步中断 · 保留上次状态" : "同步暂不可用"
      : transportState !== "live" && ordered.length
        ? "连接待恢复 · 显示上次报告"
      : executing.length
        ? `${executing.length} 个 Agent 正在执行工程任务`
        : waiting.length
          ? `${waiting.length} 个工程任务等待领取`
          : current.length && reported.length === current.length
            ? "本轮步骤已报告完成"
          : current.length && pending.length === current.length
            ? "等待下一步报告"
          : current.length
            ? `${current.length} 个 Codex 计划正在更新`
            : stale.length
              ? "连接已过期 · 保留上次计划"
              : ended.length ? "本轮已结束" : "等待真实计划";

  const moving = current.some(item => runPlanMotion(item, transportState, pageVisible, Boolean(error) || loading) !== "static");
  useEffect(() => { if (presentation === "overlay" && !ordered.length && !error) setOpen(false); }, [ordered.length, error, presentation]);

  return <aside className={`uw-run-plan ${presentation === "inline" ? "uw-run-plan-inline" : ""} ${open ? "is-open" : ""}`} aria-label="Codex 本轮计划" data-presentation={presentation} data-projection-count={ordered.length} data-transport-state={transportState} data-motion={moving ? "live" : "static"}>
    <button type="button" className="uw-run-plan-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={`uw-run-plan-presence ${live && executing.length ? "is-live" : ""}`} data-execution-state={!live ? "snapshot" : executing.length ? "executing" : waiting.length ? "waiting" : current.length ? "projection" : "idle"}><Bot size={14} /><span>{presentation === "inline" ? "本轮工作进度" : "Codex 本轮"}</span></span>
      <strong role="status" aria-live="polite">{headline}</strong>
      <span className={`uw-run-plan-channel is-${transportState}`} title={transportLabel[transportState].detail}><i />{refreshing ? "更新中" : transportLabel[transportState].short}</span>
      {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
    {open && <div className="uw-run-plan-body">
      <header><div><strong>{presentation === "inline" ? "当前步骤与后续安排" : "当前回合的临时计划"}</strong><span>{presentation === "inline" ? "随 Agent 报告更新当前步骤" : "只映射执行过程，不改变工程结构"}{lastSyncedAt ? ` · 上次读取 ${updateTime(lastSyncedAt)}` : ""}</span></div>{error && <button type="button" aria-label="重试读取 Codex 本轮计划" onClick={onRetry}><RefreshCw size={13} /></button>}</header>
      {loading && <p className="uw-run-plan-empty">正在读取本轮计划…</p>}
      {error && <p className="uw-run-plan-error" role="alert">{ordered.length ? `最新状态读取失败，以下保留上次成功结果：${error}` : error}</p>}
      {!loading && !error && !ordered.length && <p className="uw-run-plan-empty"><CircleDashed size={14} />{presentation === "inline" ? "等待 Agent 报告本轮步骤，收到后会自动显示。" : "Codex 更新本轮计划后，会在这里显示步骤；不会自动生成工程节点。"}</p>}
      {!loading && groups.map(group => {
        const expanded = expandedGroups.scope === scope && expandedGroups.ids.has(group.id);
        return <section className="uw-run-plan-group" key={`${scope}:${group.id}`} aria-label={group.title} data-report-group={group.id}>
          <header className="uw-run-plan-group-head"><h3>{group.title}<span>{group.projections.length} 条</span></h3>{group.projections.length > 1 && <button type="button" aria-expanded={expanded} onClick={() => toggleGroup(group.id)}>{expanded ? "收起更多详情" : `展开全部 ${group.projections.length} 条详情`}</button>}</header>
          {group.projections.map((projection, index) => {
        const detailsVisible = index === 0 || expanded;
        const nodeId = ["run", "owner"].includes(projection.binding.state) ? projection.binding.node_id : null;
        const nodeName = nodeId ? nodeNames[nodeId] ?? nodeId : "";
        const done = projection.steps.filter((step) => step.status === "completed").length;
        const superseded = !latestReports.has(projection);
        const state = superseded ? { key: "superseded", label: "较早的步骤报告" } as const : projectionState(projection);
        const motion = superseded ? "static" : runPlanMotion(projection, transportState, pageVisible, Boolean(error) || loading);
        const currentStep = projection.steps.find(step => step.status === "in_progress");
        const visibleSteps = expandedPlans.has(projection.id) ? projection.steps : visibleRunPlanSteps(projection);
        const stepLabel = superseded ? "较早报告步骤" : state.key === "waiting" ? "等待领取 · 上次报告步骤" : state.key === "ended" ? "回合已结束 · 最后报告步骤" : state.key === "stale" || transportState !== "live" || error ? "上次报告步骤" : state.key === "executing" ? "工程当前步骤" : "Agent 报告当前步骤";
        return <section className={`uw-run-plan-agent${detailsVisible ? "" : " is-compact"}`} key={projection.id} data-projection-id={projection.id} data-session-id={projection.session_id} data-binding-state={projection.binding.state} data-lifecycle={projection.lifecycle} data-projection-state={state.key} data-motion={motion}>
          <div className="uw-run-plan-agent-head"><div><strong>{!live && !superseded ? `上次报告：${state.label}` : state.label}</strong><span className="uw-run-plan-identity" title={projection.session_id}>会话 {runPlanSessionLabel(projection.session_id)}</span><span>{done}/{projection.steps.length} 步已报告 · 更新 {updateTime(projection.updated_at)}</span></div><span className={live && state.key === "executing" ? "is-authorized" : live && state.key === "waiting" ? "is-waiting" : ""}>{superseded ? "较早的关联记录" : bindingLabel(projection, live)}</span></div>
          {nodeId && <button type="button" className="uw-run-plan-target" onClick={() => onOpenNode(nodeId)}><LocateFixed size={12} /><span>对应：{nodeName}</span></button>}
          {currentStep && <p className="uw-run-plan-current"><span>{stepLabel}</span><strong>{currentStep.title}</strong></p>}
          {detailsVisible && <>
          <ol>{visibleSteps.map((step) => <li key={step.id} data-status={step.status}><StepIcon status={step.status} /><span>{step.title}</span></li>)}</ol>
          {projection.steps.length > 7 && <button type="button" className="uw-run-plan-expand" aria-expanded={expandedPlans.has(projection.id)} onClick={() => setExpandedPlans(value => { const next = new Set(value); if (next.has(projection.id)) next.delete(projection.id); else next.add(projection.id); return next; })}>{expandedPlans.has(projection.id) ? "收起较早与后续步骤" : `查看全部 ${projection.steps.length} 步`}</button>}
          {projection.binding.reason && <p className="uw-run-plan-reason">{projection.binding.reason}</p>}
          </>}
        </section>;
          })}
        </section>;
      })}
      <footer>{presentation === "inline" ? "勾选表示 Agent 自报进度；成果和检查结论以实际记录为准。" : "计划打勾只表示 Agent 自报进度；工程完成仍以原节点的成果与验收为准。"}</footer>
    </div>}
  </aside>;
}
