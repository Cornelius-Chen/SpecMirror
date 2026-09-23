import { describe, expect, it, vi } from "vitest";
import * as routing from "../engineering/dependency-routing.ts";
import { animatedComposition } from "./animated-composition.ts";
import { planAnimatedRegions, sampleAnimatedRegions } from "./animated-map-regions.ts";
import { planAnimatedDependencyRoutes, sampleAnimatedDependencyRoutes, type AnimatedDependencySnapshot } from "./animated-dependency-routes.ts";
import { boundedTreeLayout } from "./bounded-tree-layout.ts";
import { EngineeringNodeSchema, deriveEngineeringView } from "@epm/domain";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import { planInlineTreeTransition, restingInlineTreeNode, type AnimatedInlineTreeNode, type InlineTreeTransitionPlan } from "./inline-tree-transition.ts";

const node = (id: string, x: number, y: number): InlineTreeNode => ({ id, x, y, width: 100, height: 80, parentId: null, depth: 0, expanded: false, childCount: 0 });
const rect = (node: InlineTreeNode): routing.DependencyRect => ({ id: node.id, left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + node.height });
const link = (from: string, to: string): routing.RouteLink => ({ id: `${from}>${to}`, from, to, inherited: false });
const route = (from: string, to: string, points: routing.DependencyPoint[]): routing.DependencyRoute => ({ ...link(from, to), points, d: points.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" ") });
const frameAt = (plan: InlineTreeTransitionPlan, p: number) => plan.from.map((item, i) => ({ ...item, x: item.x + (plan.to[i]!.x - item.x) * p, y: item.y + (plan.to[i]!.y - item.y) * p, opacity: item.opacity + (plan.to[i]!.opacity - item.opacity) * p }));
const stages = [0, .05, .15, .3, .5, .7, .85, .95, 1];
const gapToCard = (point: routing.DependencyPoint, card: InlineTreeNode) => Math.hypot(Math.max(card.x - point.x, 0, point.x - card.x - card.width), Math.max(card.y - point.y, 0, point.y - card.y - card.height));
function expectSafe(snapshot: AnimatedDependencySnapshot, frame: readonly AnimatedInlineTreeNode[], links: readonly routing.RouteLink[], labels: readonly routing.DependencyRect[] = []) {
  expect([...snapshot.routes, ...snapshot.deferred].map(item => item.id).sort()).toEqual(links.map(item => item.id).sort());
  const real = new Map(frame.filter(item => !item.ghost).map(item => [item.id, item]));
  for (const item of snapshot.routes) {
    expect(item.from).toBe(links.find(edge => edge.id === item.id)!.from);
    expect(item.to).toBe(links.find(edge => edge.id === item.id)!.to);
    expect(gapToCard(item.points[0]!, real.get(item.from)!)).toBeCloseTo(0);
    expect(gapToCard(item.points.at(-1)!, real.get(item.to)!)).toBeCloseTo(3);
    expect(item.opacity).toBeLessThanOrEqual(Math.min(real.get(item.from)!.opacity, real.get(item.to)!.opacity));
    for (let i = 1; i < item.points.length; i++) for (const obstacle of [...frame.filter(node => node.opacity > 0).map(rect), ...labels]) {
      expect(routing.dependencySegmentCrossesRect(item.points[i - 1]!, item.points[i]!, obstacle), `${item.id} crosses ${obstacle.id}`).toBe(false);
    }
  }
}

