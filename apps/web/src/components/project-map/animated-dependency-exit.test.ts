import { describe, expect, it } from "vitest";
import { dependencyReadabilityPenalty, dependencySegmentCrossesRect, type DependencyRoute } from "../engineering/dependency-routing.ts";
import { allocationFixture } from "./animated-dependency-allocation.fixture.ts";
import { planAnimatedDependencyRoutes, sampleAnimatedDependencyRoutes } from "./animated-dependency-routes.ts";
import { restingInlineTreeNode } from "./inline-tree-transition.ts";
import { advanceAnimatedDependencyRouteFrame, type AnimatedDependencyFrameInput } from "./use-animated-dependency-routes.ts";

// Compact anonymous replay of the visible closing windows in the saved
// closing-geometry.json / closing-again-geometry.json (44.9 / 92.9 ms). No live
// document or machine-local artifact is read at test runtime. Their cards were
// real exits, not ghosts; both windows had all five paths missing at once.
const capturedFrames = [
  { p: 0, opacity: 1, dy: 0, shrink: 0 },
  { p: .004432534188657212, opacity: .934398, dy: -.04432534188657212, shrink: .703125 },
  { p: .008824500656072314, opacity: .869397, dy: -.08824500656072314, shrink: 1.40625 },
  { p: .014532409574482718, opacity: .78492, dy: -.14532409574482718, shrink: 2.296875 },
  { p: .040078104976558004, opacity: .406844, dy: -.40078104976558004, shrink: 6.34375 }
];
function fixture() {
  const { nodes, links, options } = allocationFixture(3);
  // Exact safe routes actually displayed before the second close; these differ
  // from the old failure baseline retained by allocationFixture.
  const points = [
    [[333, 288], [386, 288]],
    [[597, 264], [621, 264], [621, 276], [650, 276]],
    [[787.6666666666666, 324], [787.6666666666666, 522], [485, 522], [485, 424], [468, 424]],
    [[493, 324], [493, 412], [468, 412]],
    [[465, 464], [518, 464]]
  ];
  const targetRoutes: DependencyRoute[] = links.map((link, i) => ({ ...link,
    points: points[i]!.map(([x, y]) => ({ x: x!, y: y! })),
    d: points[i]!.map(([x, y], j) => `${j ? "L" : "M"} ${x} ${y}`).join(" ") }));
  // At .85 actual clearance is 12 world units from boundaries, 10 from lines.
  const sample: AnimatedDependencyFrameInput["sample"] = { ...options, edgeSeparation: 10, arrowSize: 8, frameNodes: nodes.map(restingInlineTreeNode) };
  const input: AnimatedDependencyFrameInput = { workspaceKey: "anonymous-root", layoutSignature: "open", frame: { layoutSignature: "open", transitionId: 1, progress: 1, originOffset: { x: 0, y: 0 } },
    targetNodes: nodes, links, targetRoutes, sample };
  const closing = ({ p, opacity, dy, shrink }: typeof capturedFrames[number]): AnimatedDependencyFrameInput => ({ ...input,
    layoutSignature: "closed", frame: { ...input.frame, layoutSignature: "closed", transitionId: 2, progress: p },
    targetNodes: nodes.slice(0, 1), targetRoutes: [], links: [], retainedLinks: links,
    sample: { ...sample,
      frameNodes: nodes.map(node => ({ ...restingInlineTreeNode(node), y: node.y + (node.id === "root" ? 0 : dy), opacity: node.id === "root" ? 1 : opacity, exiting: node.id !== "root" })),
      boundaries: options.boundaries!.map(rect => ({ ...rect, bottom: rect.bottom - shrink })),
      // Composition's vertical endpoints follow full precision, while its
      // horizontal segment union quantizes to .1 world units, as captured.
      reservedSegments: options.reservedSegments!.map(segment => {
        const horizontal = segment.a.y === segment.b.y;
        const move = (point: typeof segment.a) => ({ ...point, y: point.y >= 264 ? point.y + (horizontal ? Math.round(dy * 10) / 10 : dy) : point.y });
        return { ...segment, a: move(segment.a), b: move(segment.b) };
      })
    } });
  return { input, closing };
}

function expectSafe(input: AnimatedDependencyFrameInput, routes: readonly DependencyRoute[]) {
  const { frameNodes, labelObstacles = [], boundaries = [], reservedSegments = [], boundaryClearance = 0, edgeSeparation = 0 } = input.sample;
  const occupied = [...reservedSegments];
  for (const route of routes) {
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!, b = route.points[i]!;
      for (const card of frameNodes.filter(card => card.opacity > 0)) expect(dependencySegmentCrossesRect(a, b, { id: card.id, left: card.x, right: card.x + card.width, top: card.y, bottom: card.y + card.height })).toBe(false);
      for (const label of labelObstacles) expect(dependencySegmentCrossesRect(a, b, label)).toBe(false);
      expect(dependencyReadabilityPenalty(a, b, boundaries, occupied, boundaryClearance, edgeSeparation).hardConflict).toBe(false);
    }
    occupied.push(...route.points.slice(1).map((b, i) => ({ id: route.id, a: route.points[i]!, b })));
  }
}

describe("captured dependency exit windows", () => {
  it("finds all five cached paths safe in the real visible frames without searching another graph", () => {
    const { input, closing } = fixture();
    const plan = planAnimatedDependencyRoutes({ links: input.links, previousRoutes: input.targetRoutes, previousNodes: input.targetNodes, targetRoutes: [], targetNodes: input.targetNodes.slice(0, 1) });
    for (const captured of capturedFrames) {
      const frame = closing(captured), snapshot = sampleAnimatedDependencyRoutes(plan, { ...frame.sample, progress: captured.p });
      expect(snapshot.deferred, `p=${captured.p}`).toEqual([]);
      expect(snapshot.routes.map(route => route.id)).toEqual(input.links.map(link => link.id));
      expect(snapshot.routes.every(route => route.opacity === captured.opacity)).toBe(true);
      expectSafe(frame, snapshot.routes);
    }
  });

  it("preserves those paths through the target/clock mismatch, fades with the real endpoints and ends cleanly", () => {
    const { input, closing } = fixture();
    let state = advanceAnimatedDependencyRouteFrame(input);
    expect(state.snapshot.routes).toHaveLength(5);
    const pending = { ...closing(capturedFrames[0]!), frame: input.frame };
    state = advanceAnimatedDependencyRouteFrame(pending, state);
    expect(state.snapshot.routes).toHaveLength(5);
    for (const captured of capturedFrames) {
      const frame = closing(captured);
      state = advanceAnimatedDependencyRouteFrame(frame, state);
      expect(state.snapshot.deferred, `p=${captured.p}`).toEqual([]);
      expect(state.snapshot.routes.map(route => route.id)).toEqual(input.links.map(link => link.id));
      expect(state.snapshot.routes.every(route => route.opacity === captured.opacity)).toBe(true);
      expectSafe(frame, state.snapshot.routes);
    }
    const last = closing({ p: .0773201271322349, opacity: 0, dy: -.773201271322349, shrink: 12.21875 });
    state = advanceAnimatedDependencyRouteFrame(last, state);
    expect(state.snapshot).toEqual({ routes: [], deferred: [] });
    const done = { ...last, frame: { ...last.frame, progress: 1 }, sample: { ...last.sample, frameNodes: last.sample.frameNodes.slice(0, 1) } };
    expect(advanceAnimatedDependencyRouteFrame(done, state).snapshot).toEqual({ routes: [], deferred: [] });
  });
});
