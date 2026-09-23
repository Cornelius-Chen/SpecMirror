import { Bot, Settings2, X } from "lucide-react";
import type { EngineeringView } from "@epm/domain";

export interface AgentZoneCardZone {
  id: string;
  title: string;
  node_ids: readonly string[];
  available_leaf_ids: readonly string[];
  runnable_leaf_ids: readonly string[];
  authorized_leaf_ids: readonly string[];
  claimable_leaf_ids: readonly string[];
  owner_state: "unassigned" | "single" | "mixed";
  effective_agent_owner?: string | null;
  agent_owners: readonly string[];
  covenants: { rules: ReadonlyArray<{ text: string }>; resources: readonly string[] };
}

export interface AgentZoneOwnerPresentation {
  ownerKey: string;
  ownerState: "unassigned" | "single" | "mixed";
  shortLabel: string;
  accessibleLabel: string;
  tone: string;
  hue: number | null;
  saturation: number | null;
  lightness: number | null;
}

const singleZoneOwner = (zone: AgentZoneCardZone) => zone.owner_state === "single"
  ? zone.effective_agent_owner ?? (zone.agent_owners.length === 1 ? zone.agent_owners[0]! : null)
  : null;

const ownerHash = (owner: string) => {
  let value = 2166136261;
  for (const character of owner.toLocaleLowerCase()) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value;
};

const shortOwnerName = (owner: string) => {
  const value = owner.replace(/^codex:/i, "").trim() || "Agent";
  const characters = Array.from(value);
  if (characters.length <= 10) return value;
  const code = ownerHash(owner).toString(36).slice(-3).toLocaleUpperCase();
  return `${characters.slice(0, 4).join("")}·${code}`;
};

/** Assign colour from effective Agent identity, never from zone order or the
 * current owner set, so adding another Agent cannot recolour existing work. */
export function agentZoneOwnerPresentations(zones: readonly AgentZoneCardZone[]): Map<string, AgentZoneOwnerPresentation> {
  return new Map<string, AgentZoneOwnerPresentation>(zones.map((zone): [string, AgentZoneOwnerPresentation] => {
    const owner = singleZoneOwner(zone);
    if (owner) {
      const hash = ownerHash(owner);
      return [zone.id, { ownerKey: owner, ownerState: "single", shortLabel: `A·${shortOwnerName(owner)}`, accessibleLabel: `Agent ${shortOwnerName(owner)}`, tone: `agent-${hash.toString(36)}`, hue: hash % 360, saturation: 32 + (hash >>> 9) % 9, lightness: 34 + (hash >>> 18) % 5 }];
    }
    if (zone.owner_state === "mixed") return [zone.id, { ownerKey: "mixed", ownerState: "mixed", shortLabel: "多 A", accessibleLabel: "多个 Agent，边界待拆", tone: "neutral", hue: null, saturation: null, lightness: null }];
    return [zone.id, { ownerKey: "unassigned", ownerState: "unassigned", shortLabel: "A·—", accessibleLabel: "未分配 Agent", tone: "neutral", hue: null, saturation: null, lightness: null }];
  }));
}

export interface AgentZoneCardHandoff {
  from_zone_id: string;
  to_zone_id: string;
  label: string;
  blocking: boolean;
}

export interface AgentZoneCardConflict {
  kind: "hard_dependency" | "shared_resource" | "write_path_overlap";
}

interface Props {
  zone: AgentZoneCardZone;
  view: EngineeringView;
  responsibility: string;
  handoffs: readonly AgentZoneCardHandoff[];
  conflicts: readonly AgentZoneCardConflict[];
  disabled?: boolean;
  onClose: () => void;
  onOpenOwner?: () => void;
}

export function agentZoneStatus(zone: AgentZoneCardZone, view: EngineeringView): string {
  if (zone.owner_state === "unassigned") return "待分配";
  if (zone.owner_state === "mixed") return "边界待拆";
  const statuses = zone.node_ids.map(id => view.derived[id]?.status);
  if (statuses.includes("running")) return "执行中";
  if (statuses.some(status => status === "blocked" || status === "needs_revision")) return "有阻塞";
  if (statuses.includes("review")) return "待验收";
  if (zone.claimable_leaf_ids.length) return `可认领 ${zone.claimable_leaf_ids.length}`;
  return "已分配";
}

const shortList = (items: readonly string[], empty: string) => items.length ? `${items.slice(0, 2).join("；")}${items.length > 2 ? `；另 ${items.length - 2} 项` : ""}` : empty;

