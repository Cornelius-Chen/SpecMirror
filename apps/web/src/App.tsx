import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Boxes, GitPullRequestArrow, Inbox, LibraryBig, Menu, Network, Radio, Scale, ScanSearch, ShieldCheck } from "lucide-react";
import { api } from "./api.ts";
import { Inspector } from "./components/Inspector.tsx";
import { FieldTraceLens } from "./components/FieldTraceLens.tsx";
import { DesignSupervisionWorkspace } from "./components/DesignSupervisionWorkspace.tsx";
import { UnifiedTaskWorkspace } from "./components/UnifiedTaskWorkspace.tsx";
import { CapabilityWorkspace } from "./components/CapabilityWorkspace.tsx";
import { SpecMap } from "./components/SpecMap.tsx";
import { TaskAcceptanceMap } from "./components/TaskAcceptanceMap.tsx";
import { TopMetrics } from "./components/TopMetrics.tsx";
import { ChangesWorkspace, ClaimsWorkspace, GoalsWorkspace, InboxWorkspace } from "./components/Workspaces.tsx";
import type { Entity, ProjectMap } from "./types.ts";

type View = "supervision" | "capabilities" | "map" | "inbox" | "claims" | "changes" | "goals";
type UiEvent = { id: number; message: string; type: string; goalId?: string; at?: string; data?: { direction?: string; phase?: string; itemType?: string } };
const nav = [
  { id: "supervision", label: "设计监督", icon: ScanSearch }, { id: "map", label: "规格地图", icon: Network }, { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "claims", label: "主张与证据", icon: Scale }, { id: "changes", label: "变更集", icon: GitPullRequestArrow },
  { id: "goals", label: "Goals 与运行", icon: Activity }, { id: "capabilities", label: "能力与授权", icon: LibraryBig }
] as const;

export function App() {
  return new URLSearchParams(window.location.search).get("workspace") === "archive"
    ? <LegacyApp />
    : <UnifiedTaskWorkspace />;
}

function LegacyApp() {
  const [data, setData] = useState<ProjectMap>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>("supervision");
  const [mapMode, setMapMode] = useState<"review" | "technical">("review");
  const [technicalMode, setTechnicalMode] = useState<"fields" | "graph">("fields");
  const [selected, setSelected] = useState<Entity>();
  const [impacted, setImpacted] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<UiEvent[]>([]);
  const [health, setHealth] = useState<{ gateway: string; credential: string; runtime: string; enabled: boolean }>();
  const reload = useCallback(async () => { try { const [map, nextHealth] = await Promise.all([api.map(), api.health()]); setData(map); setHealth(nextHealth); setError(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const stream = new EventSource("/api/events");
    const pending: UiEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      const batch = pending.splice(0);
      if (!batch.length) return;
      setEvents((current) => [...current, ...batch].slice(-8));
      void reload();
    };
    stream.onmessage = (event) => {
      pending.push(JSON.parse(event.data) as UiEvent);
      if (!flushTimer) flushTimer = setTimeout(flush, 80);
    };
    return () => {
      stream.close();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [reload]);
  async function select(entity: Entity) { setSelected(entity); const result = await api.impact(entity.id); setImpacted(new Set(result.transitive)); }
  const content = useMemo(() => {
    if (!data) return null;
    if (view === "supervision") return <DesignSupervisionWorkspace formalExecutionReady={health?.gateway === "codex-app-server" && health.credential === "configured" && health.runtime === "ready" && health.enabled} />;
    if (view === "capabilities") return <CapabilityWorkspace />;
    if (view === "inbox") return <InboxWorkspace data={data} reload={reload} />;
    if (view === "claims") return <ClaimsWorkspace data={data} />;
    if (view === "changes") return <ChangesWorkspace data={data} formalExecutionReady={health?.gateway === "codex-app-server" && health.credential === "configured" && health.runtime === "ready" && health.enabled} />;
    if (view === "goals") return <GoalsWorkspace data={data} reload={reload} events={events} readonly />;
    return <div className="map-workspace spec-map-workspace">
      <header className="spec-map-header"><div><span>规格地图</span><strong>{mapMode === "review" ? "按 Plan 逐项检查 Agent 产出" : "代码、测试与正式关系仅供深入追查"}</strong></div><div role="tablist" aria-label="规格地图模式"><button role="tab" aria-selected={mapMode === "review"} className={mapMode === "review" ? "active" : ""} onClick={() => setMapMode("review")}>任务验收</button><button role="tab" aria-selected={mapMode === "technical"} className={mapMode === "technical" ? "active" : ""} onClick={() => setMapMode("technical")}>技术追踪</button></div></header>
      {mapMode === "review"
        ? <TaskAcceptanceMap refreshToken={events.at(-1)?.id} onOpenSupervision={() => setView("supervision")} onOpenTechnical={() => setMapMode("technical")} />
        : <div className={`workbench-grid technical-trace-workbench ${technicalMode === "graph" ? "graph-only" : ""}`}><div className="trace-stage"><header className="trace-viewbar"><div><strong>技术追踪 · 高级</strong><span>{technicalMode === "fields" ? "设计字段与实现位置的正式对应" : "项目实体关系与影响传播"}</span></div><div role="group" aria-label="追踪视图"><button className={technicalMode === "fields" ? "active" : ""} onClick={() => setTechnicalMode("fields")}>字段 ↔ 代码</button><button className={technicalMode === "graph" ? "active" : ""} onClick={() => { setTechnicalMode("graph"); setSelected(undefined); setImpacted(new Set()); }}>关系图</button></div></header>{technicalMode === "fields" ? <FieldTraceLens data={data} onSelect={select} /> : <SpecMap data={data} selectedId={selected?.id} impactedIds={impacted} onSelect={select} />}</div>{technicalMode === "fields" && <Inspector entity={selected} edges={data.edges} onClose={() => { setSelected(undefined); setImpacted(new Set()); }} />}</div>}
    </div>;
  }, [data, view, reload, selected, impacted, mapMode, technicalMode, events, health]);

  if (error) return <div className="fatal-state"><Radio size={30} /><h1>本地控制面未连接</h1><p>{error}</p><button onClick={reload}>重试</button></div>;
  if (!data) return <div className="loading-state"><span /><p>正在重建项目视图…</p></div>;
  const runtimeLabel = health?.gateway === "codex-app-server"
    ? health.credential !== "configured" ? "Codex · 等待本地凭证" : health.enabled ? "Codex · 已启用" : "Codex · 等待显式启用"
    : "本地 · Mock Gateway";
  return <div className={`app-shell view-${view}`}>
    <header className="topbar"><div className="brand"><span className="brand-mark"><Boxes size={17} /></span><div><strong>映构</strong><small>SPEC MIRROR</small></div></div><div className="project-title"><span>历史档案 · 只读</span><small title={data.nextBestAction.reason}>下一步 · {data.nextBestAction.title}</small></div><div className="runtime-state" title={runtimeLabel}><a href="/">当前任务请返回统一工作区 →</a></div><button className="menu-button" aria-label="菜单"><Menu size={18} /></button></header>
    <TopMetrics data={data} />
    <div className="body-shell"><nav className="side-nav" aria-label="工作区">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}><Icon size={17} /><span>{label}</span></button>)}<div className="nav-spacer" /><div className="baseline-seal"><ShieldCheck size={18} /><div><strong>X0 · 已保护</strong><span>100% guarded</span></div></div></nav><div className="content-shell">{content}</div></div>
    {events.length > 0 && <aside className="event-ticker"><span><Radio size={13} />事件流</span><p>{events.at(-1)?.message}</p></aside>}
  </div>;
}
