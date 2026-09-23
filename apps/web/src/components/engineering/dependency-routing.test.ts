import { describe, expect, it } from "vitest";
import { dependencyReadabilityPenalty, dependencySegmentCrossesRect, routeDependencyLinks, uniqueRoutingSegments, type DependencyRect, type DependencyRoute, type RouteLink } from "./dependency-routing.ts";

const rect = (id: string, left: number, top: number, width = 180, height = 100): DependencyRect => ({ id, left, top, right: left + width, bottom: top + height });
const link = (from: string, to: string, inherited = false): RouteLink => ({ id: from + "/" + to, from, to, inherited });
const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)));
const segments = (route: DependencyRoute) => route.points.slice(1).map((b, index) => ({ route: route.id, a: route.points[index]!, b }));
function expectClear(routes: DependencyRoute[], rectangles: DependencyRect[], links: RouteLink[]) {
  expect(routes.map(route => route.id)).toEqual(links.map(edge => edge.id));
  for (const route of routes) {
    expect(route.points.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < route.points.length; i++) for (const obstacle of rectangles) {
      expect(dependencySegmentCrossesRect(route.points[i - 1], route.points[i], obstacle), `${route.id} segment ${i} crosses ${obstacle.id}`).toBe(false);
      if (obstacle.id !== route.from && obstacle.id !== route.to) expect(dependencySegmentCrossesRect(route.points[i - 1], route.points[i], { ...obstacle, left: obstacle.left - 3, right: obstacle.right + 3, top: obstacle.top - 3, bottom: obstacle.bottom + 3 }), `${route.id} lacks clearance at ${obstacle.id}`).toBe(false);
    }
  }
}