describe("cached dependency frame routes", () => {
  it.each([{ width: 457, x: 124.5, edgeSeparation: 8 }, { width: 378, x: 85, edgeSeparation: 12 }])("keeps a feedback arrival beside an occupied dependency arrival at $width px", ({ width, x, edgeSeparation }) => {
    const nodes = ["root", "alpha", "beta", "gamma"].map((id, i) => ({ ...node(id, x, 28 + i * 176), width: 208, height: 120 }));
    const boundaries = nodes.slice(1).map(item => ({ id: `zone:${item.id}`, left: x - 8, right: x + 216, top: item.y - 28, bottom: item.y + 130 }));
    const labels = nodes.slice(1).map(item => ({ id: `label:${item.id}`, left: x, right: x + 190, top: item.y - 25, bottom: item.y - 3 }));
    const segments = (routes: readonly routing.DependencyRoute[]) => routes.flatMap(item => item.points.slice(1).map((b, i) => ({ id: item.id, a: item.points[i]!, b })));
    const composition = [
      route("root", "alpha", [{ x: x + 104, y: 148 }, { x: x - 28, y: 148 }, { x: x - 28, y: 264 }, { x, y: 264 }]),
      ...[440, 616].map((y, i) => route("root", ["beta", "gamma"][i]!, [{ x, y: 88 }, { x: x - 28, y: 88 }, { x: x - 28, y }, { x, y }]))
    ];
    const options = { boundaries, labelObstacles: labels, boundaryClearance: 12, edgeSeparation, strictReadability: true, bounds: { left: 4, right: width - 4, top: 4, bottom: 700 }, reservedSegments: segments(composition) };
    const dependencyLinks = [link("gamma", "beta")], feedbackLinks = [link("alpha", "beta")];
    const targetDependencies = routing.routeDependencyLinks(nodes.map(rect), dependencyLinks, options);
    const frameNodes = nodes.map(restingInlineTreeNode);
    const dependencies = sampleAnimatedDependencyRoutes(planAnimatedDependencyRoutes({ links: dependencyLinks, targetRoutes: targetDependencies, targetNodes: nodes }), { ...options, frameNodes, progress: 1, arrowSize: 8 });
    const feedbackOptions = { ...options, reservedSegments: [...options.reservedSegments, ...segments(targetDependencies)] };
    const targetFeedback = routing.routeDependencyLinks(nodes.map(rect), feedbackLinks, feedbackOptions);
    const feedback = sampleAnimatedDependencyRoutes(planAnimatedDependencyRoutes({ links: feedbackLinks, targetRoutes: targetFeedback, targetNodes: nodes }), { ...feedbackOptions, reservedSegments: [...options.reservedSegments, ...segments(dependencies.routes)], frameNodes, progress: 1, arrowSize: 7 });
    expect(dependencies.routes).toHaveLength(1); expect(targetFeedback).toHaveLength(1); expect(feedback.routes).toHaveLength(1);
    expect(dependencies.routes[0]!.d).toBe(`M ${x + 208} 616 L ${x + 228} 616 L ${x + 228} 440 L ${x + 211} 440`);
    expect(dependencies.routes[0]!.d).toBe(targetDependencies[0]!.d);
    expect(feedback.deferred).toEqual([]);
    // edgeSeparation is the declared minimum; an arrival exactly at that
    // distance is valid. The full path/arrow and reservation checks below stay.
    expect(feedback.routes[0]!.points.at(-1)!.y).toBeLessThanOrEqual(440 - edgeSeparation);
    expectSafe(dependencies, frameNodes, dependencyLinks, labels);
    expectSafe(feedback, frameNodes, feedbackLinks, labels);
    for (const segment of segments(feedback.routes)) expect(routing.dependencyReadabilityPenalty(segment.a, segment.b, boundaries, [...options.reservedSegments, ...segments(dependencies.routes)], 12, edgeSeparation).hardConflict).toBe(false);
  });

  it("keeps endpoints attached and an unrelated established route exactly unchanged", () => {
    const before = [node("a", 20, 100), node("b", 400, 100), node("c", 20, 700), node("d", 400, 700)];
    const after = before.map(item => item.id === "b" ? { ...item, y: 280 } : item), links = [link("a", "b"), link("c", "d")];
    const previousRoutes = routing.routeDependencyLinks(before.map(rect), links), targetRoutes = routing.routeDependencyLinks(after.map(rect), links);
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes, previousNodes: before, targetRoutes, targetNodes: after });
    const motion = planInlineTreeTransition(before.map(restingInlineTreeNode), after);
    for (const progress of stages) {
      const frame = frameAt(motion, progress), sample = sampleAnimatedDependencyRoutes(plan, { frameNodes: frame, progress });
      expectSafe(sample, frame, links);
      expect(sample.deferred).toEqual([]);
      expect(sample.routes.find(item => item.id === "c>d")!.d).toBe(previousRoutes.find(item => item.id === "c>d")!.d);
    }
    const middle = frameAt(motion, .5), displayed = sampleAnimatedDependencyRoutes(plan, { frameNodes: middle, progress: .5 });
    const reverse = planAnimatedDependencyRoutes({ links, previousRoutes: displayed.routes, previousNodes: middle, targetRoutes: previousRoutes, targetNodes: before });
    expect(sampleAnimatedDependencyRoutes(reverse, { frameNodes: middle, progress: 0 }).routes).toEqual(displayed.routes);
  });

  it("uses a safe cached alternative when an old lane is blocked by a ghost or moving title", () => {
    const nodes = [node("a", 20, 100), node("b", 320, 100)], links = [link("a", "b")];
    const old = route("a", "b", [{ x: 70, y: 180 }, { x: 70, y: 230 }, { x: 370, y: 230 }, { x: 370, y: 183 }]);
    const target = route("a", "b", [{ x: 70, y: 180 }, { x: 70, y: 290 }, { x: 370, y: 290 }, { x: 370, y: 183 }]);
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes: [old], previousNodes: nodes, targetRoutes: [target], targetNodes: nodes });
    const ghost = { ...restingInlineTreeNode(node("a", 160, 195)), width: 60, height: 75, opacity: .5, ghost: true, exiting: true };
    const frame = [...nodes.map(restingInlineTreeNode), ghost];
    const sample = sampleAnimatedDependencyRoutes(plan, { frameNodes: frame, progress: .4 });
    expectSafe(sample, frame, links); expect(sample.deferred).toEqual([]);
    expect(sample.routes[0]!.d).toBe(target.d);
    const title = { id: "moving-caption", left: 160, right: 220, top: 195, bottom: 270 };
    const labelSample = sampleAnimatedDependencyRoutes(plan, { frameNodes: nodes.map(restingInlineTreeNode), progress: .4, labelObstacles: [title] });
    expectSafe(labelSample, nodes.map(restingInlineTreeNode), links, [title]);
    expect(labelSample.routes[0]!.d).toBe(target.d);
  });

  it("retains a previous safe relation when the final route cache has no path", () => {
    const nodes = [node("a", 20, 100), node("b", 320, 100)], links = [link("a", "b")];
    const previousRoutes = routing.routeDependencyLinks(nodes.map(rect), links);
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes, previousNodes: nodes, targetRoutes: [], targetNodes: nodes });
    const sample = sampleAnimatedDependencyRoutes(plan, { frameNodes: nodes.map(restingInlineTreeNode), progress: 1 });
    expect(sample.deferred).toEqual([]); expect(sample.routes[0]!.d).toBe(previousRoutes[0]!.d);
  });

  it("distinguishes missing and hidden endpoints without allowing ghosts or removed links to own routes", () => {
    const nodes = [node("a", 20, 100), node("b", 320, 100)], links = [link("a", "b")], targetRoutes = routing.routeDependencyLinks(nodes.map(rect), links);
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes: targetRoutes, previousNodes: nodes, targetRoutes, targetNodes: nodes });
    const hidden = sampleAnimatedDependencyRoutes(plan, { frameNodes: nodes.map(item => ({ ...restingInlineTreeNode(item), opacity: item.id === "b" ? 0 : 1 })), progress: .5 });
    expect(hidden.routes).toEqual([]); expect(hidden.deferred[0]!.reason).toBe("hidden-endpoint");
    const missing = sampleAnimatedDependencyRoutes(plan, { frameNodes: nodes.map(item => ({ ...restingInlineTreeNode(item), ghost: item.id === "b" })), progress: .5 });
    expect(missing.routes).toEqual([]); expect(missing.deferred[0]!.reason).toBe("missing-endpoint");
    const removed = planAnimatedDependencyRoutes({ links: [], previousRoutes: targetRoutes, previousNodes: nodes, targetRoutes: [], targetNodes: nodes });
    expect(sampleAnimatedDependencyRoutes(removed, { frameNodes: nodes.map(restingInlineTreeNode), progress: 0 })).toEqual({ routes: [], deferred: [] });
  });

  it.each(["card", "title", "boundary", "reserved", "arrow", "bounds"])("defers only the unsafe %s route and preserves other relationships", obstacleKind => {
    const nodes = [node("a", 20, 100), node("b", 320, 100), node("c", 20, 400), node("d", 320, 400)], links = [link("a", "b"), link("c", "d")];
    const targetRoutes = routing.routeDependencyLinks(nodes.map(rect), links), frame = nodes.map(restingInlineTreeNode);
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes: targetRoutes, previousNodes: nodes, targetRoutes, targetNodes: nodes });
    const sample = sampleAnimatedDependencyRoutes(plan, { frameNodes: obstacleKind === "card" ? [...frame, { ...restingInlineTreeNode(node("blocker", 170, 110)), width: 50, height: 60 }] : frame, progress: 1,
      labelObstacles: obstacleKind === "title" ? [{ id: "caption", left: 121, right: 124, top: 95, bottom: 185 }]
        : obstacleKind === "arrow" ? [116.5, 136.5, 156.5].map(top => ({ id: `arrow-only-title:${top}`, left: 312, right: 314, top, bottom: top + 1 })) : [],
      boundaries: obstacleKind === "boundary" ? [{ id: "zone", left: 160, right: 250, top: 136, bottom: 220 }] : [], boundaryClearance: 10,
      reservedSegments: obstacleKind === "reserved" ? [{ id: "composition", a: { x: 150, y: 142 }, b: { x: 260, y: 142 } }] : [], edgeSeparation: 8,
      bounds: obstacleKind === "bounds" ? { left: 4, right: 500, top: 200, bottom: 520 } : undefined
    });
    expect(sample.routes.map(item => item.id)).toEqual(["c>d"]);
    expect(sample.deferred).toEqual([{ ...links[0]!, reason: "no-safe-candidate" }]);
    expect(sample.routes[0]!.d).toBe(targetRoutes[1]!.d);
    if (obstacleKind === "arrow") {
      const label = { id: "arrow-only-title", left: 312, right: 314, top: 136.5, bottom: 137.5 };
      const points = targetRoutes[0]!.points;
      expect(points.slice(1).every((point, i) => !routing.dependencySegmentCrossesRect(points[i]!, point, label))).toBe(true);
    }
  });

  it("applies a world-origin shift once and resumes opacity from the actual displayed snapshot", () => {
    const nodes = [node("a", 20, 100), node("b", 320, 100)], links = [link("a", "b")];
    const previousRoutes = routing.routeDependencyLinks(nodes.map(rect), links).map(item => ({ ...item, opacity: .45 }));
    const offset = { x: 30, y: 20 }, shifted = nodes.map(item => ({ ...item, x: item.x + offset.x, y: item.y + offset.y }));
    const targetRoutes = routing.routeDependencyLinks(shifted.map(rect), links);
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes, previousNodes: nodes, targetRoutes, targetNodes: shifted, originOffset: offset });
    const sample = sampleAnimatedDependencyRoutes(plan, { frameNodes: shifted.map(restingInlineTreeNode), progress: 0 });
    expect(sample.routes[0]!.points).toEqual(previousRoutes[0]!.points.map(point => ({ x: point.x + offset.x, y: point.y + offset.y })));
    expect(sample.routes[0]!.opacity).toBe(.45);
    expect(sampleAnimatedDependencyRoutes(plan, { frameNodes: shifted.map(restingInlineTreeNode), progress: 1 }).routes[0]!.opacity).toBe(1);
  });

  it("reserves displayed dependency lanes when sampling a separate feedback plan", () => {
    const nodes = [node("a", 20, 100), node("b", 320, 100), node("c", 220, 360)], dependencyLinks = [link("a", "b")], feedbackLinks = [link("a", "c")];
    const dependencyRoutes = routing.routeDependencyLinks(nodes.map(rect), dependencyLinks, { edgeSeparation: 8, strictReadability: true });
    const segments = (routes: readonly routing.DependencyRoute[]) => routes.flatMap(item => item.points.slice(1).map((b, i) => ({ id: item.id, a: item.points[i]!, b })));
    const feedbackRoutes = routing.routeDependencyLinks(nodes.map(rect), feedbackLinks, { reservedSegments: segments(dependencyRoutes), edgeSeparation: 8, strictReadability: true });
    const frame = nodes.map(restingInlineTreeNode);
    const dependencies = sampleAnimatedDependencyRoutes(planAnimatedDependencyRoutes({ links: dependencyLinks, previousRoutes: dependencyRoutes, previousNodes: nodes, targetRoutes: dependencyRoutes, targetNodes: nodes }), { frameNodes: frame, progress: .5, edgeSeparation: 8, arrowSize: { "a>b": 8 } });
    const feedback = sampleAnimatedDependencyRoutes(planAnimatedDependencyRoutes({ links: feedbackLinks, previousRoutes: feedbackRoutes, previousNodes: nodes, targetRoutes: feedbackRoutes, targetNodes: nodes }), { frameNodes: frame, progress: .5, edgeSeparation: 8, reservedSegments: segments(dependencies.routes), arrowSize: 7 });
    expect(dependencies.routes).toHaveLength(1); expect(feedback.routes).toHaveLength(1);
    expectSafe(dependencies, frame, dependencyLinks); expectSafe(feedback, frame, feedbackLinks);
    for (const segment of segments(feedback.routes)) expect(routing.dependencyReadabilityPenalty(segment.a, segment.b, [], segments(dependencies.routes), 0, 8).hardConflict).toBe(false);
  });

  it("uses a cached alternative target port when only the arrowhead touches a title", () => {
    const nodes = [node("a", 20, 100), node("b", 320, 100)], links = [link("a", "b")], targetRoutes = routing.routeDependencyLinks(nodes.map(rect), links);
    const label = { id: "arrow-only-title", left: 312, right: 314, top: 136.5, bottom: 137.5 };
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes: targetRoutes, previousNodes: nodes, targetRoutes, targetNodes: nodes });
    const frame = nodes.map(restingInlineTreeNode), sample = sampleAnimatedDependencyRoutes(plan, { frameNodes: frame, progress: 1, labelObstacles: [label] });
    expect(sample.routes).toHaveLength(1); expect(sample.deferred).toEqual([]);
    expectSafe(sample, frame, links, [label]);
    expect(sample.routes[0]!.points.at(-1)!.y).not.toBe(targetRoutes[0]!.points.at(-1)!.y);
  });

  it.each([350, 800, 1250])("uses the actual node/region frame for phone and wider cross-zone links at %i px", width => {
    const stamp = "2026-09-13T00:00:00Z";
    const make = (id: string, parent_id: string | null, order: number) => EngineeringNodeSchema.parse({ id, parent_id, title: id, kind: parent_id ? "task" : "project", objective: "fixture", owner: "未分配", order, revision: 1, status: "draft", constraints: {}, created_at: stamp, updated_at: stamp });
    const nodes = [make("root", null, 0), ...["a", "b", "c", "d", "e"].map((id, i) => make(id, "root", i)), make("c1", "c", 0), make("c2", "c", 1)];
    const view = deriveEngineeringView({ schema_version: 1, id: "animated-dependency", root_id: "root", revision: 1, nodes, runs: [], events: [], changes: [], capability_uses: [], created_at: stamp, updated_at: stamp });
    const zones = ["a", "b", "c", "d", "e"].map(id => ({ id: `zone:${id}`, root_node_id: id, node_ids: id === "c" ? [id, "c1", "c2"] : [id] }));
    const before = boundedTreeLayout(view, ["root"], width), after = boundedTreeLayout(view, ["root", "c"], width, before.columns), links = [link("a", "b")];
    const regionBefore = sampleAnimatedRegions(planAnimatedRegions({ targetNodes: before.nodes, zones, width, height: before.height }), before.nodes.map(restingInlineTreeNode), 1);
    const regions = planAnimatedRegions({ previous: regionBefore, targetNodes: after.nodes, zones, width, height: after.height });
    const regionAfter = sampleAnimatedRegions(regions, after.nodes.map(restingInlineTreeNode), 1);
    const options = (region: typeof regionAfter) => ({ boundaries: region.zones.map(zone => ({ id: zone.id, left: zone.x, right: zone.x + zone.width, top: zone.y, bottom: zone.y + zone.height })), labelObstacles: region.labels.filter(label => label.opacity > 0), boundaryClearance: 10, edgeSeparation: 8, strictReadability: true,
      bounds: { left: 4, right: width - 4, top: 4, bottom: after.height - 4 } });
    const compositionAt = (region: typeof regionAfter, settledNodes: readonly InlineTreeNode[]) => animatedComposition(region.nodes, settledNodes, width, { groups: region.groups.filter(group => group.opacity > 0), labelObstacles: options(region).labelObstacles, wrappedRootSideEntry: true, alignedLaneSide: "left" });
    const reservations = (region: typeof regionAfter, settledNodes: readonly InlineTreeNode[]) => compositionAt(region, settledNodes).segments.map(segment => ({ id: segment.id, a: segment.a, b: segment.b }));
    const previousRoutes = routing.routeDependencyLinks(before.nodes.map(rect), links, { ...options(regionBefore), reservedSegments: reservations(regionBefore, before.nodes) }), targetRoutes = routing.routeDependencyLinks(after.nodes.map(rect), links, { ...options(regionAfter), reservedSegments: reservations(regionAfter, after.nodes) });
    expect(previousRoutes).toHaveLength(1); expect(targetRoutes).toHaveLength(1);
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes, previousNodes: before.nodes, targetRoutes, targetNodes: after.nodes });
    const motion = planInlineTreeTransition(before.nodes.map(restingInlineTreeNode), after.nodes, "c");
    for (const progress of stages) {
      const region = sampleAnimatedRegions(regions, frameAt(motion, progress), progress), opts = options(region);
      const composition = animatedComposition(region.nodes, after.nodes, width, { groups: region.groups.filter(group => group.opacity > 0), labelObstacles: opts.labelObstacles, wrappedRootSideEntry: true, alignedLaneSide: "left" });
      const sample = sampleAnimatedDependencyRoutes(plan, { ...opts, frameNodes: region.nodes, progress, reservedSegments: composition.segments.map(segment => ({ id: segment.id, a: segment.a, b: segment.b })) });
      expectSafe(sample, region.nodes, links, opts.labelObstacles);
      // These endpoints and their local corridors are unrelated to opening c.
      expect(sample.deferred, `progress=${progress}; old=${previousRoutes[0]!.d}; target=${targetRoutes[0]!.d}`).toEqual([]);
    }
  });

  it("samples sixteen visible relationships among 132 cards without ever calling A*", () => {
    const nodes = Array.from({ length: 16 }, (_, i) => [node(`a${i}`, 20, 40 + i * 160), node(`b${i}`, 500, 40 + i * 160)]).flat();
    nodes.push(...Array.from({ length: 100 }, (_, i) => node(`other${i}`, 900 + i % 10 * 140, 40 + Math.floor(i / 10) * 160)));
    const links = Array.from({ length: 16 }, (_, i) => link(`a${i}`, `b${i}`));
    const targetRoutes = links.map((item, i) => route(item.from, item.to, [{ x: 120, y: 80 + i * 160 }, { x: 497, y: 80 + i * 160 }]));
    const search = vi.spyOn(routing, "routeDependencyLinks");
    const plan = planAnimatedDependencyRoutes({ links, previousRoutes: targetRoutes, previousNodes: nodes, targetRoutes, targetNodes: nodes });
    const frame = nodes.map(restingInlineTreeNode), timings: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now(), sample = sampleAnimatedDependencyRoutes(plan, { frameNodes: frame, progress: i / 29, edgeSeparation: 8 });
      timings.push(performance.now() - start);
      expect(sample.routes).toHaveLength(16); expect(sample.deferred).toEqual([]);
    }
    expect(search).not.toHaveBeenCalled(); search.mockRestore();
    timings.sort((a, b) => a - b);
    console.info(`132-card/16 cached dependency sample p95=${timings[28]!.toFixed(2)} ms`);
    expect(timings[28]!).toBeLessThan(20);
  });
});
