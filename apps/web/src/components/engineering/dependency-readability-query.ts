import type { DependencyPoint, DependencyRect, RoutingSegment } from "./dependency-routing.ts";

const epsilon = .001;
const same = (a: number, b: number) => Math.abs(a - b) < epsilon;
interface Interval { low: number; high: number }
type LaneSegment = { kind: "parallel"; low: number; high: number } | { kind: "crossing"; at: number; key: string };
interface Lane { boundaries: Interval[]; occupied: LaneSegment[] }

/**
 * Reuse the router's call-local adjacency-cache pattern for lane queries.
 * Grid neighbours on one axis share the same possible boundary/line blockers;
 * their varying along-axis intervals still receive the original exact scoring.
 * Snapshot one relation's occupancy, then discard it before admitting the next
 * relation. No frame, endpoint choice or mutable geometry is cached here.
 */
export function createDependencyReadabilityQuery(boundaries: readonly DependencyRect[], occupied: readonly RoutingSegment[], boundaryClearance: number, edgeSeparation: number) {
  const boxes = boundaries.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
  const lines = occupied.map((segment, index) => {
    const ax = segment.a.x, ay = segment.a.y, bx = segment.b.x, by = segment.b.y;
    return { ax, ay, lowX: Math.min(ax, bx), highX: Math.max(ax, bx), lowY: Math.min(ay, by), highY: Math.max(ay, by),
      horizontal: same(ay, by), vertical: same(ax, bx), key: segment.id ?? `${index}:${ax},${ay}:${bx},${by}` };
  });
  const horizontalLanes = new Map<number, Lane>(), verticalLanes = new Map<number, Lane>();
  const laneAt = (at: number, horizontal: boolean): Lane => {
    const cache = horizontal ? horizontalLanes : verticalLanes;
    const cached = cache.get(at); if (cached) return cached;
    const lane: Lane = { boundaries: [], occupied: [] };
    // Keep source order, including overlap charges on duplicate boundaries.
    for (const box of boxes) {
      const distance = horizontal ? Math.min(Math.abs(at - box.top), Math.abs(at - box.bottom)) : Math.min(Math.abs(at - box.left), Math.abs(at - box.right));
      if (distance < boundaryClearance - epsilon) lane.boundaries.push(horizontal
        ? { low: Math.min(box.left, box.right), high: Math.max(box.left, box.right) }
        : { low: Math.min(box.top, box.bottom), high: Math.max(box.top, box.bottom) });
    }
    for (const line of lines) {
      if (horizontal ? line.horizontal : line.vertical) {
        if (Math.abs(at - (horizontal ? line.ay : line.ax)) < edgeSeparation - epsilon) lane.occupied.push(horizontal
          ? { kind: "parallel", low: line.lowX, high: line.highX }
          : { kind: "parallel", low: line.lowY, high: line.highY });
      } else if (horizontal ? line.vertical && line.lowY < at && at < line.highY : line.horizontal && line.lowX < at && at < line.highX) {
        lane.occupied.push({ kind: "crossing", at: horizontal ? line.ax : line.ay, key: line.key });
      }
    }
    cache.set(at, lane); return lane;
  };
  return (a: DependencyPoint, b: DependencyPoint): { cost: number; hardConflict: boolean } => {
    const horizontal = same(a.y, b.y), vertical = same(a.x, b.x);
    if (!horizontal && !vertical) return { cost: 1_000_000, hardConflict: true };
    // When both axes are near-equal, the original parallel branches take
    // precedence over crossings and both overlaps are below the 1px threshold.
    if (horizontal && vertical) return { cost: 0, hardConflict: false };
    const low = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y), high = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const lane = laneAt(horizontal ? a.y : a.x, horizontal);
    let cost = 0, hardConflict = false;
    for (const boundary of lane.boundaries) {
      const overlap = Math.max(0, Math.min(high, boundary.high) - Math.max(low, boundary.low));
      if (overlap > 1) { cost += 100_000 + overlap * 100; hardConflict = true; }
    }
    let chargedCrossings: Set<string> | undefined;
    for (const segment of lane.occupied) {
      if (segment.kind === "parallel") {
        const overlap = Math.max(0, Math.min(high, segment.high) - Math.max(low, segment.low));
        if (overlap > 1) { cost += 80_000 + overlap * 80; hardConflict = true; }
      } else if (low < segment.at && segment.at < high && !chargedCrossings?.has(segment.key)) {
        (chargedCrossings ??= new Set()).add(segment.key); cost += 20_000;
      }
    }
    return { cost, hardConflict };
  };
}
