import { afterEach, describe, expect, it, vi } from "vitest";
import * as routes from "./animated-dependency-routes.ts";
import { advanceAnimatedDependencyRouteFrame, type AnimatedDependencyFrameInput } from "./use-animated-dependency-routes.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import { restingInlineTreeNode } from "./inline-tree-transition.ts";

const node = (id: string, x: number, y: number): InlineTreeNode => ({ id, parentId: null, depth: 0, x, y, width: 80, height: 60, childCount: 0, expanded: false });
const link = { id: "a>b", from: "a", to: "b", inherited: false };
function routeAt(mid: number, offset = { x: 0, y: 0 }) {
  const points = [{ x: 90, y: 130 }, { x: mid, y: 130 }, { x: mid, y: 230 }, { x: 307, y: 230 }].map(point => ({ x: point.x + offset.x, y: point.y + offset.y }));
  return { ...link, points, d: points.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" ") };
}
function fixture(): AnimatedDependencyFrameInput {
  const targetNodes = [node("a", 10, 100), node("b", 310, 200), node("c", 450, 350)];
  return { workspaceKey: "workspace-a", layoutSignature: "layout-1", frame: { layoutSignature: "layout-1", transitionId: 1, progress: 1, originOffset: { x: 0, y: 0 } },
    targetNodes, links: [link], targetRoutes: [routeAt(160)], sample: { frameNodes: targetNodes.map(restingInlineTreeNode), bounds: { left: 0, right: 600, top: 0, bottom: 500 } } };
}
const clock = (input: AnimatedDependencyFrameInput, progress: number, transitionId = input.frame.transitionId): AnimatedDependencyFrameInput => ({ ...input, frame: { ...input.frame, progress, transitionId } });
const lane = (state: ReturnType<typeof advanceAnimatedDependencyRouteFrame>) => state.snapshot.routes[0]!.points[1]!.x;

afterEach(() => vi.restoreAllMocks());

