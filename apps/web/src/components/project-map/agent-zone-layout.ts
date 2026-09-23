import type { InlineTreeNode } from "./inline-tree-layout.ts";

export interface AgentZoneLayoutSource {
  id: string;
  root_node_id: string;
  node_ids: readonly string[];
}

export interface AgentZoneLayoutNode extends InlineTreeNode { opacity: number }

export interface AgentZoneRegion {
  id: string;
  rootNodeId: string;
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  labelX: number;
  labelY: number;
  labelWidth: number;
  opacity: number;
}

/**
 * Collaboration zones are a presentation layer over the existing engineering
 * tree. Their bounds follow only currently visible cards and never reposition
 * the underlying nodes.
 */
export function agentZoneRegions(nodes: readonly AgentZoneLayoutNode[], zones: readonly AgentZoneLayoutSource[], canvasWidth: number, canvasHeight: number): AgentZoneRegion[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return zones.flatMap(zone => {
    const memberIds = new Set(zone.node_ids), members = nodes.filter(node => memberIds.has(node.id));
    const root = byId.get(zone.root_node_id);
    if (!root || !members.length) return [];
    const left = Math.max(4, Math.min(...members.map(node => node.x)) - 8);
    const right = Math.max(left, Math.min(canvasWidth - 4, Math.max(...members.map(node => node.x + node.width)) + 8));
    const top = Math.max(4, Math.min(...members.map(node => node.y)) - 28);
    const bottom = Math.max(top, Math.min(canvasHeight - 4, Math.max(...members.map(node => node.y + node.height)) + 10));
    return [{
      id: zone.id,
      rootNodeId: zone.root_node_id,
      nodeIds: members.map(node => node.id),
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      labelX: left + 8,
      labelY: top + 3,
      labelWidth: Math.max(0, Math.min(190, right - left - 16)),
      opacity: Math.max(...members.map(node => node.opacity))
    }];
  });
}
