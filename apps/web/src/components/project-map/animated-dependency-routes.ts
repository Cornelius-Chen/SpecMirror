import { dependencyReadabilityPenalty, dependencySegmentCrossesRect, uniqueRoutingSegments, type DependencyPoint, type DependencyRect, type DependencyRoute, type RouteLink, type RoutingSegment } from "../engineering/dependency-routing.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import type { AnimatedInlineTreeNode } from "./inline-tree-transition.ts";

export interface AnimatedDependencyRoute extends DependencyRoute { opacity: number }
export interface DeferredDependencyRoute extends RouteLink { reason: "missing-endpoint" | "hidden-endpoint" | "no-safe-candidate" }
export interface AnimatedDependencySnapshot { routes: AnimatedDependencyRoute[]; deferred: DeferredDependencyRoute[] }
type Side = "left" | "right" | "top" | "bottom";
type Axis = "x" | "y";
interface Port { side: Side; fraction: number; outward: number }
interface Template { points: DependencyPoint[]; axes: Axis[]; source: Port; target: Port }
interface Track { link: RouteLink; previous?: Template; target?: Template; alternatives: Template[]; opacity: number; order: number; stable: boolean }
export interface AnimatedDependencyPlan { tracks: Track[] }
export interface AnimatedDependencyPlanInput {
  /** Current allowed semantic scope, even if the final router found no path. */
  links: readonly RouteLink[];
  previousRoutes?: readonly (DependencyRoute & { opacity?: number })[];
  previousNodes?: readonly InlineTreeNode[];
  targetRoutes: readonly DependencyRoute[];
  targetNodes: readonly InlineTreeNode[];
  originOffset?: { x: number; y: number };
}
export interface AnimatedDependencySampleInput {
  /** Real drawable cards plus ghost obstacles. Removed document nodes are absent. */
  frameNodes: readonly AnimatedInlineTreeNode[];
  /** The existing node clock, rebased by the owner when a same-epoch plan changes. */
  progress: number;
  bounds?: Pick<DependencyRect, "left" | "right" | "top" | "bottom">;
  boundaries?: readonly DependencyRect[];
  labelObstacles?: readonly DependencyRect[];
  reservedSegments?: readonly RoutingSegment[];
  boundaryClearance?: number;
  edgeSeparation?: number;
  arrowSize?: number | Readonly<Record<string, number>>;
}
const epsilon = .001;
const same = (a: number, b: number) => Math.abs(a - b) < epsilon;
const unit = (n: number) => Math.max(0, Math.min(1, n));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const outward = (side: Side): DependencyPoint => side === "left" ? { x: -1, y: 0 } : side === "right" ? { x: 1, y: 0 } : side === "top" ? { x: 0, y: -1 } : { x: 0, y: 1 };
const nodeRect = (node: InlineTreeNode, pad = 0): DependencyRect => ({ id: node.id, left: node.x - pad, right: node.x + node.width + pad, top: node.y - pad, bottom: node.y + node.height + pad });
const padRect = (rect: DependencyRect, pad: number): DependencyRect => ({ ...rect, left: rect.left - pad, right: rect.right + pad, top: rect.top - pad, bottom: rect.bottom + pad });
const overlaps = (a: DependencyRect, b: DependencyRect) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + epsilon && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + epsilon;
const inBounds = (point: DependencyPoint, bounds: AnimatedDependencySampleInput["bounds"]) => !bounds || point.x >= bounds.left - epsilon && point.x <= bounds.right + epsilon && point.y >= bounds.top - epsilon && point.y <= bounds.bottom + epsilon;

