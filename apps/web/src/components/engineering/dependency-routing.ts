import { searchOrthogonalRoute, type OrthogonalRoutePort } from "./orthogonal-route-search.ts";
import { createDependencyReadabilityQuery } from "./dependency-readability-query.ts";

/** Routes read-only dependency arrows around measured task cards. */
export interface DependencyRect { id: string; left: number; right: number; top: number; bottom: number }
export interface DependencyPoint { x: number; y: number }
export interface RouteLink { id: string; from: string; to: string; inherited: boolean }
export interface DependencyRoute extends RouteLink { points: DependencyPoint[]; d: string }
export interface RoutingSegment { id?: string; a: DependencyPoint; b: DependencyPoint }
export interface DependencyRoutingOptions {
  /** Actual caption/title rectangles. Unlike container outlines, these are solid. */
  labelObstacles?: readonly DependencyRect[];
  /** Visible container outlines. Routes may cross them, but may not run beside them. */
  boundaries?: readonly DependencyRect[];
  /** Centre-line distance kept from a parallel container outline. */
  boundaryClearance?: number;
  /** Centre-line distance kept between unrelated route lanes. */
  edgeSeparation?: number;
  /** Lines from another visual layer which already occupy a lane. */
  reservedSegments?: readonly RoutingSegment[];
  /** Optional canvas bounds. Candidate lanes outside this rectangle are rejected. */
  bounds?: Pick<DependencyRect, "left" | "right" | "top" | "bottom">;
  /** Reject boundary-hugging and parallel-overlapping segments instead of merely penalising them. */
  strictReadability?: boolean;
}
type Side = "left" | "right" | "top" | "bottom";
const epsilon = 0.001;
const same = (a: number, b: number) => Math.abs(a - b) < epsilon;

/** Keep one reservation for each undirected screen-space segment. Callers can
 * combine independent line layers without multiplying a shared lane's cost. */
export function uniqueRoutingSegments(source: readonly RoutingSegment[]): RoutingSegment[] {
  const coordinate = (value: number) => Math.round(value / epsilon);
  const point = (value: DependencyPoint) => `${coordinate(value.x)},${coordinate(value.y)}`;
  const unique = new Map<string, RoutingSegment>();
  for (const segment of source) {
    const a = point(segment.a), b = point(segment.b);
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!unique.has(key)) unique.set(key, segment);
  }
  return [...unique.values()];
}

/** Touching an obstacle's padded boundary is allowed; crossing its interior is not. */
export function dependencySegmentCrossesRect(a: DependencyPoint, b: DependencyPoint, rect: DependencyRect): boolean {
  if (same(a.y, b.y)) return a.y > rect.top + epsilon && a.y < rect.bottom - epsilon && Math.max(a.x, b.x) > rect.left + epsilon && Math.min(a.x, b.x) < rect.right - epsilon;
  if (same(a.x, b.x)) return a.x > rect.left + epsilon && a.x < rect.right - epsilon && Math.max(a.y, b.y) > rect.top + epsilon && Math.min(a.y, b.y) < rect.bottom - epsilon;
  return true;
}

const projectionOverlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)));
const segments = (points: readonly DependencyPoint[], id?: string): RoutingSegment[] => points.slice(1).map((b, index) => ({ id, a: points[index]!, b }));

/** A soft routing cost keeps orthogonal lines out of visually ambiguous lanes.
 * Crossings remain possible when they are the only safe route; long parallel
 * runs beside a boundary or an occupied lane are made prohibitively expensive. */
