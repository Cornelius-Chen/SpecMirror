import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EngineeringNodeSchema, deriveEngineeringView } from "@epm/domain";
import { dependencySegmentCrossesRect } from "../engineering/dependency-routing.ts";
import { animatedComposition, type AnimatedComposition } from "./animated-composition.ts";
import { boundedBranchGroups, boundedTreeLayout, type BoundedCompositionRoutingOptions } from "./bounded-tree-layout.ts";
import * as boundedRouting from "./bounded-tree-layout.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import { planInlineTreeTransition, restingInlineTreeNode, type AnimatedInlineTreeNode, type InlineTreeTransitionPlan } from "./inline-tree-transition.ts";

const options: BoundedCompositionRoutingOptions = { wrappedRootSideEntry: true, alignedLaneSide: "left" };
const position = (id: string, x: number, y: number, parentId: string | null = "root", depth = parentId ? 1 : 0): InlineTreeNode => ({ id, parentId, x, y, width: 208, height: 120, depth, childCount: 0, expanded: false });
const frameAt = (plan: InlineTreeTransitionPlan, progress: number) => {
  const ease = progress * progress * (3 - 2 * progress);
  return plan.from.map((node, i) => ({ ...node, x: node.x + (plan.to[i]!.x - node.x) * ease, y: node.y + (plan.to[i]!.y - node.y) * ease, opacity: node.opacity + (plan.to[i]!.opacity - node.opacity) * ease }));
};
const stages = [0, .125, .25, .375, .5, .625, .75, .875, 1];
const boundaryDistance = (point: { x: number; y: number }, node: InlineTreeNode) => {
  const outside = Math.hypot(Math.max(node.x - point.x, 0, point.x - node.x - node.width), Math.max(node.y - point.y, 0, point.y - node.y - node.height));
  return outside || Math.min(Math.abs(point.x - node.x), Math.abs(point.x - node.x - node.width), Math.abs(point.y - node.y), Math.abs(point.y - node.y - node.height));
};

function expectSafe(result: AnimatedComposition, nodes: readonly AnimatedInlineTreeNode[], width: number) {
  const visible = nodes.filter(node => node.opacity > 0), real = visible.filter(node => !node.ghost), byId = new Map(real.map(node => [node.id, node]));
  const cards = visible.map((node, i) => ({ id: `${node.id}:${i}`, left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + node.height }));
  const captions = boundedBranchGroups(real, width).map(group => ({ id: `caption:${group.id}`, left: group.x + 20, right: group.x + group.width - 20, top: group.y - 11, bottom: group.y + 11 }));
  expect(new Set(result.edges.map(edge => edge.id)).size).toBe(result.edges.length);
  for (const edge of result.edges) {
    const source = byId.get(edge.from)!, target = byId.get(edge.to)!;
    expect(source).toBeDefined(); expect(target).toBeDefined();
    expect(target.parentId).toBe(source.id);
    expect(boundaryDistance(edge.points[0]!, source)).toBeLessThan(.001);
    expect(boundaryDistance(edge.points.at(-1)!, target)).toBeLessThan(.001);
    expect(edge.opacity).toBe(Math.min(1, source.opacity, target.opacity));
    for (let i = 1; i < edge.points.length; i++) for (const obstacle of [...cards, ...captions]) {
      expect(dependencySegmentCrossesRect(edge.points[i - 1]!, edge.points[i]!, obstacle), `${edge.id} crosses ${obstacle.id}`).toBe(false);
    }
  }
  for (const segment of result.segments) {
    expect(segment.opacity).toBe(Math.max(...segment.edgeIds.map(id => result.edges.find(edge => edge.id === id)!.opacity)));
    // The existing shared-segment layer snaps rails to a tenth of a world pixel.
    for (const obstacle of [...cards, ...captions]) expect(dependencySegmentCrossesRect(segment.a, segment.b, { ...obstacle, left: obstacle.left + .1, right: obstacle.right - .1, top: obstacle.top + .1, bottom: obstacle.bottom - .1 }), `${segment.id} crosses ${obstacle.id}`).toBe(false);
  }
  const represented = new Set([...result.edges.map(edge => edge.id), ...result.suppressedEdgeIds]);
  expect([...represented].sort()).toEqual(real.flatMap(node => node.parentId && byId.has(node.parentId) ? [`${node.parentId}>${node.id}`] : []).sort());
}

