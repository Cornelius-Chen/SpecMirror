import type { DependencyPoint, DependencyRect } from "./dependency-routing.ts";

/** A drawable endpoint and its outward, obstacle-free connection to the grid. */
export interface OrthogonalRoutePort {
  terminal: DependencyPoint;
  point: DependencyPoint;
  cost: number;
}
export interface OrthogonalRouteSearchInput {
  sources: readonly OrthogonalRoutePort[];
  targets: readonly OrthogonalRoutePort[];
  xs: readonly number[];
  ys: readonly number[];
  obstacles: readonly DependencyRect[];
  /** Undefined rejects a segment; a non-negative value is its extra cost. */
  segmentCost: (a: DependencyPoint, b: DependencyPoint) => number | undefined;
  acceptPath?: (points: readonly DependencyPoint[]) => boolean;
}
const epsilon = .001;
const direction = (a: DependencyPoint, b: DependencyPoint) => Math.abs(a.y - b.y) < epsilon ? b.x >= a.x ? 0 : 2 : b.y >= a.y ? 1 : 3;
const distance = (a: DependencyPoint, b: DependencyPoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
function simplify(points: readonly DependencyPoint[]) {
  const result: DependencyPoint[] = [];
  for (const point of points) {
    if (result.length && distance(result.at(-1)!, point) < epsilon) continue;
    while (result.length > 1) {
      const a = result.at(-2)!, b = result.at(-1)!;
      if (direction(a, b) === direction(b, point)) result.pop(); else break;
    }
    result.push(point);
  }
  return result;
}

/** One obstacle graph and one multi-source/multi-target A* search per relation.
 * Port choices share node validity and adjacency instead of rebuilding a grid
 * for their Cartesian product. Occupancy belongs to this call, never a stale
 * cross-relation cache. Adapted from the existing router's rectilinear A*;
 * visibility-graph/pin staging follows libavoid's orthogonal routing approach:
 * https://users.monash.edu/~mwybrow/papers/wybrow-gd-2009.pdf
 * https://www.adaptagrams.org/documentation/classAvoid_1_1ShapeConnectionPin.html */
export function searchOrthogonalRoute({ sources, targets, xs: xValues, ys: yValues, obstacles, segmentCost, acceptPath }: OrthogonalRouteSearchInput): DependencyPoint[] {
  if (!sources.length || !targets.length) return [];
  const xs = [...new Set([...xValues, ...sources.map(port => port.point.x), ...targets.map(port => port.point.x)])].sort((a, b) => a - b);
  const ys = [...new Set([...yValues, ...sources.map(port => port.point.y), ...targets.map(port => port.point.y)])].sort((a, b) => a - b);
  const width = xs.length, count = width * ys.length, xIndex = new Map(xs.map((x, i) => [x, i])), yIndex = new Map(ys.map((y, i) => [y, i]));
  const point = (id: number): DependencyPoint => ({ x: xs[id % width]!, y: ys[Math.floor(id / width)]! });
  const idOf = (point: DependencyPoint) => yIndex.get(point.y)! * width + xIndex.get(point.x)!;
  const valid = new Uint8Array(count);
  const isValid = (id: number) => {
    if (!valid[id]) {
      const p = point(id);
      valid[id] = obstacles.some(rect => p.x > rect.left + epsilon && p.x < rect.right - epsilon && p.y > rect.top + epsilon && p.y < rect.bottom - epsilon) ? 2 : 1;
    }
    return valid[id] === 1;
  };
  const adjacent = new Map<number, Array<{ id: number; direction: number; cost: number }>>();
  const neighbours = (id: number) => {
    const cached = adjacent.get(id); if (cached) return cached;
    const x = id % width, y = Math.floor(id / width), a = point(id), result: Array<{ id: number; direction: number; cost: number }> = [];
    for (const next of [x + 1 < width ? id + 1 : -1, y + 1 < ys.length ? id + width : -1, x ? id - 1 : -1, y ? id - width : -1]) {
      if (next < 0 || !isValid(next)) continue;
      const b = point(next), horizontal = Math.abs(a.y - b.y) < epsilon;
      if (obstacles.some(rect => horizontal
        ? a.y > rect.top + epsilon && a.y < rect.bottom - epsilon && Math.max(a.x, b.x) > rect.left + epsilon && Math.min(a.x, b.x) < rect.right - epsilon
        : a.x > rect.left + epsilon && a.x < rect.right - epsilon && Math.max(a.y, b.y) > rect.top + epsilon && Math.min(a.y, b.y) < rect.bottom - epsilon)) continue;
      const extra = segmentCost(a, b);
      if (extra !== undefined) result.push({ id: next, direction: direction(a, b), cost: distance(a, b) + extra });
    }
    adjacent.set(id, result); return result;
  };
  const targetById = new Map<number, OrthogonalRoutePort[]>();
  for (const target of targets) {
    const id = idOf(target.point); if (!isValid(id)) continue;
    targetById.set(id, [...(targetById.get(id) ?? []), target]);
  }
  if (!targetById.size) return [];
  const availableTargets = [...targetById.values()].flat(), estimates = new Float64Array(count).fill(-1);
  const estimate = (id: number) => {
    if (estimates[id]! < 0) { const p = point(id); estimates[id] = Math.min(...availableTargets.map(target => distance(p, target.point) + target.cost + distance(target.point, target.terminal))); }
    return estimates[id]!;
  };
  const heap: Array<{ state: number; cost: number; score: number }> = [];
  const push = (value: typeof heap[number]) => { let at = heap.length; heap.push(value); while (at > 0) { const parent = (at - 1) >> 1; if (heap[parent]!.score <= value.score) break; heap[at] = heap[parent]!; at = parent; } heap[at] = value; };
  const pop = () => { const first = heap[0]!, last = heap.pop()!; if (heap.length) { let at = 0; while (at * 2 + 1 < heap.length) { let child = at * 2 + 1; if (child + 1 < heap.length && heap[child + 1]!.score < heap[child]!.score) child++; if (heap[child]!.score >= last.score) break; heap[at] = heap[child]!; at = child; } heap[at] = last; } return first; };
  const costs = new Float64Array(count * 4).fill(Infinity), previous = new Int32Array(count * 4).fill(-1), origins = new Int32Array(count * 4).fill(-1);
  sources.forEach((source, index) => {
    const id = idOf(source.point); if (!isValid(id)) return;
    const state = id * 4 + direction(source.terminal, source.point), cost = source.cost + distance(source.terminal, source.point);
    if (cost >= costs[state]!) return;
    costs[state] = cost; origins[state] = index; push({ state, cost, score: cost + estimate(id) });
  });
  let bestCost = Infinity, best: DependencyPoint[] = [];
  while (heap.length) {
    const current = pop(); if (current.cost !== costs[current.state]) continue;
    if (current.score >= bestCost) break;
    const id = Math.floor(current.state / 4), arrival = current.state % 4;
    for (const target of targetById.get(id) ?? []) {
      const finalDirection = direction(target.point, target.terminal);
      if (arrival === (finalDirection + 2) % 4) continue;
      const total = current.cost + target.cost + distance(target.point, target.terminal) + (arrival !== finalDirection ? 14 : 0);
      if (total >= bestCost) continue;
      const path: DependencyPoint[] = [target.terminal]; let cursor = current.state;
      while (cursor >= 0) { path.push(point(Math.floor(cursor / 4))); const parent = previous[cursor]!; if (parent < 0) { path.push(sources[origins[cursor]!]!.terminal); break; } cursor = parent; }
      const simplified = simplify(path.reverse());
      if (!acceptPath || acceptPath(simplified)) { bestCost = total; best = simplified; }
    }
    for (const next of neighbours(id)) {
      if (next.direction === (arrival + 2) % 4) continue;
      const state = next.id * 4 + next.direction, cost = current.cost + next.cost + (arrival !== next.direction ? 14 : 0);
      if (cost >= costs[state]!) continue;
      costs[state] = cost; previous[state] = current.state; origins[state] = origins[current.state]!;
      push({ state, cost, score: cost + estimate(next.id) });
    }
  }
  return best;
}