function readabilityPenalty(a: DependencyPoint, b: DependencyPoint, boundaries: readonly DependencyRect[], occupied: readonly RoutingSegment[], boundaryClearance: number, edgeSeparation: number): { cost: number; hardConflict: boolean } {
  const horizontal = same(a.y, b.y), vertical = same(a.x, b.x);
  if (!horizontal && !vertical) return { cost: 1_000_000, hardConflict: true };
  let cost = 0, hardConflict = false;
  for (const boundary of boundaries) {
    if (horizontal) {
      const overlap = projectionOverlap(a.x, b.x, boundary.left, boundary.right);
      const distance = Math.min(Math.abs(a.y - boundary.top), Math.abs(a.y - boundary.bottom));
      if (overlap > 1 && distance < boundaryClearance - epsilon) { cost += 100_000 + overlap * 100; hardConflict = true; }
    } else {
      const overlap = projectionOverlap(a.y, b.y, boundary.top, boundary.bottom);
      const distance = Math.min(Math.abs(a.x - boundary.left), Math.abs(a.x - boundary.right));
      if (overlap > 1 && distance < boundaryClearance - epsilon) { cost += 100_000 + overlap * 100; hardConflict = true; }
    }
  }
  const chargedCrossings = new Set<string>();
  for (const [index, segment] of occupied.entries()) {
    const otherHorizontal = same(segment.a.y, segment.b.y), otherVertical = same(segment.a.x, segment.b.x);
    if (horizontal && otherHorizontal) {
      const overlap = projectionOverlap(a.x, b.x, segment.a.x, segment.b.x), distance = Math.abs(a.y - segment.a.y);
      if (overlap > 1 && distance < edgeSeparation - epsilon) { cost += 80_000 + overlap * 80; hardConflict = true; }
    } else if (vertical && otherVertical) {
      const overlap = projectionOverlap(a.y, b.y, segment.a.y, segment.b.y), distance = Math.abs(a.x - segment.a.x);
      if (overlap > 1 && distance < edgeSeparation - epsilon) { cost += 80_000 + overlap * 80; hardConflict = true; }
    } else if ((horizontal && otherVertical && Math.min(a.x, b.x) < segment.a.x && segment.a.x < Math.max(a.x, b.x) && Math.min(segment.a.y, segment.b.y) < a.y && a.y < Math.max(segment.a.y, segment.b.y)) ||
      (vertical && otherHorizontal && Math.min(a.y, b.y) < segment.a.y && segment.a.y < Math.max(a.y, b.y) && Math.min(segment.a.x, segment.b.x) < a.x && a.x < Math.max(segment.a.x, segment.b.x))) {
      const crossing = segment.id ?? `${index}:${segment.a.x},${segment.a.y}:${segment.b.x},${segment.b.y}`;
      if (!chargedCrossings.has(crossing)) { chargedCrossings.add(crossing); cost += 20_000; }
    }
  }
  return { cost, hardConflict };
}

/** Shared by cached frame candidates; exporting this does not run the search grid. */
export { readabilityPenalty as dependencyReadabilityPenalty };

