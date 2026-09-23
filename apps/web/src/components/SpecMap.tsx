import { useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, CircleAlert, CircleCheck, FileCode2, GitBranch, Layers3, ShieldCheck } from "lucide-react";
import type { Entity, ProjectMap, TraceEdge } from "../types.ts";
import { StatusMark } from "./StatusMark.tsx";

type MapLevel = "overview" | "task" | "technical";
type GroupFilter = "all" | "active" | "risk";

interface TaskGroup {
  id: string;
  title: string;
  status: string;
  change?: Entity;
  designs: Entity[];
  goals: Entity[];
  engineering: Entity[];
  isUnassigned?: boolean;
}

const riskStatuses = new Set(["blocked", "failed", "deferred", "at_risk", "needs_revision"]);
const activeStatuses = new Set(["draft", "approved", "compiled", "planning", "implementing", "reviewing", "integrating", "active", "running"]);
const relationLabels: Record<string, string> = {
  informs: "提供依据",
  constrains: "约束",
  implemented_by: "落实为",
  supports: "提供证据",
  verifies: "验证",
  depends_on: "依赖"
};
const kindLabels: Record<string, string> = {
  claim: "主张",
  decision: "决策",
  design: "设计",
  constraint: "约束",
  engineering: "工程单元",
  goal: "执行 Goal",
  evidence: "证据",
  review: "审查",
  run: "运行记录"
};

