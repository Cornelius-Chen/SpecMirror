import { useLayoutEffect, useRef } from "react";
import { planAnimatedDependencyRoutes, sampleAnimatedDependencyRoutes, type AnimatedDependencyPlan, type AnimatedDependencyPlanInput, type AnimatedDependencySampleInput, type AnimatedDependencySnapshot } from "./animated-dependency-routes.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";

export interface AnimatedDependencyFrameInput {
  workspaceKey: string;
  layoutSignature: string;
  frame: { layoutSignature: string; transitionId: number; progress: number; originOffset: { x: number; y: number } };
  targetNodes: AnimatedDependencyPlanInput["targetNodes"];
  links: AnimatedDependencyPlanInput["links"];
  /** Previously admitted, still valid relationships allowed to fade with their
   * real exiting endpoints. The caller revokes these on deletion, retargeting,
   * scope/page changes or hiding the layer. This never admits a new route. */
  retainedLinks?: AnimatedDependencyPlanInput["links"];
  targetRoutes: AnimatedDependencyPlanInput["targetRoutes"];
  sample: Omit<AnimatedDependencySampleInput, "progress">;
}
type Definitions = Pick<AnimatedDependencyFrameInput, "targetNodes" | "links" | "retainedLinks" | "targetRoutes">;
export interface AnimatedDependencyFrameState {
  workspaceKey: string; layoutSignature: string; transitionId: number; progressOrigin: number;
  plan?: AnimatedDependencyPlan; definitionKey?: string; definitions?: Definitions;
  snapshot: AnimatedDependencySnapshot;
  /** The nodes at which the retained route geometry was actually displayed. */
  displayedNodes: readonly InlineTreeNode[];
  waitingForFrame: boolean;
  source: AnimatedDependencyFrameInput;
}