function simplify(points: readonly DependencyPoint[]): DependencyPoint[] {
  const result: DependencyPoint[] = [];
  for (const point of points) {
    if (result.length && same(result.at(-1)!.x, point.x) && same(result.at(-1)!.y, point.y)) continue;
    while (result.length > 1) {
      const a = result.at(-2)!, b = result.at(-1)!;
      // Preserve a reversing bend: removing it could replace a safe corridor
      // with a segment through a card, and reversals are rejected below.
      const between = (value: number, first: number, last: number) => value >= Math.min(first, last) - epsilon && value <= Math.max(first, last) + epsilon;
      if (same(a.x, b.x) && same(b.x, point.x) && between(b.y, a.y, point.y) || same(a.y, b.y) && same(b.y, point.y) && between(b.x, a.x, point.x)) result.pop(); else break;
    }
    result.push({ ...point });
  }
  return result;
}
function portAt(point: DependencyPoint, node: InlineTreeNode): Port {
  const distances: Array<[Side, number]> = [["left", Math.abs(point.x - node.x)], ["right", Math.abs(point.x - node.x - node.width)], ["top", Math.abs(point.y - node.y)], ["bottom", Math.abs(point.y - node.y - node.height)]];
  const side = distances.sort((a, b) => a[1] - b[1])[0]![0];
  const horizontal = side === "left" || side === "right";
  const fraction = unit(horizontal ? (point.y - node.y) / node.height : (point.x - node.x) / node.width);
  const distance = side === "left" ? node.x - point.x : side === "right" ? point.x - node.x - node.width : side === "top" ? node.y - point.y : point.y - node.y - node.height;
  return { side, fraction, outward: Math.max(0, distance) };
}
function portPoint(port: Port, node: InlineTreeNode): DependencyPoint {
  if (port.side === "left" || port.side === "right") return { x: port.side === "left" ? node.x - port.outward : node.x + node.width + port.outward, y: node.y + node.height * port.fraction };
  return { x: node.x + node.width * port.fraction, y: port.side === "top" ? node.y - port.outward : node.y + node.height + port.outward };
}
function template(route: DependencyRoute | undefined, nodes: ReadonlyMap<string, InlineTreeNode>, offset = { x: 0, y: 0 }): Template | undefined {
  if (!route || route.points.length < 2) return;
  const source = nodes.get(route.from), target = nodes.get(route.to);
  if (!source || !target) return;
  const sourcePort = portAt(route.points[0]!, source), targetPort = portAt(route.points.at(-1)!, target);
  let points = simplify(route.points).map(point => ({ x: point.x + offset.x, y: point.y + offset.y }));
  if (points.length < 2) return;
  // A direct rail needs a dormant dogleg so independently moving endpoints can
  // stay attached without turning that segment diagonal. At rest it simplifies
  // back to the exact original line.
  if (points.length === 2) {
    const [a, b] = points;
    if (same(a!.y, b!.y)) points = [a!, { x: (a!.x + b!.x) / 2, y: a!.y }, { x: (a!.x + b!.x) / 2, y: b!.y }, b!];
    else if (same(a!.x, b!.x)) points = [a!, { x: a!.x, y: (a!.y + b!.y) / 2 }, { x: b!.x, y: (a!.y + b!.y) / 2 }, b!];
    else return;
  }
  const axes = points.slice(1).map((point, i): Axis | undefined => same(point.y, points[i]!.y) ? "x" : same(point.x, points[i]!.x) ? "y" : undefined);
  // Infer the zero-length middle leg of a direct route from its neighbours.
  if (points.length === 4 && same(points[1]!.x, points[2]!.x) && same(points[1]!.y, points[2]!.y)) axes[1] = axes[0] === "x" ? "y" : "x";
  if (axes.some(axis => !axis)) return;
  return { points, axes: axes as Axis[], source: sourcePort, target: targetPort };
}
const sameTopology = (a: Template, b: Template) => a.points.length === b.points.length && a.axes.every((axis, i) => axis === b.axes[i]) && a.source.side === b.source.side && a.target.side === b.target.side;
function portAlternatives(base: Template): Template[] {
  // A cached search path may have a safe middle but share its short departure
  // with another layer. Cache two alternate fractions on each existing side;
  // only the endpoint runs move, and sampling still validates the whole path.
  return (["source", "target"] as const).flatMap(end => [.25, .75].filter(fraction => !same(fraction, base[end].fraction))
    .map(fraction => ({ ...base, [end]: { ...base[end], fraction } })));
}