describe("dependency arrow obstacle routing", () => {
  it.each(["source", "target"])("checks reservations on the short %s connector outside the search grid", side => {
    const cards = [rect("source", 20, 20), rect("target", 300, 20)], edges = [link("source", "target")];
    // The search begins at x206 and finishes at x294. Neither grid endpoint
    // sees this reserved short run, but the actual card-to-grid connector does.
    const reservedSegments = [side === "source" ? { id: "existing", a: { x: 200, y: 70 }, b: { x: 205, y: 70 } }
      : { id: "existing", a: { x: 295, y: 70 }, b: { x: 297, y: 70 } }];
    const routes = routeDependencyLinks(cards, edges, { reservedSegments, edgeSeparation: 8, strictReadability: true });
    expectClear(routes, cards, edges);
    for (const segment of segments(routes[0]!)) expect(dependencyReadabilityPenalty(segment.a, segment.b, [], reservedSegments, 0, 8).hardConflict).toBe(false);
  });

  it("routes a cross-column arrow around a tall middle card instead of suggesting a false chain", () => {
    const cards = [rect("source", 20, 30), rect("middle", 250, 15, 200, 320), rect("target", 500, 180)], edges = [link("source", "target")];
    const routes = routeDependencyLinks(cards, edges);
    expectClear(routes, cards, edges);
    expect(routes[0].points.some(point => point.y < cards[1].top || point.y > cards[1].bottom)).toBe(true);
  });
  it("handles forward and reverse phone arrows within the canvas and outside intervening cards", () => {
    const cards = [rect("top", 18, 18, 310, 140), rect("middle", 18, 182, 310, 200), rect("bottom", 18, 406, 310, 130)], edges = [link("top", "bottom"), link("bottom", "top", true)];
    const routes = routeDependencyLinks(cards, edges);
    expectClear(routes, cards, edges);
    for (const route of routes) for (const point of route.points) { expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(350); expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(554); }
    expect(routes[1].inherited).toBe(true);
  });
  it("recalculates the route for changed title height rather than retaining the old crossing", () => {
    const cards = [rect("source", 20, 200), rect("middle", 250, 20, 200, 100), rect("target", 500, 200)], edges = [link("source", "target")];
    const before = routeDependencyLinks(cards, edges); expectClear(before, cards, edges);
    const grown = cards.map(card => card.id === "middle" ? { ...card, bottom: 350 } : card), after = routeDependencyLinks(grown, edges);
    expectClear(after, grown, edges); expect(after[0].d).not.toBe(before[0].d);
  });
  it("keeps the real seven-task convergence readable with distinct arrowheads and all edges retained", () => {
    const cards = [rect("identity", 18, 18), rect("plan", 228, 18), rect("agent", 438, 18), rect("source", 18, 142), rect("jervis", 228, 142), rect("final", 438, 142), rect("delivery", 18, 266)];
    const edges = [link("identity", "final"), link("plan", "final"), link("agent", "final"), link("source", "final"), link("jervis", "delivery", true), link("final", "delivery")];
    const routes = routeDependencyLinks(cards, edges); expectClear(routes, cards, edges);
    const endpoints = routes.filter(route => route.to === "final").map(route => JSON.stringify(route.points.at(-1)));
    expect(new Set(endpoints).size).toBe(4);
  });
  it("bounds routing work to the supplied sixteen-card forty-edge visible graph without dropping edges", () => {
    const cards = Array.from({ length: 16 }, (_, i) => rect(String(i), 20 + i % 4 * 210, 20 + Math.floor(i / 4) * 140));
    const edges = cards.flatMap((card, i) => cards.slice(i + 1).map(target => link(card.id, target.id))).slice(0, 40);
    expectClear(routeDependencyLinks(cards, edges), cards, edges);
  });
  it("keeps stacked arrows away from region outlines and assigns separate parallel lanes", () => {
    const cards = [rect("a", 84, 28, 208, 120), rect("b", 84, 204, 208, 120), rect("c", 84, 380, 208, 120), rect("d", 84, 556, 208, 120)];
    const boundaries = cards.map(card => ({ ...card, id: `zone:${card.id}`, left: card.left - 8, right: card.right + 8, top: card.top - 28, bottom: card.bottom + 10 }));
    const routes = routeDependencyLinks(cards, [link("a", "c"), link("b", "d")], {
      boundaries, boundaryClearance: 10, edgeSeparation: 8, strictReadability: true, bounds: { left: 4, right: 386, top: 4, bottom: 696 }
    });
    expectClear(routes, cards, [link("a", "c"), link("b", "d")]);
    const routeSegments = routes.flatMap(segments);
    for (const segment of routeSegments) for (const boundary of boundaries) {
      if (segment.a.x === segment.b.x) {
        const shared = overlap(segment.a.y, segment.b.y, boundary.top, boundary.bottom);
        if (shared > 1) expect(Math.min(Math.abs(segment.a.x - boundary.left), Math.abs(segment.a.x - boundary.right)), `${segment.route} hugs ${boundary.id}`).toBeGreaterThanOrEqual(10);
      } else if (segment.a.y === segment.b.y) {
        const shared = overlap(segment.a.x, segment.b.x, boundary.left, boundary.right);
        if (shared > 1) expect(Math.min(Math.abs(segment.a.y - boundary.top), Math.abs(segment.a.y - boundary.bottom)), `${segment.route} hugs ${boundary.id}`).toBeGreaterThanOrEqual(10);
      }
    }
    for (const [index, one] of routeSegments.entries()) for (const two of routeSegments.slice(index + 1)) {
      if (one.route === two.route) continue;
      if (one.a.x === one.b.x && two.a.x === two.b.x && overlap(one.a.y, one.b.y, two.a.y, two.b.y) > 1) expect(Math.abs(one.a.x - two.a.x), `${one.route} overlaps ${two.route}`).toBeGreaterThanOrEqual(8);
      if (one.a.y === one.b.y && two.a.y === two.b.y && overlap(one.a.x, one.b.x, two.a.x, two.b.x) > 1) expect(Math.abs(one.a.y - two.a.y), `${one.route} overlaps ${two.route}`).toBeGreaterThanOrEqual(8);
    }
  });
  it("changes ports instead of dropping a diagonal handoff when adjacent zones block the preferred side", () => {
    const cards = [rect("blocker", 140, 20, 76, 80), rect("source", 240, 20, 100, 80), rect("target", 20, 212, 100, 80)];
    const zones = [rect("zone:blocker", 132, 0, 92, 108), rect("zone:source", 232, 0, 116, 108), rect("zone:target", 12, 192, 116, 108)];
    const edge = link("source", "target");
    const routes = routeDependencyLinks(cards, [edge], {
      boundaries: zones, boundaryClearance: 10, edgeSeparation: 8, strictReadability: true,
      bounds: { left: 4, right: 356, top: 4, bottom: 316 }
    });
    expectClear(routes, cards, [edge]);
    // The preferred left port is trapped in the 8px gap between two zone
    // outlines. A vertical port leaves through open space and keeps the edge.
    expect(routes[0].points[0]!.y).toBe(cards[1].bottom);
    const end = routes[0].points.at(-1)!, target = cards[2]!;
    expect(Math.hypot(Math.max(target.left - end.x, 0, end.x - target.right), Math.max(target.top - end.y, 0, end.y - target.bottom))).toBeCloseTo(3);
    const beforeEnd = routes[0].points.at(-2)!;
    if (end.x < target.left) expect(beforeEnd.x).toBeLessThan(end.x);
    else if (end.x > target.right) expect(beforeEnd.x).toBeGreaterThan(end.x);
    else if (end.y < target.top) expect(beforeEnd.y).toBeLessThan(end.y);
    else expect(beforeEnd.y).toBeGreaterThan(end.y);
    for (const segment of segments(routes[0]!)) expect(dependencyReadabilityPenalty(segment.a, segment.b, zones, [], 10, 8).hardConflict).toBe(false);
  });
  it("keeps one strict route when it must cross a four-member bus orthogonally", () => {
    const cards = [rect("source", 20, 100, 80, 80), rect("target", 260, 100, 80, 80)], edge = link("source", "target");
    const bus = Array.from({ length: 4 }, () => ({ id: "composition:four-member-bus", a: { x: 180, y: 4 }, b: { x: 180, y: 316 } }));
    const routes = routeDependencyLinks(cards, [edge], {
      edgeSeparation: 8, reservedSegments: bus, strictReadability: true,
      bounds: { left: 4, right: 356, top: 4, bottom: 316 }
    });
    expectClear(routes, cards, [edge]);
    expect(routes).toHaveLength(1);
    expect(segments(routes[0]!).some(segment => segment.a.y === segment.b.y && Math.min(segment.a.x, segment.b.x) < 180 && Math.max(segment.a.x, segment.b.x) > 180)).toBe(true);
  });
  it("deduplicates reserved geometry independently of direction and source id", () => {
    const unique = uniqueRoutingSegments([
      { id: "composition:a", a: { x: 20, y: 40 }, b: { x: 120, y: 40 } },
      { id: "composition:b", a: { x: 120, y: 40 }, b: { x: 20, y: 40 } },
      { id: "dependency:c", a: { x: 20.0004, y: 40 }, b: { x: 120, y: 40.0004 } },
      { id: "zero", a: { x: 60, y: 40 }, b: { x: 60, y: 40 } },
      { id: "other", a: { x: 20, y: 48 }, b: { x: 120, y: 48 } }
    ]);
    expect(unique.map(segment => segment.id)).toEqual(["composition:a", "other"]);
  });
  it("never substitutes an unsafe straight line when malformed overlapping cards leave no free route", () => {
    const cards = [rect("a", 20, 20), rect("b", 25, 25)], edges = [link("a", "b")];
    expect(routeDependencyLinks(cards, edges)).toEqual([]);
  });
});
