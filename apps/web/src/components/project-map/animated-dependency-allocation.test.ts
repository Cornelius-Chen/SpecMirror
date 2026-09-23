import { describe, expect, it } from "vitest";
import { routeDependencyLinks, type DependencyPoint, type DependencyRect, type DependencyRoute, type DependencyRoutingOptions, type RouteLink, type RoutingSegment } from "../engineering/dependency-routing.ts";
import { planAnimatedDependencyRoutes, sampleAnimatedDependencyRoutes } from "./animated-dependency-routes.ts";
import { restingInlineTreeNode } from "./inline-tree-transition.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import { allocationFixture, cardRect, narrowFeedbackFixture } from "./animated-dependency-allocation.fixture.ts";

const epsilon = .001;
const segments = (routes: readonly DependencyRoute[]): RoutingSegment[] => routes.flatMap(route => route.points.slice(1).map((b, i) => ({ id: route.id, a: route.points[i]!, b })));
const overlap = (a: number, b: number, c: number, d: number) => Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d));
const rectOverlap = (a: DependencyRect, b: DependencyRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > epsilon && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > epsilon;
const padded = (rect: DependencyRect, pad: number): DependencyRect => ({ ...rect, left: rect.left - pad, right: rect.right + pad, top: rect.top - pad, bottom: rect.bottom + pad });
// Independent predicates, rather than asking the router's own validators
// whether its returned geometry is safe. Orthogonal crossings remain allowed.
function entersRect(a: DependencyPoint, b: DependencyPoint, rect: DependencyRect) {
  if (Math.abs(a.x - b.x) < epsilon) return a.x > rect.left + epsilon && a.x < rect.right - epsilon && overlap(a.y, b.y, rect.top, rect.bottom) > epsilon;
  if (Math.abs(a.y - b.y) < epsilon) return a.y > rect.top + epsilon && a.y < rect.bottom - epsilon && overlap(a.x, b.x, rect.left, rect.right) > epsilon;
  return true;
}
function parallelConflict(one: RoutingSegment, two: RoutingSegment, gap: number) {
  const vertical = Math.abs(one.a.x - one.b.x) < epsilon && Math.abs(two.a.x - two.b.x) < epsilon;
  const horizontal = Math.abs(one.a.y - one.b.y) < epsilon && Math.abs(two.a.y - two.b.y) < epsilon;
  return vertical && overlap(one.a.y, one.b.y, two.a.y, two.b.y) > 1 && Math.abs(one.a.x - two.a.x) + epsilon < gap
    || horizontal && overlap(one.a.x, one.b.x, two.a.x, two.b.x) > 1 && Math.abs(one.a.y - two.a.y) + epsilon < gap;
}
const boundarySegments = (rect: DependencyRect): RoutingSegment[] => [
  { a: { x: rect.left, y: rect.top }, b: { x: rect.right, y: rect.top } },
  { a: { x: rect.left, y: rect.bottom }, b: { x: rect.right, y: rect.bottom } },
  { a: { x: rect.left, y: rect.top }, b: { x: rect.left, y: rect.bottom } },
  { a: { x: rect.right, y: rect.top }, b: { x: rect.right, y: rect.bottom } }
];
function arrowBounds(points: readonly DependencyPoint[], size: number): DependencyRect {
  const end = points.at(-1)!, previous = points.at(-2)!, angle = Math.atan2(end.y - previous.y, end.x - previous.x), c = Math.cos(angle), s = Math.sin(angle);
  const triangle = [[1, 0], [1 - size, -size / 2], [1 - size, size / 2]].map(([along, across]) => ({ x: end.x + along! * c - across! * s, y: end.y + along! * s + across! * c }));
  return { id: "arrow", left: Math.min(...triangle.map(p => p.x)), right: Math.max(...triangle.map(p => p.x)), top: Math.min(...triangle.map(p => p.y)), bottom: Math.max(...triangle.map(p => p.y)) };
}
function expectSafe(routes: readonly DependencyRoute[], nodes: readonly InlineTreeNode[], options: DependencyRoutingOptions, arrowSize = 8) {
  const cards = nodes.map(cardRect), byId = new Map(cards.map(card => [card.id, card])), allSegments = segments(routes);
  const distance = (point: DependencyPoint, card: DependencyRect) => Math.hypot(Math.max(card.left - point.x, 0, point.x - card.right), Math.max(card.top - point.y, 0, point.y - card.bottom));
  const inBounds = (point: DependencyPoint) => !options.bounds || point.x >= options.bounds.left - epsilon && point.x <= options.bounds.right + epsilon && point.y >= options.bounds.top - epsilon && point.y <= options.bounds.bottom + epsilon;
  for (const route of routes) {
    const from = byId.get(route.from)!, to = byId.get(route.to)!;
    expect(from, route.id).toBeDefined(); expect(to, route.id).toBeDefined(); expect(route.points.length).toBeGreaterThan(1);
    const first = route.points[0]!, last = route.points.at(-1)!;
    expect(distance(first, from), `${route.id} source port`).toBeCloseTo(0);
    expect(Math.min(Math.abs(first.x - from.left), Math.abs(first.x - from.right), Math.abs(first.y - from.top), Math.abs(first.y - from.bottom)), `${route.id} source on border`).toBeLessThan(epsilon);
    expect(distance(last, to), `${route.id} target port`).toBeCloseTo(3);
    for (const point of route.points) expect(Number.isFinite(point.x) && Number.isFinite(point.y) && inBounds(point), route.id).toBe(true);
    const reserved = [...options.reservedSegments ?? [], ...allSegments.filter(segment => segment.id !== route.id)];
    for (const segment of segments([route])) {
      expect(Math.abs(segment.a.x - segment.b.x) < epsilon || Math.abs(segment.a.y - segment.b.y) < epsilon, `${route.id} orthogonal`).toBe(true);
      for (const card of cards) expect(entersRect(segment.a, segment.b, padded(card, card.id === from.id || card.id === to.id ? 0 : 3)), `${route.id} crosses card ${card.id}`).toBe(false);
      for (const label of options.labelObstacles ?? []) expect(entersRect(segment.a, segment.b, padded(label, 1)), `${route.id} crosses title ${label.id}`).toBe(false);
      for (const boundary of options.boundaries ?? []) for (const edge of boundarySegments(boundary)) expect(parallelConflict(segment, edge, options.boundaryClearance ?? 0), `${route.id} hugs ${boundary.id}`).toBe(false);
      for (const other of reserved) expect(parallelConflict(segment, other, options.edgeSeparation ?? 0), `${route.id} shares reserved lane ${other.id}`).toBe(false);
    }
    const arrow = arrowBounds(route.points, arrowSize);
    expect(inBounds({ x: arrow.left, y: arrow.top }) && inBounds({ x: arrow.right, y: arrow.bottom }), `${route.id} arrow within world`).toBe(true);
    for (const obstacle of [...cards, ...(options.labelObstacles ?? []).map(label => padded(label, 1))]) expect(rectOverlap(arrow, obstacle), `${route.id} arrow overlaps ${obstacle.id}`).toBe(false);
  }
}
const expectIdentity = (routes: readonly DependencyRoute[], links: readonly RouteLink[]) => expect(routes.map(({ id, from, to, inherited }) => ({ id, from, to, inherited }))).toEqual(links);

describe("bounded final route allocation against captured geometry", () => {
  it.each([3, 4] as const)("keeps all five actual %i-column handoffs in raw and visible sampled output", columns => {
    const { nodes, rectangles, links, options } = allocationFixture(columns);
    const targetRoutes = routeDependencyLinks(rectangles, links, options);
    expectIdentity(targetRoutes, links); expectSafe(targetRoutes, nodes, options);
    const plan = planAnimatedDependencyRoutes({ links, targetRoutes, targetNodes: nodes });
    for (const progress of [.25, .5, 1]) {
      const sampled = sampleAnimatedDependencyRoutes(plan, { ...options, frameNodes: nodes.map(restingInlineTreeNode), progress, arrowSize: 8 });
      expect(sampled.deferred, `${columns} columns at ${progress}`).toEqual([]);
      expectIdentity(sampled.routes, links); expect(sampled.routes.every(route => route.opacity > 0)).toBe(true);
      expectSafe(sampled.routes, nodes, options);
    }
  });
  it("retains caller order and true endpoints when a target changes between the two measured layouts", () => {
    for (const [fromColumns, toColumns] of [[3, 4], [4, 3]] as const) {
      const before = allocationFixture(fromColumns), after = allocationFixture(toColumns);
      const previousRoutes = routeDependencyLinks(before.rectangles, before.links, before.options), targetRoutes = routeDependencyLinks(after.rectangles, after.links, after.options);
      expectIdentity(previousRoutes, before.links); expectIdentity(targetRoutes, after.links);
      const plan = planAnimatedDependencyRoutes({ links: after.links, previousRoutes, previousNodes: before.nodes, targetRoutes, targetNodes: after.nodes });
      const final = sampleAnimatedDependencyRoutes(plan, { ...after.options, frameNodes: after.nodes.map(restingInlineTreeNode), progress: 1, arrowSize: 8 });
      expect(final.deferred).toEqual([]); expectIdentity(final.routes, after.links); expectSafe(final.routes, after.nodes, after.options);
    }
  });
  it("reports a genuinely closed passage without borrowing an old cached path through its wall", () => {
    const { nodes, rectangles, links, options } = allocationFixture(3), selected = links.slice(0, 1);
    const previousRoutes = routeDependencyLinks(rectangles, selected, options); expectIdentity(previousRoutes, selected);
    const sealed = { ...options, labelObstacles: [...options.labelObstacles ?? [], { id: "sealed-wall", left: 350, right: 370, top: 0, bottom: 528 }] };
    const targetRoutes = routeDependencyLinks(rectangles, selected, sealed); expect(targetRoutes).toEqual([]);
    const sampled = sampleAnimatedDependencyRoutes(planAnimatedDependencyRoutes({ links: selected, previousRoutes, previousNodes: nodes, targetRoutes, targetNodes: nodes }), { ...sealed, frameNodes: nodes.map(restingInlineTreeNode), progress: 1, arrowSize: 8 });
    expect(sampled.routes).toEqual([]); expect(sampled.deferred).toEqual([{ ...selected[0]!, reason: "no-safe-candidate" }]);
  });
  it.each([457, 378] as const)("preserves the original dependency and a distinct safe feedback port at %i px", width => {
    const { nodes, rectangles, options, dependencyLinks, feedbackLinks, x } = narrowFeedbackFixture(width);
    const targetDependencies = routeDependencyLinks(rectangles, dependencyLinks, options); expectIdentity(targetDependencies, dependencyLinks);
    const dependencies = sampleAnimatedDependencyRoutes(planAnimatedDependencyRoutes({ links: dependencyLinks, targetRoutes: targetDependencies, targetNodes: nodes }), { ...options, frameNodes: nodes.map(restingInlineTreeNode), progress: 1, arrowSize: 8 });
    expect(dependencies.deferred).toEqual([]); expectIdentity(dependencies.routes, dependencyLinks);
    expect(dependencies.routes[0]!.d).toBe(`M ${x + 208} 616 L ${x + 228} 616 L ${x + 228} 440 L ${x + 211} 440`);
    expectSafe(dependencies.routes, nodes, options);
    const feedbackOptions = { ...options, reservedSegments: [...options.reservedSegments ?? [], ...segments(dependencies.routes)] };
    const targetFeedback = routeDependencyLinks(rectangles, feedbackLinks, feedbackOptions); expectIdentity(targetFeedback, feedbackLinks);
    const feedback = sampleAnimatedDependencyRoutes(planAnimatedDependencyRoutes({ links: feedbackLinks, targetRoutes: targetFeedback, targetNodes: nodes }), { ...feedbackOptions, frameNodes: nodes.map(restingInlineTreeNode), progress: 1, arrowSize: 7 });
    expect(feedback.deferred).toEqual([]); expectIdentity(feedback.routes, feedbackLinks); expectSafe(feedback.routes, nodes, feedbackOptions, 7);
    expect(Math.abs(feedback.routes[0]!.points.at(-1)!.y - dependencies.routes[0]!.points.at(-1)!.y)).toBeGreaterThanOrEqual(options.edgeSeparation! - epsilon);
  });
});