const unit = (value: number) => Math.max(0, Math.min(1, value));
const sameItems = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) => a === b || (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((item, index) => item === b![index]);
const sameDefinitions = (a: Definitions, b?: Definitions) => a.links === b?.links && a.retainedLinks === b?.retainedLinks && a.targetRoutes === b?.targetRoutes && a.targetNodes === b?.targetNodes;
const sameClock = (a: AnimatedDependencyFrameInput, b: AnimatedDependencyFrameInput) => a.workspaceKey === b.workspaceKey && a.layoutSignature === b.layoutSignature
  && a.frame.layoutSignature === b.frame.layoutSignature && a.frame.transitionId === b.frame.transitionId && a.frame.progress === b.frame.progress
  && a.frame.originOffset.x === b.frame.originOffset.x && a.frame.originOffset.y === b.frame.originOffset.y;
function sameSample(a: AnimatedDependencyFrameInput["sample"], b: AnimatedDependencyFrameInput["sample"]) {
  return sameItems(a.frameNodes, b.frameNodes) && sameItems(a.boundaries, b.boundaries) && sameItems(a.labelObstacles, b.labelObstacles)
    && sameItems(a.reservedSegments, b.reservedSegments) && a.boundaryClearance === b.boundaryClearance && a.edgeSeparation === b.edgeSeparation
    && a.arrowSize === b.arrowSize && (a.bounds === b.bounds || a.bounds?.left === b.bounds?.left && a.bounds?.right === b.bounds?.right && a.bounds?.top === b.bounds?.top && a.bounds?.bottom === b.bounds?.bottom);
}
function definitionKey({ links, retainedLinks, targetNodes, targetRoutes }: Definitions) {
  return JSON.stringify([
    links.map(link => [link.id, link.from, link.to, link.inherited]),
    retainedLinks?.map(link => [link.id, link.from, link.to, link.inherited]) ?? [],
    targetNodes.map(node => [node.id, node.x, node.y, node.width, node.height]),
    targetRoutes.map(route => [route.id, route.from, route.to, route.points.map(point => [point.x, point.y])])
  ]);
}
const remember = (input: AnimatedDependencyFrameInput): AnimatedDependencyFrameInput => ({ ...input,
  frame: { ...input.frame, originOffset: { ...input.frame.originOffset } }, sample: { ...input.sample } });

/** Preserve geometry while the node clock catches up, never a removed or retargeted relationship. */
function retainAllowedSnapshot(input: AnimatedDependencyFrameInput, snapshot: AnimatedDependencySnapshot): AnimatedDependencySnapshot {
  const targetIds = new Set(input.targetNodes.map(node => node.id));
  const visibleIds = new Set(input.sample.frameNodes.filter(node => !node.ghost && node.opacity > 0).map(node => node.id));
  const links = new Map(input.links.map(link => [link.id, link]));
  const retained = new Map(input.retainedLinks?.map(link => [link.id, link]));
  const retain = <T extends AnimatedDependencyFrameInput["links"][number]>(items: T[]): T[] => items.flatMap(item => {
    const current = links.get(item.id) ?? retained.get(item.id);
    if (!current || current.from !== item.from || current.to !== item.to || !visibleIds.has(item.from) || !visibleIds.has(item.to)) return [];
    const exit = retained.get(item.id);
    if ((!targetIds.has(item.from) || !targetIds.has(item.to)) && (exit?.from !== item.from || exit.to !== item.to)) return [];
    return [current.inherited === item.inherited ? item : { ...item, inherited: current.inherited }];
  });
  const routes = retain(snapshot.routes), deferred = retain(snapshot.deferred);
  return sameItems(routes, snapshot.routes) && sameItems(deferred, snapshot.deferred) ? snapshot : { routes, deferred };
}

/** Retention can continue only a track that actually existed in this workspace.
 * Target links win on ID collisions, so a retarget can never resurrect an old
 * pair. An unsafe frame may have no displayed route; keep its cached plan until
 * a later frame has a safe corridor again, without searching a new graph. */
function planLinks(input: AnimatedDependencyFrameInput, before?: AnimatedDependencyFrameState): AnimatedDependencyFrameInput["links"] {
  if (!before || before.workspaceKey !== input.workspaceKey || !input.retainedLinks?.length) return input.links;
  const currentIds = new Set(input.links.map(link => link.id));
  const previous = new Map([...before.snapshot.routes, ...(before.plan?.tracks.map(track => track.link) ?? [])].map(link => [link.id, link]));
  const exits = input.retainedLinks.filter(link => !currentIds.has(link.id) && previous.get(link.id)?.from === link.from && previous.get(link.id)?.to === link.to);
  return exits.length ? [...input.links, ...exits] : input.links;
}

function finishExits(input: AnimatedDependencyFrameInput, snapshot: AnimatedDependencySnapshot): AnimatedDependencySnapshot {
  // A hidden target relation is genuinely deferred. A completed exit has no
  // target relation to draw, and must not remain in that public deferred count.
  const currentIds = new Set(input.links.map(link => link.id));
  const deferred = snapshot.deferred.filter(link => currentIds.has(link.id) || link.reason === "no-safe-candidate");
  return deferred.length === snapshot.deferred.length ? snapshot : { ...snapshot, deferred };
}

/** One pure advance per displayed node frame. Camera-only renders keep the exact snapshot reference. */
export function advanceAnimatedDependencyRouteFrame(input: AnimatedDependencyFrameInput, before?: AnimatedDependencyFrameState): AnimatedDependencyFrameState {
  if (before && sameClock(input, before.source) && sameDefinitions(input, before.source) && sameSample(input.sample, before.source.sample)) return before;
  const sameWorkspace = before?.workspaceKey === input.workspaceKey;
  if (input.frame.layoutSignature !== input.layoutSignature) {
    const snapshot = sameWorkspace ? retainAllowedSnapshot(input, before.snapshot) : { routes: [], deferred: [] };
    return { ...(sameWorkspace ? before : { workspaceKey: input.workspaceKey, layoutSignature: "", transitionId: -1, progressOrigin: 0, displayedNodes: [] }),
      snapshot, waitingForFrame: true, source: remember(input) };
  }
  const sameEpoch = sameWorkspace && before.transitionId === input.frame.transitionId;
  const key = before && sameDefinitions(input, before.definitions) ? before.definitionKey! : definitionKey(input);
  const samePlan = sameEpoch && !before.waitingForFrame && before.layoutSignature === input.layoutSignature && before.definitionKey === key && before.plan;
  if (samePlan && sameClock(input, before.source) && sameSample(input.sample, before.source.sample)) return { ...before,
    source: remember(input), definitions: { links: input.links, retainedLinks: input.retainedLinks, targetNodes: input.targetNodes, targetRoutes: input.targetRoutes } };
  const progressOrigin = samePlan ? before.progressOrigin : sameEpoch && input.frame.progress < 1 ? unit(input.frame.progress) : 0;
  const plan = samePlan || planAnimatedDependencyRoutes({ links: planLinks(input, before), targetRoutes: input.targetRoutes, targetNodes: input.targetNodes,
    previousRoutes: sameWorkspace ? before.snapshot.routes : undefined, previousNodes: sameWorkspace ? before.displayedNodes : undefined,
    originOffset: sameWorkspace && !sameEpoch ? input.frame.originOffset : undefined });
  const progress = input.frame.progress >= 1 ? 1 : unit((input.frame.progress - progressOrigin) / (1 - progressOrigin));
  return { workspaceKey: input.workspaceKey, layoutSignature: input.layoutSignature, transitionId: input.frame.transitionId, progressOrigin, plan,
    definitionKey: key, definitions: { links: input.links, retainedLinks: input.retainedLinks, targetNodes: input.targetNodes, targetRoutes: input.targetRoutes },
    snapshot: finishExits(input, sampleAnimatedDependencyRoutes(plan, { ...input.sample, progress })),
    displayedNodes: input.sample.frameNodes.filter(node => !node.ghost), waitingForFrame: false, source: remember(input) };
}

/** Commit only the displayed snapshot and consume the existing node clock; no additional RAF. */
export function useAnimatedDependencyRoutes(input: AnimatedDependencyFrameInput): AnimatedDependencySnapshot {
  const committed = useRef<AnimatedDependencyFrameState | undefined>(undefined);
  const next = advanceAnimatedDependencyRouteFrame(input, committed.current);
  useLayoutEffect(() => { committed.current = next; }, [next]);
  return next.snapshot;
}
