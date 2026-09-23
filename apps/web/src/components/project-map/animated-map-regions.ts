import { agentZoneRegions, type AgentZoneLayoutSource, type AgentZoneRegion } from "./agent-zone-layout.ts";
import { boundedBranchGroups, type BoundedTreeGroup, type BoundedTreeLayout } from "./bounded-tree-layout.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import { restingInlineTreeNode, type AnimatedInlineTreeNode } from "./inline-tree-transition.ts";

interface Box { x: number; y: number; width: number; height: number }
/** labelOpacity is relative to the parent group's opacity. */
export interface AnimatedBranchRegion extends BoundedTreeGroup { opacity: number; labelOpacity: number }
export interface AnimatedZoneRegion extends AgentZoneRegion { labelOpacity: number }
export interface AnimatedRegionLabel {
  id: string; kind: "branch" | "zone";
  left: number; right: number; top: number; bottom: number; opacity: number;
}
export interface AnimatedMapRegions {
  nodes: AnimatedInlineTreeNode[];
  groups: AnimatedBranchRegion[];
  zones: AnimatedZoneRegion[];
  labels: AnimatedRegionLabel[];
}
interface RegionTrack<T extends Box> { from: T; to: T; leaving: boolean }
export interface AnimatedRegionsPlan {
  groups: RegionTrack<AnimatedBranchRegion>[];
  zones: RegionTrack<AnimatedZoneRegion>[];
  previousNodes: ReadonlyMap<string, AnimatedInlineTreeNode>;
  targetNodes: ReadonlyMap<string, InlineTreeNode>;
}
export interface AnimatedRegionsInput {
  previous?: AnimatedMapRegions;
  targetNodes: readonly InlineTreeNode[];
  zones: readonly AgentZoneLayoutSource[];
  width: number; height: number;
  originOffset?: { x: number; y: number };
}
export interface AnimatedRegionFrameInput {
  frame: {
    nodes: readonly AnimatedInlineTreeNode[];
    layoutSignature: string; transitionId: number; progress: number;
    originOffset: { x: number; y: number };
  };
  layout: Pick<BoundedTreeLayout, "nodes" | "width" | "height" | "signature">;
  zones: readonly AgentZoneLayoutSource[];
  workspaceKey: string;
}
export interface AnimatedRegionFrameState {
  workspace: string; transitionId: number; signature: string; zonesKey: string;
  /** Shared-clock progress at a same-epoch definition change. */
  progressOrigin: number;
  plan: AnimatedRegionsPlan; snapshot: AnimatedMapRegions;
  /** Immutable sources of the last sample; camera state is deliberately absent. */
  sampled: {
    nodes: readonly AnimatedInlineTreeNode[]; targetNodes: readonly InlineTreeNode[]; zones: readonly AgentZoneLayoutSource[];
    progress: number; width: number; height: number; originX: number; originY: number;
  };
}
const unit = (n: number) => Math.max(0, Math.min(1, n));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const nodeKey = (node: AnimatedInlineTreeNode) => node.ghost ? node.renderKey ?? `${node.id}:motion-ghost` : node.id;
const shift = <T extends Box>(box: T, offset: { x: number; y: number }): T => ({ ...box, x: box.x + offset.x, y: box.y + offset.y });
const sampleBox = (from: Box, to: Box, p: number): Box => ({ x: lerp(from.x, to.x, p), y: lerp(from.y, to.y, p), width: lerp(from.width, to.width, p), height: lerp(from.height, to.height, p) });
const zoneLabel = <T extends AgentZoneRegion>(zone: T): T => ({ ...zone, labelX: zone.x + 8, labelY: zone.y + 3, labelWidth: Math.max(0, Math.min(190, zone.width - 16)) });
const unionIds = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
const sameItems = <T>(left: readonly T[], right: readonly T[]) => left === right || left.length === right.length && left.every((item, index) => item === right[index]);
function sameTargetNodes(left: readonly InlineTreeNode[], right: readonly InlineTreeNode[]) {
  return left === right || left.length === right.length && left.every((node, index) => {
    const other = right[index]!;
    return node === other || node.id === other.id && node.parentId === other.parentId && node.depth === other.depth
      && node.x === other.x && node.y === other.y && node.width === other.width && node.height === other.height;
  });
}