/** Cache candidates once. No graph search is called here or from sampling. */
export function planAnimatedDependencyRoutes({ links, previousRoutes = [], previousNodes = [], targetRoutes, targetNodes, originOffset = { x: 0, y: 0 } }: AnimatedDependencyPlanInput): AnimatedDependencyPlan {
  const previousById = new Map(previousRoutes.map(route => [route.id, route])), targetById = new Map(targetRoutes.map(route => [route.id, route]));
  const beforeNodes = new Map(previousNodes.map(node => [node.id, node])), afterNodes = new Map(targetNodes.map(node => [node.id, node]));
  const matching = (route: DependencyRoute | undefined, link: RouteLink) => route?.from === link.from && route.to === link.to ? route : undefined;
  const tracks = links.map((link, order): Track => {
    const oldRoute = matching(previousById.get(link.id), link), nextRoute = matching(targetById.get(link.id), link);
    const previous = template(oldRoute, beforeNodes, originOffset), target = template(nextRoute, afterNodes);
    const stable = Boolean(previous && target && JSON.stringify(previous) === JSON.stringify(target));
    return { link, previous, target, alternatives: [...(previous ? portAlternatives(previous) : []), ...(target ? portAlternatives(target) : [])], opacity: oldRoute ? unit(previousById.get(link.id)?.opacity ?? 1) : 0, order, stable };
  });
  // Preserve an unrelated established lane before allocating room to a new or
  // moving relationship. Output is restored to the caller's semantic order.
  tracks.sort((a, b) => Number(b.stable) - Number(a.stable) || Number(Boolean(b.previous)) - Number(Boolean(a.previous)) || a.order - b.order);
  return { tracks };
}

function attach(candidate: Template, source: InlineTreeNode, target: InlineTreeNode): DependencyPoint[] {
  const points = candidate.points.map(point => ({ ...point })), start = portPoint(candidate.source, source), finish = portPoint(candidate.target, target);
  points[0] = start; points[points.length - 1] = finish;
  // A horizontal run shares y; a vertical run shares x. Move the first/last
  // run with its actual port, retaining every cached interior corridor.
  for (let i = 0; i < candidate.axes.length; i++) {
    if (candidate.axes[i] !== candidate.axes[0]) break;
    if (candidate.axes[i] === "x") points[i + 1]!.y = start.y; else points[i + 1]!.x = start.x;
  }
  for (let i = candidate.axes.length - 1; i >= 0; i--) {
    if (candidate.axes[i] !== candidate.axes.at(-1)) break;
    if (candidate.axes[i] === "x") points[i]!.y = finish.y; else points[i]!.x = finish.x;
  }
  return simplify(points);
}
function mix(from: Template, to: Template, p: number): Template {
  const port = (a: Port, b: Port): Port => ({ side: a.side, fraction: lerp(a.fraction, b.fraction, p), outward: lerp(a.outward, b.outward, p) });
  return { points: from.points.map((point, i) => ({ x: lerp(point.x, to.points[i]!.x, p), y: lerp(point.y, to.points[i]!.y, p) })), axes: from.axes, source: port(from.source, to.source), target: port(from.target, to.target) };
}
function markerRect(points: readonly DependencyPoint[], size: number): DependencyRect {
  const end = points.at(-1)!, previous = points.at(-2)!, dx = Math.sign(end.x - previous.x), dy = Math.sign(end.y - previous.y);
  const a = { x: end.x - dx * (size - 1), y: end.y - dy * (size - 1) }, b = { x: end.x + dx, y: end.y + dy };
  return { id: "arrow", left: Math.min(a.x, b.x) - Math.abs(dy) * size / 2, right: Math.max(a.x, b.x) + Math.abs(dy) * size / 2,
    top: Math.min(a.y, b.y) - Math.abs(dx) * size / 2, bottom: Math.max(a.y, b.y) + Math.abs(dx) * size / 2 };
}