export function AgentZoneCard({ zone, view, responsibility, handoffs, conflicts, disabled, onClose, onOpenOwner }: Props) {
  const incoming = handoffs.filter(item => item.to_zone_id === zone.id), outgoing = handoffs.filter(item => item.from_zone_id === zone.id);
  const waits = conflicts.filter(item => item.kind === "hard_dependency").length;
  const collisions = conflicts.length - waits;
  const handoffLabels = [...new Set(handoffs.map(item => item.label).filter(Boolean))];
  const covenant = [...zone.covenants.rules.map(item => item.text), ...zone.covenants.resources.map(item => `共享 ${item}`)];
  const owner = agentZoneOwnerPresentations([zone]).get(zone.id)!;
  return <section className="psm-agent-card" aria-label={`Agent 区域 ${zone.title}`}>
    <header><span><Bot size={14}/>Agent 区域</span><button type="button" aria-label="关闭 Agent 区域" onClick={onClose}><X size={14}/></button></header>
    <h3>{zone.title}</h3>
    <p className="psm-agent-responsibility">{responsibility}</p>
    <p className="psm-agent-owner-line" aria-label={`负责人 ${owner.accessibleLabel}`}><Bot size={12} aria-hidden="true"/><span>负责人</span><strong>{owner.shortLabel}</strong></p>
    <div className="psm-agent-facts" aria-label="区域状态">
      <span><small>节点</small><strong>{zone.node_ids.length}</strong></span>
      <span><small>Agent</small><strong>{agentZoneStatus(zone, view)}</strong></span>
      {zone.owner_state === "unassigned" ? <span><small>任务</small><strong>待分配 {zone.available_leaf_ids.length || ""}</strong></span>
        : zone.owner_state === "mixed" ? <span><small>边界</small><strong>需拆分</strong></span>
        : zone.claimable_leaf_ids.length ? <span className="is-claimable"><small>可认领</small><strong>{zone.claimable_leaf_ids.length}</strong></span>
        : <span><small>可运行</small><strong>{zone.runnable_leaf_ids.filter(id => zone.authorized_leaf_ids.includes(id)).length}</strong></span>}
    </div>
    <section><h4>跨区交接</h4><p>{handoffs.length ? `接收 ${incoming.length} 条 · 交出 ${outgoing.length} 条${waits ? ` · ${waits} 项等待前序成果` : ""}${collisions ? ` · ${collisions} 处范围冲突` : ""}` : "当前没有跨区交接。"}</p>{handoffLabels.length > 0 && <small>{shortList(handoffLabels, "")}</small>}</section>
    <section><h4>区内公约</h4><p>{shortList(covenant, "沿用各工程节点已保存的边界。")}</p></section>
    {onOpenOwner && <footer><button type="button" disabled={disabled} onClick={onOpenOwner}><Settings2 size={13}/>设置区域负责人</button></footer>}
  </section>;
}

export function collaborationParallelStatus(zones: readonly AgentZoneCardZone[], view: EngineeringView, conflicts: readonly AgentZoneCardConflict[]): string {
  const running = zones.filter(zone => zone.node_ids.some(id => view.derived[id]?.status === "running")).length;
  const claimable = zones.filter(zone => zone.owner_state === "single" && zone.claimable_leaf_ids.length).length;
  const runnable = zones.filter(zone => zone.owner_state === "single" && zone.runnable_leaf_ids.some(id => zone.authorized_leaf_ids.includes(id))).length;
  const unassigned = zones.filter(zone => zone.owner_state === "unassigned" && zone.available_leaf_ids.length).length;
  const mixed = zones.filter(zone => zone.owner_state === "mixed").length;
  const waits = conflicts.filter(item => item.kind === "hard_dependency").length;
  const collisions = conflicts.length - waits;
  if (collisions) return `${collisions} 处范围冲突需先拆开`;
  if (mixed) return `${mixed} 区负责人边界待拆`;
  if (running > 1) return `${running} 区并行中`;
  if (running === 1 && runnable > 1) return `1 区运行 · 另 ${runnable - 1} 区条件已满足`;
  if (claimable > 1) return `${claimable} 区等待负责人领取`;
  if (runnable > 1) return `${runnable} 区具备并行条件`;
  if (unassigned) return `${unassigned} 区待分配 Agent${waits ? ` · ${waits} 项交接等待` : ""}`;
  if (waits) return `${waits} 项交接等待前序成果`;
  return zones.length > 1 ? "按交接关系推进" : "单区推进";
}