/**
 * Plan only at a new node-motion epoch. Existing layout functions define the
 * target once; sampling never rebuilds descendant sets or starts another clock.
 * The previous displayed snapshot also carries effective opacity for reversals.
 */
export function planAnimatedRegions({ previous, targetNodes, zones, width, height, originOffset = { x: 0, y: 0 } }: AnimatedRegionsInput): AnimatedRegionsPlan {
  const previousNodes = new Map((previous?.nodes ?? []).map(node => [nodeKey(node), shift(node, originOffset)]));
  const targetMap = new Map(targetNodes.map(node => [node.id, node]));
  const targetGroups = boundedBranchGroups(targetNodes, width).map(group => ({ ...group, opacity: 1, labelOpacity: 1 }));
  const targetZones = agentZoneRegions(targetNodes.map(restingInlineTreeNode), zones, width, height).map(zone => ({ ...zone, labelOpacity: 1 }));
  const oldGroups = new Map((previous?.groups ?? []).map(group => [group.id, shift(group, originOffset)]));
  const oldZones = new Map((previous?.zones ?? []).map(zone => [zone.id, zoneLabel(shift(zone, originOffset))]));

  const groups: AnimatedRegionsPlan["groups"] = targetGroups.map(to => {
    const old = oldGroups.get(to.id);
    oldGroups.delete(to.id);
    if (old) return { from: old, to, leaving: false };
    if (!previous) return { from: to, to, leaving: false };
    const parent = previousNodes.get(to.id) ?? targetMap.get(to.id);
    const from = { ...to, y: parent ? parent.y + parent.height + 20 : to.y, height: 0, opacity: 0, labelOpacity: 0 };
    return { from, to, leaving: false };
  });
  for (const from of oldGroups.values()) {
    const parent = targetMap.get(from.id);
    groups.push({ from, to: { ...from, y: parent ? parent.y + parent.height + 20 : from.y, height: 0, opacity: 0, labelOpacity: 0 }, leaving: true });
  }
  const zoneTracks: AnimatedRegionsPlan["zones"] = targetZones.map(to => {
    const old = oldZones.get(to.id);
    oldZones.delete(to.id);
    if (old) return { from: old, to, leaving: false };
    if (!previous) return { from: to, to, leaving: false };
    // Adding a zone around already visible cards must not hide those cards.
    const visible = to.nodeIds.flatMap(id => { const node = previousNodes.get(id); return node && node.opacity > 0 ? [node] : []; });
    const initial = agentZoneRegions(visible, [{ id: to.id, root_node_id: to.rootNodeId, node_ids: to.nodeIds }], width, height)[0];
    const root = previousNodes.get(to.rootNodeId) ?? targetMap.get(to.rootNodeId);
    const from = zoneLabel({ ...to, ...(initial ?? { y: root ? root.y - 28 : to.y, height: 0 }), opacity: 0, labelOpacity: 0 });
    return { from, to, leaving: false };
  });
  for (const from of oldZones.values()) zoneTracks.push({ from, to: { ...from, height: 0, opacity: 0, labelOpacity: 0 }, leaving: true });
  return { groups, zones: zoneTracks, previousNodes, targetNodes: targetMap };
}