describe("dependency routes on the committed node clock", () => {
  it("does not plan or sample again for 132 camera renders of the same effective frame", () => {
    const plan = vi.spyOn(routes, "planAnimatedDependencyRoutes"), sample = vi.spyOn(routes, "sampleAnimatedDependencyRoutes");
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    expect(first.snapshot.routes).toHaveLength(1);
    let current = first;
    for (let i = 0; i < 132; i++) current = advanceAnimatedDependencyRouteFrame({ ...input,
      frame: { ...input.frame, originOffset: { ...input.frame.originOffset } },
      sample: { ...input.sample, frameNodes: [...input.sample.frameNodes], bounds: { ...input.sample.bounds! } } }, current);
    expect(current).toBe(first);
    expect(current.snapshot).toBe(first.snapshot);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("keeps the snapshot when equivalent target arrays are recreated, then observes changed route semantics", () => {
    const sample = vi.spyOn(routes, "sampleAnimatedDependencyRoutes"), input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const equivalent = { ...input, links: input.links.map(item => ({ ...item })), targetNodes: input.targetNodes.map(item => ({ ...item })),
      targetRoutes: input.targetRoutes.map(item => ({ ...item, points: item.points.map(point => ({ ...point })) })) };
    const same = advanceAnimatedDependencyRouteFrame(equivalent, first);
    expect(same.snapshot).toBe(first.snapshot);
    expect(same.plan).toBe(first.plan);
    expect(sample).toHaveBeenCalledTimes(1);
    const inherited = advanceAnimatedDependencyRouteFrame({ ...equivalent, links: [{ ...link, inherited: true }] }, same);
    expect(inherited.snapshot.routes[0]!.inherited).toBe(true);
    expect(inherited.snapshot).not.toBe(same.snapshot);
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it("rebases a genuine same-epoch replan on displayed geometry and only the remaining progress", () => {
    const input = fixture(), settled = advanceAnimatedDependencyRouteFrame(input);
    const movingInput = { ...clock(input, 0, 2), targetRoutes: [routeAt(240)] };
    const start = advanceAnimatedDependencyRouteFrame(movingInput, settled);
    expect(lane(start)).toBe(160);
    const middle = advanceAnimatedDependencyRouteFrame(clock(movingInput, .4), start);
    expect(lane(middle)).toBeCloseTo(192);
    const replannedInput = { ...clock(movingInput, .4), targetRoutes: [routeAt(280)] };
    const replanned = advanceAnimatedDependencyRouteFrame(replannedInput, middle);
    expect(lane(replanned)).toBeCloseTo(lane(middle));
    expect(replanned.progressOrigin).toBe(.4);
    const later = advanceAnimatedDependencyRouteFrame(clock(replannedInput, .7), replanned);
    expect(lane(later)).toBeCloseTo(236);
    const done = advanceAnimatedDependencyRouteFrame(clock(replannedInput, 1), later);
    expect(lane(done)).toBe(280);
    expect(done.snapshot.routes[0]!.opacity).toBe(1);
    expect(advanceAnimatedDependencyRouteFrame(clock(replannedInput, 1), done)).toBe(done);
  });

  it("reverses from the actual displayed lane instead of either cached endpoint", () => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input), forward = { ...clock(input, .6, 2), targetRoutes: [routeAt(260)] };
    const middle = advanceAnimatedDependencyRouteFrame(forward, first);
    expect(lane(middle)).toBe(220);
    const reverse = clock(input, 0, 3), restart = advanceAnimatedDependencyRouteFrame(reverse, middle);
    expect(lane(restart)).toBe(lane(middle));
    expect(lane(advanceAnimatedDependencyRouteFrame(clock(reverse, .5), restart))).toBe(190);
    expect(lane(advanceAnimatedDependencyRouteFrame(clock(reverse, 1), restart))).toBe(160);
  });

  it("applies a new epoch world-origin correction once, including after a same-epoch replan", () => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input), offset = { x: 30, y: 40 };
    const targetNodes = input.targetNodes.map(item => ({ ...item, x: item.x + offset.x, y: item.y + offset.y }));
    const shifted: AnimatedDependencyFrameInput = { ...clock(input, 0, 2), targetNodes, targetRoutes: [routeAt(240, offset)],
      frame: { ...clock(input, 0, 2).frame, originOffset: offset }, sample: { ...input.sample, frameNodes: targetNodes.map(restingInlineTreeNode) } };
    const start = advanceAnimatedDependencyRouteFrame(shifted, first);
    expect(start.snapshot.routes[0]!.points).toEqual(first.snapshot.routes[0]!.points.map(point => ({ x: point.x + offset.x, y: point.y + offset.y })));
    const middle = advanceAnimatedDependencyRouteFrame(clock(shifted, .5), start);
    expect(lane(middle)).toBe(230);
    const replan = { ...clock(shifted, .5), targetRoutes: [routeAt(280, offset)] };
    expect(lane(advanceAnimatedDependencyRouteFrame(replan, middle))).toBe(230);
    expect(lane(advanceAnimatedDependencyRouteFrame(clock(replan, 1), middle))).toBe(310);
  });

  it("retains displayed geometry through a signature mismatch and resumes from it once the clock matches", () => {
    const sample = vi.spyOn(routes, "sampleAnimatedDependencyRoutes"), input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const pending = { ...input, layoutSignature: "layout-2", targetRoutes: [routeAt(280)] };
    const held = advanceAnimatedDependencyRouteFrame(pending, first);
    expect(held.snapshot).toBe(first.snapshot);
    expect(held.displayedNodes).toBe(first.displayedNodes);
    expect(held.waitingForFrame).toBe(true);
    expect(sample).toHaveBeenCalledTimes(1);
    const matching = { ...pending, frame: { ...pending.frame, layoutSignature: "layout-2", progress: .4 } };
    const resumed = advanceAnimatedDependencyRouteFrame(matching, held);
    expect(lane(resumed)).toBe(160);
    expect(resumed.progressOrigin).toBe(.4);
    expect(resumed.waitingForFrame).toBe(false);
    expect(lane(advanceAnimatedDependencyRouteFrame(clock(matching, .7), resumed))).toBeCloseTo(220);
    expect(lane(advanceAnimatedDependencyRouteFrame(clock(matching, 1), resumed))).toBe(280);
  });

  it.each(["removed-link", "retargeted-link", "removed-target", "missing-frame-node", "ghost-only", "hidden-endpoint"])("drops %s immediately even while the frame signature is stale", kind => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const pending: AnimatedDependencyFrameInput = { ...input, layoutSignature: "layout-2",
      links: kind === "removed-link" ? [] : kind === "retargeted-link" ? [{ ...link, to: "c" }] : input.links,
      targetNodes: kind === "removed-target" ? input.targetNodes.filter(item => item.id !== "b") : input.targetNodes,
      sample: { ...input.sample, frameNodes: kind === "missing-frame-node" ? input.sample.frameNodes.filter(item => item.id !== "b")
        : input.sample.frameNodes.map(item => item.id !== "b" ? item : { ...item, ghost: kind === "ghost-only", opacity: kind === "hidden-endpoint" ? 0 : item.opacity }) } };
    const held = advanceAnimatedDependencyRouteFrame(pending, first);
    expect(held.snapshot).toEqual({ routes: [], deferred: [] });
    expect(held.waitingForFrame).toBe(true);
    expect(advanceAnimatedDependencyRouteFrame(pending, held)).toBe(held);
    // Filtering does not mutate the last committed snapshot supplied by the caller.
    expect(first.snapshot.routes).toHaveLength(1);
  });

  it("does not expose another workspace's routes or deferred relations while waiting for its first matching frame", () => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const next = { ...input, workspaceKey: "workspace-b", layoutSignature: "layout-2", targetRoutes: [routeAt(280)] };
    const pending = advanceAnimatedDependencyRouteFrame(next, first);
    expect(pending.snapshot).toEqual({ routes: [], deferred: [] });
    expect(pending.displayedNodes).toEqual([]);
    const ready = { ...next, frame: { ...next.frame, layoutSignature: "layout-2", progress: 1 } };
    expect(lane(advanceAnimatedDependencyRouteFrame(ready, pending))).toBe(280);
    expect(advanceAnimatedDependencyRouteFrame({ ...ready, workspaceKey: "workspace-c", targetRoutes: [] }, first).snapshot.routes).toEqual([]);
  });

  it("also filters stale deferred relationships and refreshes current inheritance while geometry is held", () => {
    const input = fixture(), blockedInput = { ...input, sample: { ...input.sample,
      labelObstacles: [{ id: "caption", left: 95, right: 300, top: 125, bottom: 235 }] } };
    const blocked = advanceAnimatedDependencyRouteFrame(blockedInput);
    expect(blocked.snapshot.deferred).toEqual([{ ...link, reason: "no-safe-candidate" }]);
    const pending = { ...blockedInput, layoutSignature: "layout-2", links: [{ ...link, inherited: true }] };
    const held = advanceAnimatedDependencyRouteFrame(pending, blocked);
    expect(held.snapshot.deferred).toEqual([{ ...link, inherited: true, reason: "no-safe-candidate" }]);
    expect(advanceAnimatedDependencyRouteFrame({ ...pending, links: [{ ...link, to: "c" }] }, held).snapshot).toEqual({ routes: [], deferred: [] });
  });

  it("resamples changing title obstacles at the same progress without repeatedly advancing or rebasing the lane", () => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input), moving = { ...clock(input, .4, 2), targetRoutes: [routeAt(240)] };
    const middle = advanceAnimatedDependencyRouteFrame(moving, first);
    expect(lane(middle)).toBe(192);
    const blocked = advanceAnimatedDependencyRouteFrame({ ...moving, sample: { ...moving.sample,
      labelObstacles: [{ id: "moving-title", left: 95, right: 300, top: 125, bottom: 235 }] } }, middle);
    expect(blocked.plan).toBe(middle.plan);
    expect(blocked.progressOrigin).toBe(0);
    expect(blocked.snapshot.routes).toEqual([]);
    expect(blocked.snapshot.deferred[0]!.reason).toBe("no-safe-candidate");
    const restored = advanceAnimatedDependencyRouteFrame(moving, blocked);
    expect(restored.plan).toBe(middle.plan);
    expect(lane(restored)).toBe(192);
    expect(lane(advanceAnimatedDependencyRouteFrame(clock(moving, .7), restored))).toBe(216);
  });

  it("samples actual card movement and opacity at unchanged clock values without reusing stale frame geometry", () => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const frameNodes = input.sample.frameNodes.map(item => item.id === "b" ? { ...item, y: item.y + 20, opacity: .4 } : item);
    const moved = advanceAnimatedDependencyRouteFrame({ ...input, sample: { ...input.sample, frameNodes } }, first);
    expect(moved.plan).toBe(first.plan);
    expect(moved.snapshot.routes[0]!.points.at(-1)).toEqual({ x: 307, y: 250 });
    expect(moved.snapshot.routes[0]!.opacity).toBe(.4);
    const ghost = { ...restingInlineTreeNode(node("moving-ghost", 140, 140)), ghost: true, opacity: .5 };
    const obscured = advanceAnimatedDependencyRouteFrame({ ...input, sample: { ...input.sample, frameNodes: [...frameNodes, ghost] } }, moved);
    expect(obscured.snapshot.routes).toEqual([]);
    expect(obscured.snapshot.deferred[0]!.reason).toBe("no-safe-candidate");
  });

  it("only continues explicitly authorized existing exits and never creates a retained-only relationship", () => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const exit = { ...clock(input, .2, 2), links: [], targetNodes: input.targetNodes.slice(0, 1), targetRoutes: [], retainedLinks: [link] };
    const exiting = advanceAnimatedDependencyRouteFrame(exit, first);
    expect(exiting.snapshot.routes[0]!.d).toBe(first.snapshot.routes[0]!.d);
    expect(advanceAnimatedDependencyRouteFrame(exit).snapshot).toEqual({ routes: [], deferred: [] });
    expect(advanceAnimatedDependencyRouteFrame({ ...exit, retainedLinks: [link, { ...link, id: "new-copy" }] }, first).snapshot.routes.map(item => item.id)).toEqual([link.id]);
    expect(advanceAnimatedDependencyRouteFrame({ ...exit, retainedLinks: [] }, exiting).snapshot).toEqual({ routes: [], deferred: [] });
  });

  it.each(["workspace-or-scope", "revoked", "retargeted", "removed-frame-node", "ghost-only", "hidden-endpoint"])("does not continue an authorized exit after %s, including during mismatch", kind => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const base: AnimatedDependencyFrameInput = { ...clock(input, .2, 2), targetNodes: input.targetNodes.slice(0, 1), targetRoutes: [], links: [], retainedLinks: [link] };
    const exiting = advanceAnimatedDependencyRouteFrame(base, first);
    for (const mismatch of [false, true]) {
      const changed: AnimatedDependencyFrameInput = { ...base,
        workspaceKey: kind === "workspace-or-scope" ? "another-scope" : base.workspaceKey,
        layoutSignature: mismatch ? "waiting-layout" : base.layoutSignature,
        retainedLinks: kind === "revoked" ? [] : kind === "retargeted" ? [{ ...link, to: "c" }] : base.retainedLinks,
        sample: { ...base.sample, frameNodes: kind === "removed-frame-node" ? base.sample.frameNodes.filter(item => item.id !== "b")
          : base.sample.frameNodes.map(item => item.id !== "b" ? item : { ...item, ghost: kind === "ghost-only", opacity: kind === "hidden-endpoint" ? 0 : item.opacity }) } };
      expect(advanceAnimatedDependencyRouteFrame(changed, exiting).snapshot).toEqual({ routes: [], deferred: [] });
    }
    // A currently retargeted ID overrides the exit allowance even if the caller
    // supplies stale retained metadata alongside it.
    const retarget = advanceAnimatedDependencyRouteFrame({ ...base, links: [{ ...link, to: "c" }] }, exiting);
    expect(retarget.snapshot.routes).toEqual([]);
    expect(retarget.snapshot.deferred).toEqual([{ ...link, to: "c", reason: "no-safe-candidate" }]);
  });

  it("reverses an exiting route from its displayed geometry and opacity on the same node clock", () => {
    const input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const exit: AnimatedDependencyFrameInput = { ...clock(input, .4, 2), targetNodes: input.targetNodes.slice(0, 1), links: [], retainedLinks: [link], targetRoutes: [],
      sample: { ...input.sample, frameNodes: input.sample.frameNodes.map(item => item.id === "b" ? { ...item, y: item.y - 4, opacity: .4, exiting: true } : item) } };
    const middle = advanceAnimatedDependencyRouteFrame(exit, first);
    expect(middle.snapshot.routes[0]!.points.at(-1)!.y).toBe(226);
    const reverse = { ...clock(input, 0, 3), sample: exit.sample };
    const resumed = advanceAnimatedDependencyRouteFrame(reverse, middle);
    expect(resumed.snapshot.routes).toEqual(middle.snapshot.routes);
    const done = advanceAnimatedDependencyRouteFrame(clock(input, 1, 3), resumed);
    expect(done.snapshot.routes[0]!.points.at(-1)!.y).toBe(230);
    expect(done.snapshot.routes[0]!.opacity).toBe(1);
  });

  it("invalidates safety sampling when bounds, boundaries, reservations, clearance, separation or arrow size change", () => {
    const sample = vi.spyOn(routes, "sampleAnimatedDependencyRoutes"), input = fixture(), first = advanceAnimatedDependencyRouteFrame(input);
    const variations: AnimatedDependencyFrameInput["sample"][] = [
      { ...input.sample, bounds: { ...input.sample.bounds!, right: 500 } },
      { ...input.sample, boundaries: [{ id: "zone", left: 500, right: 550, top: 10, bottom: 30 }] },
      { ...input.sample, reservedSegments: [{ id: "branch", a: { x: 500, y: 10 }, b: { x: 550, y: 10 } }] },
      { ...input.sample, boundaryClearance: 4 }, { ...input.sample, edgeSeparation: 5 }, { ...input.sample, arrowSize: 9 }
    ];
    for (const options of variations) {
      const next = advanceAnimatedDependencyRouteFrame({ ...input, sample: options }, first);
      expect(next.snapshot).not.toBe(first.snapshot);
      expect(next.plan).toBe(first.plan);
    }
    expect(sample).toHaveBeenCalledTimes(variations.length + 1);
  });
});