function stringList(entity: Entity, key: string) {
  const value = entity[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function collection(data: ProjectMap, key: string) {
  return data.collections[key] ?? [];
}

function unique(items: Entity[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function groupTone(group: TaskGroup) {
  const statuses = [...group.designs, ...group.goals].map((item) => item.status ?? "");
  if (statuses.some((status) => riskStatuses.has(status))) return "risk";
  if (statuses.some((status) => activeStatuses.has(status))) return "active";
  return "protected";
}

function entityKind(entity: Entity, kindById: Map<string, string>) {
  return kindById.get(entity.id) ?? entity.kind ?? "item";
}

function taskGroups(data: ProjectMap): TaskGroup[] {
  const changes = collection(data, "changes");
  const designs = collection(data, "design");
  const goals = collection(data, "goals");
  const engineering = collection(data, "engineering");
  const assignedDesigns = new Set<string>();
  const assignedGoals = new Set<string>();

  const groups: TaskGroup[] = changes.map((change) => {
    const designIds = new Set(stringList(change, "design_ids"));
    const goalIds = new Set(stringList(change, "goal_ids"));
    const groupedDesigns = designs.filter((item) => designIds.has(item.id));
    const groupedGoals = goals.filter((item) => goalIds.has(item.id) || item.change_set_id === change.id);
    groupedDesigns.forEach((item) => assignedDesigns.add(item.id));
    groupedGoals.forEach((item) => assignedGoals.add(item.id));
    const groupedEngineering = engineering.filter((item) => stringList(item, "design_ids").some((id) => designIds.has(id)));
    return {
      id: change.id,
      title: change.title ?? change.id,
      status: change.status ?? "draft",
      change,
      designs: groupedDesigns,
      goals: groupedGoals,
      engineering: groupedEngineering
    };
  });

  const unassignedDesigns = designs.filter((item) => !assignedDesigns.has(item.id));
  const unassignedGoals = goals.filter((item) => !assignedGoals.has(item.id));
  if (unassignedDesigns.length || unassignedGoals.length) {
    groups.push({
      id: "unassigned",
      title: "待归类与旧草案",
      status: "draft",
      designs: unassignedDesigns,
      goals: unassignedGoals,
      engineering: [],
      isUnassigned: true
    });
  }
  return groups;
}

function connectedEntities(data: ProjectMap, seeds: string[], maxDepth = 4) {
  const byId = new Map(data.nodes.map((entity) => [entity.id, entity]));
  const visited = new Set(seeds);
  let frontier = new Set(seeds);
  for (let depth = 0; depth < maxDepth && frontier.size; depth += 1) {
    const next = new Set<string>();
    for (const edge of data.edges) {
      if (frontier.has(edge.from) && !visited.has(edge.to)) next.add(edge.to);
      if (frontier.has(edge.to) && !visited.has(edge.from)) next.add(edge.from);
    }
    next.forEach((id) => visited.add(id));
    frontier = next;
  }
  return [...visited].map((id) => byId.get(id)).filter((item): item is Entity => Boolean(item));
}

function EntityButton({ entity, kind, impacted, onClick }: { entity: Entity; kind: string; impacted: boolean; onClick(): void }) {
  return <button className={`logic-entity ${impacted ? "is-impacted" : ""}`} onClick={onClick} aria-label={`查看技术细节 ${entity.title ?? entity.id}`}>
    <span>{kindLabels[kind] ?? "条目"}</span>
    <strong>{entity.title ?? entity.id}</strong>
    <StatusMark status={entity.status} />
    <ChevronRight size={14} />
  </button>;
}

function Overview({ groups, filter, setFilter, openGroup }: { groups: TaskGroup[]; filter: GroupFilter; setFilter(value: GroupFilter): void; openGroup(group: TaskGroup): void }) {
  const visible = groups.filter((group) => {
    const tone = groupTone(group);
    return filter === "all" || tone === filter;
  });
  const regular = visible.filter((group) => !group.isUnassigned);
  const unassigned = visible.find((group) => group.isUnassigned);
  return <section className="relationship-overview" aria-label="项目任务总览">
    <header className="relationship-heading">
      <div><span>第 1 层</span><h2>项目任务总览</h2><p>先按任务看全局；进入一项任务后，只展示与它有关的设计、执行和证据。</p></div>
      <div className="relationship-filters" role="group" aria-label="任务筛选">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
        <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>进行中</button>
        <button className={filter === "risk" ? "active" : ""} onClick={() => setFilter("risk")}>只看风险</button>
      </div>
    </header>
    <div className="relationship-table" role="table" aria-label="按 Change Set 归组的任务">
      <div className="relationship-table-head" role="row"><span>任务组</span><span>设计</span><span>执行</span><span>状态</span><span /></div>
      {regular.map((group) => <button className="relationship-task-row" key={group.id} onClick={() => openGroup(group)} aria-label={`查看任务 ${group.title}`}>
        <span className="task-group-title"><i className={`group-dot is-${groupTone(group)}`} /><span><strong>{group.title}</strong><small>{group.change?.summary ?? group.change?.outcome ?? "查看本任务的设计—执行—证据链"}</small></span></span>
        <span><b>{group.designs.length}</b><small>项设计</small></span>
        <span><b>{group.goals.length}</b><small>个 Goal</small></span>
        <span><StatusMark status={group.status} /></span>
        <ChevronRight size={17} />
      </button>)}
      {!regular.length && <div className="relationship-empty">当前筛选下没有任务。</div>}
    </div>
    {unassigned && <details className="unassigned-group">
      <summary><span><CircleAlert size={15} />待归类与旧草案</span><small>{unassigned.designs.length + unassigned.goals.length} 项尚未由 Change Set 正式归组</small></summary>
      <button onClick={() => openGroup(unassigned)} aria-label={`查看任务 ${unassigned.title}`}>查看这些条目<ChevronRight size={15} /></button>
    </details>}
    <p className="relationship-source-note"><ShieldCheck size={14} />归组来自版本化 Change Set；没有正式映射的内容不会被系统自动连线。</p>
  </section>;
}

function TaskChain({ data, group, kindById, impactedIds, openEntity, back }: { data: ProjectMap; group: TaskGroup; kindById: Map<string, string>; impactedIds: Set<string>; openEntity(entity: Entity): void; back(): void }) {
  const seeds = [...group.designs, ...group.goals, ...group.engineering].map((item) => item.id);
  const connected = connectedEntities(data, seeds);
  const byKind = (kinds: string[]) => unique(connected.filter((item) => kinds.includes(entityKind(item, kindById))));
  const lanes = [
    { id: "reason", number: "01", title: "为什么做", note: "主张与已确认决策", icon: GitBranch, entities: byKind(["claim", "decision"]) },
    { id: "design", number: "02", title: "计划做什么", note: "人能审查的设计规格", icon: Layers3, entities: group.designs },
    { id: "execution", number: "03", title: "Agent 怎样执行", note: "Goal 与工程责任", icon: FileCode2, entities: unique([...group.goals, ...group.engineering]) },
    { id: "proof", number: "04", title: "如何证明", note: "证据、审查与运行结果", icon: CircleCheck, entities: byKind(["evidence", "review", "run"]) }
  ];
  return <section className="relationship-chain" aria-label={`${group.title} 逻辑链`}>
    <nav className="relationship-breadcrumb" aria-label="关系图层级"><button onClick={back}><ArrowLeft size={14} />项目任务总览</button><ChevronRight size={13} /><strong>{group.title}</strong></nav>
    <header className="relationship-heading compact"><div><span>第 2 层 · 单任务</span><h2>{group.title}</h2><p>沿着“原因 → 设计 → 执行 → 证明”检查；每列只显示这项任务的内容。</p></div><StatusMark status={group.status} /></header>
    <div className="logic-lanes">
      {lanes.map((lane, index) => {
        const Icon = lane.icon;
        return <article className={`logic-lane lane-${lane.id}`} key={lane.id}>
          <header><span className="logic-step">{lane.number}</span><Icon size={17} /><div><strong>{lane.title}</strong><small>{lane.note}</small></div><b>{lane.entities.length}</b></header>
          <div className="logic-entity-list">
            {lane.entities.slice(0, 6).map((entity) => <EntityButton key={entity.id} entity={entity} kind={entityKind(entity, kindById)} impacted={impactedIds.has(entity.id)} onClick={() => openEntity(entity)} />)}
            {!lane.entities.length && <div className="logic-empty">尚无正式映射<small>{lane.id === "proof" ? "完成后补充可验收证据" : "需要人工确认后再建立关系"}</small></div>}
            {lane.entities.length > 6 && <small className="logic-more">另有 {lane.entities.length - 6} 项，在技术层查看</small>}
          </div>
          {index < lanes.length - 1 && <div className="logic-arrow" aria-hidden="true"><span /><ChevronRight size={16} /></div>}
        </article>;
      })}
    </div>
    <details className="task-constraints"><summary>适用于本任务的全局约束（{collection(data, "constraints").length}）</summary><ul>{collection(data, "constraints").map((item) => <li key={item.id}>{item.title ?? item.id}</li>)}</ul></details>
  </section>;
}

function TechnicalDetail({ data, entity, group, kindById, impactedIds, back }: { data: ProjectMap; entity: Entity; group: TaskGroup; kindById: Map<string, string>; impactedIds: Set<string>; back(): void }) {
  const directEdges = data.edges.filter((edge) => edge.from === entity.id || edge.to === entity.id);
  const byId = new Map(data.nodes.map((item) => [item.id, item]));
  const bindings = (data.bindings ?? []).filter((binding) => binding.design_id === entity.id || binding.engineering_id === entity.id);
  return <section className="relationship-technical" aria-label={`${entity.title ?? entity.id} 技术细节`}>
    <nav className="relationship-breadcrumb" aria-label="关系图层级"><button onClick={back}><ArrowLeft size={14} />{group.title}</button><ChevronRight size={13} /><strong>技术细节</strong></nav>
    <header className="relationship-heading compact"><div><span>第 3 层 · 按需展开</span><h2>{entity.title ?? entity.id}</h2><p>这里才显示稳定 ID、关系类型、文件和测试，便于深入追查。</p></div><StatusMark status={entity.status} /></header>
    <div className="technical-focus-grid">
      <article className="technical-focus-card"><span>{kindLabels[entityKind(entity, kindById)] ?? "条目"}</span><strong>{entity.title ?? entity.id}</strong><code>{entity.id}</code>{entity.summary && <p>{entity.summary}</p>}{entity.path && <code>{entity.path}</code>}</article>
      <article className="technical-relations"><header><strong>直接关系</strong><small>{directEdges.length} 条正式/候选边</small></header>{directEdges.length ? directEdges.map((edge) => {
        const otherId = edge.from === entity.id ? edge.to : edge.from;
        const other = byId.get(otherId);
        return <div className={`technical-relation ${impactedIds.has(otherId) ? "is-impacted" : ""}`} key={edge.id}><span>{edge.from === entity.id ? "向下" : "上游"}</span><strong>{other?.title ?? otherId}</strong><small>{relationLabels[edge.relation] ?? edge.relation} · {edge.status === "formal" ? "正式" : "待确认"}</small></div>;
      }) : <div className="logic-empty">没有直接关系<small>系统不会自动补造映射</small></div>}</article>
    </div>
    <article className="technical-bindings"><header><strong>实现与验证位置</strong><small>{bindings.length ? `${bindings.length} 个已登记 Mark` : "暂无正式绑定"}</small></header>{bindings.length ? bindings.map((binding) => <div className="technical-binding" key={binding.id}><b>{binding.mark}</b><span><strong>{binding.field_label}</strong><code>{binding.file_path} · {binding.symbol}</code></span><span>{binding.test_paths.map((path) => <code key={path}>{path}</code>)}</span></div>) : <div className="logic-empty">这项内容还没有字段—代码绑定<small>这不等于未实现，只表示尚无可审查的正式 Mark</small></div>}</article>
  </section>;
}

export function SpecMap({ data, selectedId, impactedIds, onSelect }: { data: ProjectMap; selectedId?: string; impactedIds: Set<string>; onSelect(entity: Entity): void }) {
  const [level, setLevel] = useState<MapLevel>("overview");
  const [filter, setFilter] = useState<GroupFilter>("all");
  const [groupId, setGroupId] = useState<string>();
  const [entityId, setEntityId] = useState<string>();
  const groups = useMemo(() => taskGroups(data), [data]);
  const kindById = useMemo(() => {
    const map = new Map<string, string>();
    const definitions: Array<[string, string]> = [["claims", "claim"], ["decisions", "decision"], ["design", "design"], ["constraints", "constraint"], ["engineering", "engineering"], ["goals", "goal"], ["evidence", "evidence"], ["reviews", "review"], ["runs", "run"]];
    definitions.forEach(([key, kind]) => collection(data, key).forEach((item) => map.set(item.id, kind)));
    return map;
  }, [data]);
  const selectedGroup = groups.find((group) => group.id === groupId) ?? groups[0];
  const selectedEntity = data.nodes.find((entity) => entity.id === (entityId ?? selectedId));

  const openGroup = (group: TaskGroup) => { setGroupId(group.id); setEntityId(undefined); setLevel("task"); };
  const openEntity = (entity: Entity) => { setEntityId(entity.id); onSelect(entity); setLevel("technical"); };

  return <div className={`map-shell hierarchical-map level-${level}`} data-testid="spec-map">
    {level === "overview" && <Overview groups={groups} filter={filter} setFilter={setFilter} openGroup={openGroup} />}
    {level === "task" && selectedGroup && <TaskChain data={data} group={selectedGroup} kindById={kindById} impactedIds={impactedIds} openEntity={openEntity} back={() => setLevel("overview")} />}
    {level === "technical" && selectedGroup && selectedEntity && <TechnicalDetail data={data} entity={selectedEntity} group={selectedGroup} kindById={kindById} impactedIds={impactedIds} back={() => setLevel("task")} />}
  </div>;
}