const margins = (box: Box, node: Box) => [node.x - box.x, box.x + box.width - node.x - node.width, node.y - box.y, box.y + box.height - node.y - node.height];
function containment(box: Box, node: Box, reference: Box, referenceNode: Box, padding: readonly number[]) {
  const current = margins(box, node), final = margins(reference, referenceNode);
  // A card only gains opacity after it fits inside the moving region. Fade over
  // the existing padding, not a hard membership threshold at the settle frame.
  return Math.min(...current.map((value, i) => {
    const distance = Math.max(0, Math.min(padding[i]!, final[i]!));
    return distance > .001 ? unit(value / distance) : value >= -.001 ? 1 : 0;
  }));
}
function labelClearance(label: AnimatedRegionLabel, cards: readonly AnimatedInlineTreeNode[]) {
  let opacity = label.opacity;
  for (const card of cards) {
    if (card.opacity <= 0) continue;
    const distance = Math.max(card.x - label.right, label.left - card.x - card.width, card.y - label.bottom, label.top - card.y - card.height);
    // Ghosts reserve space without becoming a region member or another title.
    opacity = Math.min(opacity, unit(distance / 3));
  }
  return opacity;
}

/** Sample with the exact eased progress used for cards; coordinates stay intact. */
export function sampleAnimatedRegions(plan: AnimatedRegionsPlan, frameNodes: readonly AnimatedInlineTreeNode[], progress: number): AnimatedMapRegions {
  const p = unit(progress);
  const groupTracks = plan.groups.filter(track => p < 1 || !track.leaving);
  const zoneTracks = plan.zones.filter(track => p < 1 || !track.leaving);
  const groups = groupTracks.map(({ from, to }) => ({ ...to, ...sampleBox(from, to, p), opacity: lerp(from.opacity, to.opacity, p), labelOpacity: 0,
    childIds: p < 1 ? unionIds(from.childIds, to.childIds) : to.childIds,
    descendantIds: p < 1 ? unionIds(from.descendantIds, to.descendantIds) : to.descendantIds }));
  const zones = zoneTracks.map(({ from, to }) => zoneLabel({ ...to, ...sampleBox(from, to, p), opacity: lerp(from.opacity, to.opacity, p), labelOpacity: 0,
    nodeIds: p < 1 ? unionIds(from.nodeIds, to.nodeIds) : to.nodeIds }));
  const membership = new Map<string, Array<{ box: Box; track: RegionTrack<Box>; padding: readonly number[] }>>();
  const add = (id: string, value: { box: Box; track: RegionTrack<Box>; padding: readonly number[] }) => membership.set(id, [...membership.get(id) ?? [], value]);
  for (const [i, group] of groups.entries()) for (const id of group.descendantIds) add(id, { box: group, track: groupTracks[i]!, padding: [10, 10, 36, 12] });
  for (const [i, zone] of zones.entries()) for (const id of zone.nodeIds) add(id, { box: zone, track: zoneTracks[i]!, padding: [8, 8, 28, 10] });
  const nodes = frameNodes.map(node => {
    const old = plan.previousNodes.get(nodeKey(node)) ?? (node.ghost ? plan.previousNodes.get(node.id) : undefined);
    const target = node.ghost ? undefined : plan.targetNodes.get(node.id);
    const startOpacity = old?.opacity ?? (plan.previousNodes.size ? 0 : node.opacity);
    let opacity = Math.min(node.opacity, lerp(startOpacity, target ? 1 : 0, p));
    if (!node.ghost) for (const { box, track, padding } of membership.get(node.id) ?? []) {
      const referenceNode = target ?? old;
      if (referenceNode) opacity = Math.min(opacity, containment(box, node, target && !track.leaving ? track.to : track.from, referenceNode, padding));
    }
    return opacity === node.opacity ? node : { ...node, opacity };
  });
  const labels: AnimatedRegionLabel[] = [];
  for (const group of groups) {
    const label: AnimatedRegionLabel = { id: group.id, kind: "branch", left: group.x + 20, right: Math.max(group.x + 20, group.x + group.width - 20), top: group.y - 11, bottom: group.y + 11, opacity: group.opacity };
    label.opacity = labelClearance(label, nodes); group.labelOpacity = group.opacity > 0 ? label.opacity / group.opacity : 0; labels.push(label);
  }
  for (const zone of zones) {
    const label: AnimatedRegionLabel = { id: zone.id, kind: "zone", left: zone.labelX, right: zone.labelX + zone.labelWidth, top: zone.labelY, bottom: zone.labelY + 22, opacity: zone.opacity };
    label.opacity = labelClearance(label, nodes); zone.labelOpacity = label.opacity; labels.push(label);
  }
  return { nodes, groups, zones, labels };
}