export function routeDependencyLinks(rectangles: DependencyRect[], links: RouteLink[], options: DependencyRoutingOptions = {}): DependencyRoute[] {
  const byId = new Map(rectangles.map(rect => [rect.id, rect]));
  const ends = links.flatMap(link => {
    const source = byId.get(link.from), target = byId.get(link.to); if (!source || !target || source.id === target.id) return [];
    if (Math.min(source.right, target.right) - Math.max(source.left, target.left) > epsilon && Math.min(source.bottom, target.bottom) - Math.max(source.top, target.top) > epsilon) return [];
    const sameColumn = Math.min(source.right, target.right) - Math.max(source.left, target.left) > 0;
    const forward = sameColumn ? target.top > source.top : target.left > source.left;
    const sourceSide: Side = sameColumn ? forward ? "bottom" : "top" : forward ? "right" : "left";
    const targetSide: Side = sameColumn ? forward ? "top" : "bottom" : forward ? "left" : "right";
    const sourceCenter = { x: (source.left + source.right) / 2, y: (source.top + source.bottom) / 2 };
    const targetCenter = { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 };
    const vertical: readonly [Side, Side] = targetCenter.y > sourceCenter.y ? ["bottom", "top"] : targetCenter.y < sourceCenter.y ? ["top", "bottom"] : ["bottom", "bottom"];
    const horizontal: readonly [Side, Side] = targetCenter.x > sourceCenter.x ? ["right", "left"] : targetCenter.x < sourceCenter.x ? ["left", "right"] : ["right", "right"];
    const allSides: readonly Side[] = ["top", "right", "bottom", "left"];
    const sidePairs = ([[sourceSide, targetSide], vertical, horizontal, ["top", "top"], ["bottom", "bottom"], ["left", "left"], ["right", "right"],
      ...allSides.flatMap(left => allSides.map(right => [left, right] as const))] as const)
      .filter((pair, index, pairs) => pairs.findIndex(other => other[0] === pair[0] && other[1] === pair[1]) === index);
    return [{ link, source, target, sourceSide, targetSide, sidePairs }];
  });
  const preferredGroups = new Map<string, string[]>(), fallbackGroups = new Map<string, string[]>();
  const addGroup = (groups: Map<string, string[]>, rect: DependencyRect, side: Side, token: string) => {
    const key = rect.id + "/" + side, group = groups.get(key) ?? [];
    if (!group.includes(token)) groups.set(key, [...group, token]);
  };
  for (const edge of ends) {
    addGroup(preferredGroups, edge.source, edge.sourceSide, edge.link.id + "/source");
    addGroup(preferredGroups, edge.target, edge.targetSide, edge.link.id + "/target");
    for (const [sourceSide, targetSide] of edge.sidePairs) {
      addGroup(fallbackGroups, edge.source, sourceSide, edge.link.id + "/source");
      addGroup(fallbackGroups, edge.target, targetSide, edge.link.id + "/target");
    }
  }
  const port = (groups: Map<string, string[]>, rect: DependencyRect, side: Side, token: string, outward: number, alternateFraction?: number): DependencyPoint => {
    const group = groups.get(rect.id + "/" + side)!, fraction = alternateFraction ?? (group.indexOf(token) + 1) / (group.length + 1);
    if (side === "left" || side === "right") return { x: side === "left" ? rect.left - outward : rect.right + outward, y: rect.top + 12 + (rect.bottom - rect.top - 24) * fraction };
    return { x: rect.left + 12 + (rect.right - rect.left - 24) * fraction, y: side === "top" ? rect.top - outward : rect.bottom + outward };
  };
  // Labels already have measured dimensions. A one-pixel text guard leaves the
  // narrow space above a card usable; applying card clearance here would seal it.
  // Keep labels out of byId and port groups even when their IDs match a card.
  const labels = (options.labelObstacles ?? []).map(rect => ({ ...rect, left: rect.left - 1, right: rect.right + 1, top: rect.top - 1, bottom: rect.bottom + 1 }));
  const occupied: RoutingSegment[] = uniqueRoutingSegments(options.reservedSegments ?? []), routes: DependencyRoute[] = [];
  for (const [ordinal, edge] of ends.entries()) {
    const clearance = 6 + ordinal % 3;
    const obstacles = [...rectangles.map(rect => ({ ...rect, left: rect.left - clearance, right: rect.right + clearance, top: rect.top - clearance, bottom: rect.bottom + clearance })), ...labels];
    const boundaryClearance = options.boundaryClearance ?? 0, edgeSeparation = options.edgeSeparation ?? 0;
    const readability = createDependencyReadabilityQuery(options.boundaries ?? [], occupied, boundaryClearance, edgeSeparation);
    const inBounds = (p: DependencyPoint) => !options.bounds || p.x >= options.bounds.left - epsilon && p.x <= options.bounds.right + epsilon && p.y >= options.bounds.top - epsilon && p.y <= options.bounds.bottom + epsilon;
    const overlaps = (a: DependencyRect, b: DependencyRect) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + epsilon && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + epsilon;
    const connectorClear = (a: DependencyPoint, b: DependencyPoint, ownerId: string) => inBounds(a) && inBounds(b) &&
      ![...rectangles.filter(rect => rect.id !== ownerId), ...labels].some(rect => dependencySegmentCrossesRect(a, b, rect)) &&
      (!options.strictReadability || !readability(a, b).hardConflict);
    const ports = (rect: DependencyRect, token: string, preferredSide: Side, isTarget: boolean): OrthogonalRoutePort[] => {
      const result: OrthogonalRoutePort[] = [];
      for (const side of [preferredSide, ...(["top", "right", "bottom", "left"] as Side[]).filter(side => side !== preferredSide)]) {
        const verticalSide = side === "left" || side === "right", low = (verticalSide ? rect.top : rect.left) + 12, high = (verticalSide ? rect.bottom : rect.right) - 12;
        if (high <= low) continue;
        const groups = side === preferredSide ? preferredGroups : fallbackGroups;
        const assigned = port(groups, rect, side, token, isTarget ? 3 : 0), assignedCoordinate = verticalSide ? assigned.y : assigned.x;
        const normal = port(groups, rect, side, token, clearance), coordinates = [assignedCoordinate, low + (high - low) * .25, low + (high - low) * .75];
        const fallback = port(fallbackGroups, rect, side, token, 0); coordinates.push(verticalSide ? fallback.y : fallback.x);
        // Share actual openings rather than multiplying fixed side/fraction
        // searches. Label guards include the widest existing arrow half-width.
        for (const label of labels) if (verticalSide
          ? Math.max(assigned.x, normal.x) > label.left && Math.min(assigned.x, normal.x) < label.right
          : Math.max(assigned.y, normal.y) > label.top && Math.min(assigned.y, normal.y) < label.bottom) coordinates.push(...(verticalSide ? [label.top - 4, label.bottom + 4] : [label.left - 4, label.right + 4]));
        for (const segment of occupied) if (verticalSide
          ? same(segment.a.y, segment.b.y) && projectionOverlap(assigned.x, normal.x, segment.a.x, segment.b.x) > 1
          : same(segment.a.x, segment.b.x) && projectionOverlap(assigned.y, normal.y, segment.a.y, segment.b.y) > 1) {
          const coordinate = verticalSide ? segment.a.y : segment.a.x; if (edgeSeparation > 0) coordinates.push(coordinate - edgeSeparation, coordinate + edgeSeparation);
        }
        const candidates = [...new Set(coordinates.map(coordinate => Math.max(low, Math.min(high, coordinate))))].map(coordinate => {
          const fraction = (coordinate - low) / (high - low), terminal = port(groups, rect, side, token, isTarget ? 3 : 0, fraction), point = port(groups, rect, side, token, clearance, fraction);
          return { terminal, point, cost: Math.abs(coordinate - assignedCoordinate) * 1.001 + (side === preferredSide ? 0 : 4) };
        }).filter(candidate => {
          if (!connectorClear(candidate.terminal, candidate.point, rect.id)) return false;
          if (!isTarget) return true;
          const dx = Math.sign(candidate.terminal.x - candidate.point.x), dy = Math.sign(candidate.terminal.y - candidate.point.y), end = candidate.terminal;
          const back = { x: end.x - dx * 7, y: end.y - dy * 7 }, tip = { x: end.x + dx, y: end.y + dy };
          const arrow = { id: "arrow", left: Math.min(back.x, tip.x) - Math.abs(dy) * 4, right: Math.max(back.x, tip.x) + Math.abs(dy) * 4, top: Math.min(back.y, tip.y) - Math.abs(dx) * 4, bottom: Math.max(back.y, tip.y) + Math.abs(dx) * 4 };
          return inBounds({ x: arrow.left, y: arrow.top }) && inBounds({ x: arrow.right, y: arrow.bottom }) && ![...labels, ...rectangles.filter(card => card.id !== rect.id)].some(obstacle => overlaps(arrow, obstacle));
        }).sort((a, b) => a.cost - b.cost).slice(0, 4);
        result.push(...candidates);
      }
      return result;
    };
    const sources = ports(edge.source, edge.link.id + "/source", edge.sourceSide, false), targets = ports(edge.target, edge.link.id + "/target", edge.targetSide, true);
    if (!sources.length || !targets.length) continue;
    const rings = Math.min(8, Math.max(1, obstacles.length));
    const boundaryXs = (options.boundaries ?? []).flatMap(rect => Array.from({ length: rings }, (_, index) => [rect.left - boundaryClearance - index * edgeSeparation, rect.right + boundaryClearance + index * edgeSeparation]).flat());
    const boundaryYs = (options.boundaries ?? []).flatMap(rect => Array.from({ length: rings }, (_, index) => [rect.top - boundaryClearance - index * edgeSeparation, rect.bottom + boundaryClearance + index * edgeSeparation]).flat());
    const occupiedXs = edgeSeparation > 0 ? occupied.flatMap(segment => same(segment.a.x, segment.b.x) ? [segment.a.x - edgeSeparation, segment.a.x + edgeSeparation] : []) : [];
    const occupiedYs = edgeSeparation > 0 ? occupied.flatMap(segment => same(segment.a.y, segment.b.y) ? [segment.a.y - edgeSeparation, segment.a.y + edgeSeparation] : []) : [];
    const segmentCost = (a: DependencyPoint, b: DependencyPoint) => {
      const cost = readability(a, b);
      return options.strictReadability && cost.hardConflict ? undefined : cost.cost;
    };
    // Rebuild once for this relation: its padded cards and occupied-lane seeds
    // differ from the previous relation. All of its port choices share it.
    const points = searchOrthogonalRoute({ sources, targets, obstacles,
      xs: [...obstacles.flatMap(rect => [rect.left, rect.right]), ...boundaryXs, ...occupiedXs].filter(x => !options.bounds || x >= options.bounds.left - epsilon && x <= options.bounds.right + epsilon),
      ys: [...obstacles.flatMap(rect => [rect.top, rect.bottom]), ...boundaryYs, ...occupiedYs].filter(y => !options.bounds || y >= options.bounds.top - epsilon && y <= options.bounds.bottom + epsilon), segmentCost,
      acceptPath: path => path.slice(1).every((b, i) => ![...rectangles, ...labels].some(rect => dependencySegmentCrossesRect(path[i]!, b, rect)) && segmentCost(path[i]!, b) !== undefined)
    });
    if (!points.length) continue;
    const route = { ...edge.link, points, d: points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ") };
    routes.push(route); occupied.push(...segments(points, edge.link.id));
  }
  return routes;
}