/** Check only bounded cached candidates against this exact visible frame. */
export function sampleAnimatedDependencyRoutes(plan: AnimatedDependencyPlan, { frameNodes, progress, bounds, boundaries = [], labelObstacles = [], reservedSegments = [], boundaryClearance = 0, edgeSeparation = 0, arrowSize = 7 }: AnimatedDependencySampleInput): AnimatedDependencySnapshot {
  const p = unit(progress), realById = new Map(frameNodes.filter(node => !node.ghost).map(node => [node.id, node]));
  const visible = frameNodes.filter(node => node.opacity > 0), labels = labelObstacles.map(label => padRect(label, 1));
  const occupied = uniqueRoutingSegments(reservedSegments), routes: Array<{ order: number; route: AnimatedDependencyRoute }> = [], deferred: Array<{ order: number; route: DeferredDependencyRoute }> = [];
  for (const track of plan.tracks) {
    const { link } = track, source = realById.get(link.from), target = realById.get(link.to);
    const defer = (reason: DeferredDependencyRoute["reason"]) => deferred.push({ order: track.order, route: { ...link, reason } });
    if (!source || !target) { defer("missing-endpoint"); continue; }
    if (source.opacity <= 0 || target.opacity <= 0) { defer("hidden-endpoint"); continue; }
    const candidates: Template[] = [];
    if (track.previous && track.target && sameTopology(track.previous, track.target)) candidates.push(mix(track.previous, track.target, p));
    if (p >= 1 && track.target) candidates.push(track.target);
    if (track.previous) candidates.push(track.previous);
    if (p < 1 && track.target) candidates.push(track.target);
    candidates.push(...track.alternatives);
    const cardObstacles = visible.map(node => nodeRect(node, !node.ghost && (node.id === link.from || node.id === link.to) ? 0 : 3));
    const size = typeof arrowSize === "number" ? arrowSize : arrowSize[link.id] ?? 7;
    let selected: DependencyPoint[] | undefined;
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const points = attach(candidate, source, target), key = JSON.stringify(points);
      if (points.length < 2 || seen.has(key)) continue;
      seen.add(key);
      if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !inBounds(point, bounds))) continue;
      const sourceDirection = outward(candidate.source.side), targetDirection = outward(candidate.target.side);
      const first = points[0]!, second = points[1]!, end = points.at(-1)!, previous = points.at(-2)!;
      if ((second.x - first.x) * sourceDirection.x + (second.y - first.y) * sourceDirection.y <= epsilon ||
        (previous.x - end.x) * targetDirection.x + (previous.y - end.y) * targetDirection.y <= epsilon) continue;
      const clear = points.slice(1).every((b, i) => {
        const a = points[i]!;
        return (same(a.x, b.x) || same(a.y, b.y)) && ![...cardObstacles, ...labels].some(rect => dependencySegmentCrossesRect(a, b, rect)) &&
          !dependencyReadabilityPenalty(a, b, boundaries, occupied, boundaryClearance, edgeSeparation).hardConflict;
      });
      if (!clear) continue;
      const arrow = markerRect(points, Math.max(1, size));
      if (!inBounds({ x: arrow.left, y: arrow.top }, bounds) || !inBounds({ x: arrow.right, y: arrow.bottom }, bounds) || labels.some(label => overlaps(arrow, label)) ||
        visible.some(node => (node.ghost || node.id !== link.to) && overlaps(arrow, nodeRect(node)))) continue;
      selected = points; break;
    }
    if (!selected) { defer("no-safe-candidate"); continue; }
    const opacity = Math.min(source.opacity, target.opacity, lerp(track.opacity, 1, p));
    const route: AnimatedDependencyRoute = { ...link, points: selected, d: selected.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" "), opacity };
    routes.push({ order: track.order, route });
    if (opacity > 0) occupied.push(...selected.slice(1).map((b, i) => ({ id: link.id, a: selected[i]!, b })));
  }
  return { routes: routes.sort((a, b) => a.order - b.order).map(item => item.route), deferred: deferred.sort((a, b) => a.order - b.order).map(item => item.route) };
}