/**
 * Select and sample the displayed plan without React or another animation loop.
 * Only visible geometry invalidates it: hidden descendants can change while a
 * branch is moving without replaying progress from an already advanced snapshot.
 */
export function advanceAnimatedRegions({ frame, layout, zones, workspaceKey }: AnimatedRegionFrameInput, before?: AnimatedRegionFrameState): AnimatedRegionFrameState {
  const sameWorkspace = before?.workspace === workspaceKey;
  // The node layout effect publishes its matching frame before paint. Preserve
  // the last displayed state while that first frame has not caught up yet.
  if (sameWorkspace && frame.layoutSignature !== layout.signature) return before;
  const sameEpoch = sameWorkspace && before.transitionId === frame.transitionId;
  const sampled = before?.sampled;
  const sameClock = sameEpoch && sampled?.progress === frame.progress
    && sampled.originX === frame.originOffset.x && sampled.originY === frame.originOffset.y;
  const sameLayout = sameEpoch && before.signature === layout.signature && sampled?.width === layout.width && sampled.height === layout.height;
  // The usual pan/zoom render only wraps the same sources in a new input object.
  // Return before computing even the visible-zone key, not merely before routing.
  if (sameClock && sameLayout && sampled.nodes === frame.nodes && sampled.targetNodes === layout.nodes && sampled.zones === zones) return before;
  const sameTargets = sameLayout && sameTargetNodes(sampled.targetNodes, layout.nodes);
  const zonesKey = sameTargets && sampled.zones === zones ? before.zonesKey : (() => {
    const visibleIds = new Set(layout.nodes.map(node => node.id));
    return JSON.stringify(zones.flatMap(zone => {
      if (!visibleIds.has(zone.root_node_id)) return [];
      const members = zone.node_ids.filter(id => visibleIds.has(id));
      return members.length ? [[zone.id, zone.root_node_id, members]] : [];
    }));
  })();
  const nextSampled = { nodes: frame.nodes, targetNodes: layout.nodes, zones, progress: frame.progress,
    width: layout.width, height: layout.height, originX: frame.originOffset.x, originY: frame.originOffset.y };
  const samePlan = sameTargets && before.zonesKey === zonesKey;
  // A filtered array or a hidden-membership/title refresh can be equivalent.
  // Keep its new source references so subsequent camera renders stay O(1).
  if (sameClock && samePlan && sameItems(sampled.nodes, frame.nodes)) return { ...before, sampled: nextSampled };
  const progressOrigin = samePlan ? before.progressOrigin : sameEpoch && frame.progress < 1 ? unit(frame.progress) : 0;
  const plan = samePlan ? before.plan : planAnimatedRegions({
    previous: sameWorkspace ? before.snapshot : undefined,
    targetNodes: layout.nodes, zones, width: layout.width, height: layout.height,
    originOffset: sameWorkspace && !sameEpoch ? frame.originOffset : undefined
  });
  // Replanning at p=.4 starts from the actual .4 snapshot, not another .4 of
  // its remaining travel. Completion/reduced-motion still settles exactly once.
  const progress = frame.progress >= 1 ? 1 : unit((frame.progress - progressOrigin) / (1 - progressOrigin));
  return { workspace: workspaceKey, transitionId: frame.transitionId, signature: layout.signature, zonesKey, progressOrigin, plan,
    snapshot: sampleAnimatedRegions(plan, frame.nodes, progress), sampled: nextSampled };
}