function viewWithLargeBranch(largeCount = 2) {
  const stamp = "2026-09-13T00:00:00Z";
  const make = (id: string, parent_id: string | null, order = 0) => EngineeringNodeSchema.parse({ id, parent_id, title: id, kind: parent_id ? "task" : "project", objective: "fixture", owner: "未分配", order, revision: 1, status: "draft", constraints: {}, created_at: stamp, updated_at: stamp });
  const nodes = [make("root", null), ...["a", "b", "c", "d", "large"].map((id, i) => make(id, "root", i)), make("task", "a"), make("component", "task"), make("leaf", "component"), make("other", "b"), make("check", "c"), make("deliver", "c", 1), ...Array.from({ length: largeCount }, (_, i) => make(`item-${i}`, "large", i))];
  return deriveEngineeringView({ schema_version: 1, id: "animated-composition", root_id: "root", revision: 1, nodes, runs: [], events: [], changes: [], capability_uses: [], created_at: stamp, updated_at: stamp });
}

describe("animated parent-child composition", () => {
  it("retains the settled reference while rebuilding currently visible exits and excluding ghosts", () => {
    const view = viewWithLargeBranch(), closed = boundedTreeLayout(view, ["root"], 800), opened = boundedTreeLayout(view, ["root", "c"], 800);
    const route = vi.spyOn(boundedRouting, "boundedCompositionEdges");
    try {
      const ghost = { ...restingInlineTreeNode(opened.nodes.find(node => node.id === "check")!), ghost: true };
      animatedComposition([...closed.nodes.map(restingInlineTreeNode), ghost], closed.nodes, 800, options);
      expect(route.mock.calls.at(-1)![2]).toBe(closed.nodes);
      const closing = planInlineTreeTransition(opened.nodes.map(restingInlineTreeNode), closed.nodes, "c");
      const frame = frameAt(closing, .375), firstExit = frame.find(node => node.id === "check")!;
      animatedComposition(frame, closed.nodes, 800, options);
      const reference = route.mock.calls.at(-1)![2]!;
      expect(reference).not.toBe(closed.nodes);
      expect(reference.find(node => node.id === "check")).toBe(firstExit);
      const next = frame.map(node => node.id === "check" ? { ...node, x: node.x + 13, y: node.y + 37 } : node);
      animatedComposition(next, closed.nodes, 800, options);
      const changed = route.mock.calls.at(-1)![2]!;
      expect(changed).not.toBe(reference);
      expect(changed.find(node => node.id === "check")).toMatchObject({ x: firstExit.x + 13, y: firstExit.y + 37 });
      animatedComposition(frameAt(closing, 1), closed.nodes, 800, options);
      expect(route.mock.calls.at(-1)![2]).toBe(closed.nodes);
      expect(route).toHaveBeenCalledTimes(4);
    } finally { route.mockRestore(); }
  });
  it("preserves complete pre-optimization frame outputs at three widths", () => {
    const recorded = [350, 800, 1250].map(width => {
      const view = viewWithLargeBranch(120), expanded = ["root", "a", "task", "component", "b", "c"];
      const closed = boundedTreeLayout(view, expanded, width), opened = boundedTreeLayout(view, [...expanded, "large"], width);
      const opening = planInlineTreeTransition(closed.nodes.map(restingInlineTreeNode), opened.nodes, "large");
      const closing = planInlineTreeTransition(opened.nodes.map(restingInlineTreeNode), closed.nodes, "large");
      const reversed = planInlineTreeTransition(frameAt(closing, .375), opened.nodes, "large");
      // The digest locks every coordinate, edge/segment ID, opacity and deferred
      // identity from the accepted router, without duplicating its implementation.
      const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const outputs = (plan: InlineTreeTransitionPlan, target: InlineTreeNode[]) => stages.map(progress => {
        const frame = frameAt(plan, progress);
        return animatedComposition(frame, target, width, { ...options, groups: boundedBranchGroups(frame.filter(node => node.opacity > 0 && !node.ghost), width) });
      });
      const frame = frameAt(opening, .625), a = frame.find(node => node.id === "a")!;
      const ghost = { ...a, x: a.x + a.width + 15, y: a.y + a.height + 15, id: "old-a", ghost: true, opacity: .4 };
      return { width,
        opening: digest(outputs(opening, opened.nodes)),
        closing: digest(outputs(closing, closed.nodes)),
        reversed: digest(outputs(reversed, opened.nodes)),
        ghostAndLabel: digest(animatedComposition([...frame, ghost], opened.nodes, width, { ...options, labelObstacles: [{ left: a.x + 10, right: a.x + a.width - 10, top: a.y - 24, bottom: a.y - 3 }] }))
      };
    });
    expect(recorded).toMatchInlineSnapshot(`
      [
        {
          "closing": "288f3ec8b2ed4160e1b83b23bbbfe14b5095121d2ada379149868d64bdfbdaa9",
          "ghostAndLabel": "f05fc3d877befdbe7fcbd18a26a155a55f5bcd05d1a1630ec382f2ca3288c8f5",
          "opening": "498f6665e97d0435a53b03f68f7365bb89381801550b8f3490bbce8a1e947aaa",
          "reversed": "3419bcc08039b52c8487b15ab4cb74a2b11708e82e0088f135ebeb99c1c2d97a",
          "width": 350,
        },
        {
          "closing": "539e68af329947345b090a089760d8cd0bc80f91d7aa270d6630006631d5181a",
          "ghostAndLabel": "d09a223ae19fe0f0105c3894332114d0f6980ab4c272a4693937bfa4723d2991",
          "opening": "c4fb6de7be416cbc1150ea6888e5ef9512d04f82af44144bad765b8a7fd03d52",
          "reversed": "dfc08b3128b941efe56bfe47577dff1d02a3e8fb534f49a1f94c8f1a552fd9a1",
          "width": 800,
        },
        {
          "closing": "b25bbc4329f379d9a8de7d193565f83385e7bce7f52dd57cce359fb1326fb446",
          "ghostAndLabel": "fc364281ae833f1c0039ed549b39a2f6ac1136f3c30af10388f6f552762bae2f",
          "opening": "c7bb81e790bad49cae566357b0f0b6800de69c2c3b55ad92a92d8b14f3136e38",
          "reversed": "1bd80dd003946ed2971269c720fdc4e0d187fc86994bac72b05da3b0eee0753e",
          "width": 1250,
        },
      ]
    `);
  });
  it.each([350, 800, 1250])("keeps safe frame-attached relationships during opening, closing, and reversal at %i px", width => {
    const view = viewWithLargeBranch(), closed = boundedTreeLayout(view, ["root"], width), opened = boundedTreeLayout(view, ["root", "c"], width);
    const opening = planInlineTreeTransition(closed.nodes.map(restingInlineTreeNode), opened.nodes, "c");
    for (const progress of stages) {
      const frame = frameAt(opening, progress), result = animatedComposition(frame, opened.nodes, width, options);
      expectSafe(result, frame, width);
      // An unrelated, first-row branch must never disappear with the opening one.
      expect(result.edges.some(edge => edge.id === "root>a")).toBe(true);
    }
    const closing = planInlineTreeTransition(opened.nodes.map(restingInlineTreeNode), closed.nodes, "c");
    const halfClosed = frameAt(closing, .375);
    const exits = animatedComposition(halfClosed, closed.nodes, width, options);
    expect(exits.edges.some(edge => edge.id === "c>check" && edge.opacity > 0 && edge.opacity < 1)).toBe(true);
    for (const progress of stages) {
      const frame = frameAt(closing, progress);
      expectSafe(animatedComposition(frame, closed.nodes, width, options), frame, width);
    }
    const reversed = planInlineTreeTransition(halfClosed, opened.nodes, "c");
    for (const progress of stages) {
      const frame = frameAt(reversed, progress);
      expectSafe(animatedComposition(frame, opened.nodes, width, options), frame, width);
    }
    expect(animatedComposition(frameAt(closing, 1), closed.nodes, width, options).edges.some(edge => edge.id.startsWith("c>"))).toBe(false);
  });

  it("uses ghosts only as obstacles and suppresses only relationships without a safe route", () => {
    const nodes = [position("root", 300, 0, null), position("a", 100, 200), position("b", 600, 200)];
    const ghost: AnimatedInlineTreeNode = { ...restingInlineTreeNode(position("a", 0, 140)), width: 500, height: 50, ghost: true, exiting: true, motionRole: "crossfade-out", opacity: .5 };
    const frame = [...nodes.map(restingInlineTreeNode), ghost];
    const result = animatedComposition(frame, nodes, 900, options);
    expectSafe(result, frame, 900);
    expect(result.suppressedEdgeIds).toEqual(["root>a"]);
    expect(result.edges.map(edge => edge.id)).toEqual(["root>b"]);
    const afterGhost = animatedComposition([...frame.slice(0, -1), { ...ghost, opacity: 0 }], nodes, 900, options);
    expect(afterGhost.edges.map(edge => edge.id)).toEqual(["root>a", "root>b"]);
  });

  it("reports a coinciding child without drawing through its parent", () => {
    const nodes = [position("root", 100, 28, null), position("child", 100, 28)].map(restingInlineTreeNode);
    const result = animatedComposition(nodes, nodes, 500, options);
    expect(result.edges).toEqual([]); expect(result.segments).toEqual([]); expect(result.suppressedEdgeIds).toEqual(["root>child"]);
  });

  it("preserves an unaffected relationship's topology and segment identity across a local reveal", () => {
    const old = [position("root", 100, 0, null), position("a", 100, 176), position("b", 500, 176)];
    const target = [...old, position("child", 100, 352, "a", 2)];
    const plan = planInlineTreeTransition(old.map(restingInlineTreeNode), target, "a");
    const tracks = stages.map(progress => animatedComposition(frameAt(plan, progress), target, 900, options));
    const edge = tracks[0]!.edges.find(item => item.id === "root>b")!;
    for (const frame of tracks) expect(frame.edges.find(item => item.id === edge.id)).toEqual(edge);
    const ids = (frame: AnimatedComposition) => frame.segments.filter(segment => segment.edgeIds.includes(edge.id)).map(segment => segment.id);
    for (const frame of tracks) expect(ids(frame)).toEqual(ids(tracks[0]!));
  });

  it("retains shared-trunk opacity while an individual child fades", () => {
    const nodes = [position("root", 300, 28, null), position("a", 100, 204), position("b", 600, 204)].map(restingInlineTreeNode);
    nodes[1]!.opacity = .25;
    const result = animatedComposition(nodes, nodes, 900, options);
    expectSafe(result, nodes, 900);
    const shared = result.segments.filter(segment => segment.edgeIds.length > 1);
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every(segment => segment.opacity === 1)).toBe(true);
    expect(result.segments.filter(segment => segment.edgeIds.length === 1 && segment.edgeIds[0] === "root>a").every(segment => segment.opacity === .25)).toBe(true);
  });

  it.each([350, 800, 1250])("measures 132-node frame routing without losing settled relationships at %i px", width => {
    const view = viewWithLargeBranch(120), expanded = ["root", "a", "task", "component", "b", "c"];
    const before = boundedTreeLayout(view, expanded, width), after = boundedTreeLayout(view, [...expanded, "large"], width);
    expect(after.nodes).toHaveLength(132);
    const plan = planInlineTreeTransition(before.nodes.map(restingInlineTreeNode), after.nodes, "large");
    const frames = Array.from({ length: 24 }, (_, i) => frameAt(plan, (i + 1) / 24));
    animatedComposition(frames[0]!, after.nodes, width, options);
    const elapsed = frames.map(frame => { const start = performance.now(); animatedComposition(frame, after.nodes, width, options); return performance.now() - start; }).sort((a, b) => a - b);
    const p95 = elapsed[Math.floor(elapsed.length * .95)]!;
    console.info(`132-node composition routing (${width}px): p50=${elapsed[Math.floor(elapsed.length / 2)]!.toFixed(2)} ms, p95=${p95.toFixed(2)} ms, max=${elapsed.at(-1)!.toFixed(2)} ms`);
    // Detect a material CPU regression without treating one machine's timing as
    // proof of browser frame rate. The integration measures rendered RAF gaps.
    expect(p95).toBeLessThan(50);
    expectSafe(animatedComposition(frames[11]!, after.nodes, width, options), frames[11]!, width);
    const final = animatedComposition(after.nodes.map(restingInlineTreeNode), after.nodes, width, options);
    expect(final.edges).toHaveLength(131); expect(final.suppressedEdgeIds).toEqual([]);
    expectSafe(final, after.nodes.map(restingInlineTreeNode), width);
  });
});
