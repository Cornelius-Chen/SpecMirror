import { describe, expect, it, vi } from "vitest";
import { EngineeringNodeSchema, deriveEngineeringView } from "@epm/domain";
import { agentZoneRegions, type AgentZoneLayoutSource } from "./agent-zone-layout.ts";
import { advanceAnimatedRegions, planAnimatedRegions, sampleAnimatedRegions, type AnimatedMapRegions, type AnimatedRegionFrameInput } from "./animated-map-regions.ts";
import { boundedTreeLayout, type BoundedTreeLayout } from "./bounded-tree-layout.ts";
import { planInlineTreeTransition, restingInlineTreeNode, type InlineTreeTransitionPlan } from "./inline-tree-transition.ts";

const frameAt = (plan: InlineTreeTransitionPlan, p: number) => plan.from.map((node, i) => ({ ...node,
  x: node.x + (plan.to[i]!.x - node.x) * p, y: node.y + (plan.to[i]!.y - node.y) * p,
  opacity: node.opacity + (plan.to[i]!.opacity - node.opacity) * p }));
const geometry = ({ x, y, width, height, opacity }: { x: number; y: number; width: number; height: number; opacity: number }) => ({ x, y, width, height, opacity });
const contained = (region: { x: number; y: number; width: number; height: number }, card: { x: number; y: number; width: number; height: number }) =>
  card.x >= region.x - .001 && card.y >= region.y - .001 && card.x + card.width <= region.x + region.width + .001 && card.y + card.height <= region.y + region.height + .001;
const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + .001 && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + .001;

function fixture(count = 3) {
  const stamp = "2026-09-13T00:00:00Z";
  const make = (id: string, parent_id: string | null, order = 0) => EngineeringNodeSchema.parse({ id, parent_id, title: id, kind: parent_id ? "task" : "project", objective: "fixture", owner: "未分配", order, revision: 1, status: "draft", constraints: {}, created_at: stamp, updated_at: stamp });
  const nodes = [make("root", null), ...["a", "b", "c", "d", "e"].map((id, i) => make(id, "root", i)), make("stable", "a"), ...Array.from({ length: count }, (_, i) => make(`item-${i}`, "b", i)), make("lower", "d")];
  const view = deriveEngineeringView({ schema_version: 1, id: "animated-regions", root_id: "root", revision: 1, nodes, runs: [], events: [], changes: [], capability_uses: [], created_at: stamp, updated_at: stamp });
  const zones: AgentZoneLayoutSource[] = [
    { id: "zone-a", root_node_id: "a", node_ids: ["a", "stable"] },
    { id: "zone-b", root_node_id: "b", node_ids: ["b", ...Array.from({ length: count }, (_, i) => `item-${i}`)] },
    { id: "zone-d", root_node_id: "d", node_ids: ["d", "lower"] }
  ];
  return { view, zones };
}
function settled(layout: BoundedTreeLayout, zones: readonly AgentZoneLayoutSource[]) {
  return sampleAnimatedRegions(planAnimatedRegions({ targetNodes: layout.nodes, zones, width: layout.width, height: layout.height }), layout.nodes.map(restingInlineTreeNode), 1);
}
function expectSafe(snapshot: AnimatedMapRegions) {
  const visible = snapshot.nodes.filter(node => node.opacity > .00001);
  for (const group of snapshot.groups) {
    for (const node of visible.filter(node => !node.ghost)) {
      if (group.descendantIds.includes(node.id)) expect(contained(group, node), `${group.id} fails to contain ${node.id}`).toBe(true);
      else expect(overlap(group, node), `${group.id} contains stranger ${node.id}`).toBe(false);
    }
  }
  for (const zone of snapshot.zones) for (const node of visible.filter(node => !node.ghost)) {
    if (zone.nodeIds.includes(node.id)) expect(contained(zone, node), `${zone.id} fails to contain ${node.id}`).toBe(true);
    else expect(overlap(zone, node), `${zone.id} contains stranger ${node.id}`).toBe(false);
  }
  for (const label of snapshot.labels.filter(label => label.opacity > .00001)) {
    const box = { x: label.left, y: label.top, width: label.right - label.left, height: label.bottom - label.top };
    for (const node of visible) expect(overlap(box, node), `${label.kind}:${label.id} covers ${node.id}`).toBe(false);
    if (label.kind === "branch") {
      const group = snapshot.groups.find(group => group.id === label.id)!;
      expect(group.opacity * group.labelOpacity).toBeCloseTo(label.opacity);
    } else expect(snapshot.zones.find(zone => zone.id === label.id)!.labelOpacity).toBe(label.opacity);
  }
}

describe("shared-clock region presentation", () => {
  it.each([350, 800, 1250])("opens and closes real branch bounds without consuming the moving lower row at %i px", width => {
    const { view, zones } = fixture(24);
    const before = boundedTreeLayout(view, ["root", "a", "d"], width);
    const after = boundedTreeLayout(view, ["root", "a", "b", "d"], width, before.columns);
    const initial = settled(before, zones), final = settled(after, zones);
    const motion = planInlineTreeTransition(before.nodes.map(restingInlineTreeNode), after.nodes, "b");
    const plan = planAnimatedRegions({ previous: initial, targetNodes: after.nodes, zones, width: after.width, height: after.height });
    const first = sampleAnimatedRegions(plan, frameAt(motion, 0), 0);
    expect(first.zones.map(geometry)).toEqual(initial.zones.map(geometry));
    expect(first.groups.find(group => group.id === "b")!.height).toBe(0);
    expect(first.groups.find(group => group.id === "b")!.opacity).toBe(0);
    expect(first.nodes.filter(node => node.id.startsWith("item-")).every(node => node.opacity === 0)).toBe(true);
    const heights = new Set<number>();
    for (let i = 0; i <= 80; i++) {
      const p = i / 80, snapshot = sampleAnimatedRegions(plan, frameAt(motion, p), p);
      expectSafe(snapshot);
      heights.add(snapshot.groups.find(group => group.id === "b")!.height);
      for (const original of initial.groups) {
        const current = snapshot.groups.find(group => group.id === original.id)!;
        expect(current.opacity).toBe(1);
      }
    }
    expect(heights.size).toBeGreaterThan(70);
    expect(sampleAnimatedRegions(plan, frameAt(motion, 1), 1).groups.map(geometry)).toEqual(final.groups.map(geometry));
    const close = planInlineTreeTransition(after.nodes.map(restingInlineTreeNode), before.nodes, "b");
    const closePlan = planAnimatedRegions({ previous: final, targetNodes: before.nodes, zones, width: before.width, height: before.height });
    for (let i = 0; i <= 80; i++) expectSafe(sampleAnimatedRegions(closePlan, frameAt(close, i / 80), i / 80));
    const closed = sampleAnimatedRegions(closePlan, frameAt(close, 1), 1);
    expect(closed.groups.some(group => group.id === "b")).toBe(false);
    expect(closed.nodes.filter(node => node.exiting).every(node => node.opacity === 0)).toBe(true);
  });

  it.each([.4, .94, .985])("reverses from actual region geometry and effective card opacity at progress %f", p => {
    const { view, zones } = fixture(3), before = boundedTreeLayout(view, ["root", "a", "d"], 800), after = boundedTreeLayout(view, ["root", "a", "b", "d"], 800, before.columns);
    const initial = settled(before, zones), motion = planInlineTreeTransition(before.nodes.map(restingInlineTreeNode), after.nodes, "b");
    const plan = planAnimatedRegions({ previous: initial, targetNodes: after.nodes, zones, width: after.width, height: after.height });
    const raw = frameAt(motion, p), displayed = sampleAnimatedRegions(plan, raw, p);
    const reverseMotion = planInlineTreeTransition(raw, before.nodes, "b");
    const reverse = planAnimatedRegions({ previous: displayed, targetNodes: before.nodes, zones, width: before.width, height: before.height });
    const first = sampleAnimatedRegions(reverse, frameAt(reverseMotion, 0), 0);
    for (const group of first.groups) expect(geometry(group)).toEqual(geometry(displayed.groups.find(item => item.id === group.id)!));
    expect(first.zones.map(geometry)).toEqual(displayed.zones.map(geometry));
    for (const node of first.nodes) expect(node.opacity, node.id).toBeCloseTo(displayed.nodes.find(item => item.id === node.id && item.ghost === node.ghost)!.opacity);
    for (let i = 0; i <= 30; i++) expectSafe(sampleAnimatedRegions(reverse, frameAt(reverseMotion, i / 30), i / 30));
    const middleRaw = frameAt(reverseMotion, .35), middle = sampleAnimatedRegions(reverse, middleRaw, .35);
    const reopenMotion = planInlineTreeTransition(middleRaw, after.nodes, "b");
    const reopen = planAnimatedRegions({ previous: middle, targetNodes: after.nodes, zones, width: after.width, height: after.height });
    const reopenFirst = sampleAnimatedRegions(reopen, frameAt(reopenMotion, 0), 0);
    for (const group of reopenFirst.groups) expect(geometry(group)).toEqual(geometry(middle.groups.find(item => item.id === group.id)!));
    for (const node of reopenFirst.nodes) expect(node.opacity, node.id).toBeCloseTo(middle.nodes.find(item => item.id === node.id && item.ghost === node.ghost)!.opacity);
    for (let i = 0; i <= 30; i++) expectSafe(sampleAnimatedRegions(reopen, frameAt(reopenMotion, i / 30), i / 30));
  });

  it("uses ghosts only for actual label clearance and keeps the settled geometry source unchanged", () => {
    const { view, zones } = fixture(), layout = boundedTreeLayout(view, ["root", "a", "b", "d"], 800);
    const initial = settled(layout, zones), group = initial.groups.find(item => item.id === "b")!;
    const ghost = { ...restingInlineTreeNode(layout.nodes.find(node => node.id === "b")!), ghost: true, exiting: true, renderKey: "b:motion-ghost", opacity: .4, x: group.x + 20, y: group.y - 11 };
    const previous = { ...initial, nodes: [...initial.nodes, ghost] };
    const plan = planAnimatedRegions({ previous, targetNodes: layout.nodes, zones, width: layout.width, height: layout.height });
    const snapshot = sampleAnimatedRegions(plan, previous.nodes, 0);
    expect(snapshot.groups.map(geometry)).toEqual(initial.groups.map(geometry));
    expect(snapshot.zones.map(geometry)).toEqual(initial.zones.map(geometry));
    expect(snapshot.groups.find(item => item.id === "b")!.labelOpacity).toBe(0);
    expect(snapshot.groups.every(item => !item.descendantIds.includes(ghost.renderKey))).toBe(true);
    expect(snapshot.zones.every(item => !item.nodeIds.includes(ghost.renderKey))).toBe(true);
    expectSafe(snapshot);
    expect(initial.zones.map(({ labelOpacity: _, ...zone }) => zone)).toEqual(agentZoneRegions(layout.nodes.map(restingInlineTreeNode), zones, layout.width, layout.height));
  });

  it("translates the previous region snapshot with the same world-origin correction as cards", () => {
    const { view, zones } = fixture(), layout = boundedTreeLayout(view, ["root", "a", "b", "d"], 800), initial = settled(layout, zones);
    const offset = { x: 30, y: 50 };
    const plan = planAnimatedRegions({ previous: initial, targetNodes: layout.nodes, zones, width: layout.width, height: layout.height, originOffset: offset });
    const frame = initial.nodes.map(node => ({ ...node, x: node.x + offset.x, y: node.y + offset.y }));
    const first = sampleAnimatedRegions(plan, frame, 0);
    expect(first.groups.map(geometry)).toEqual(initial.groups.map(group => geometry({ ...group, x: group.x + offset.x, y: group.y + offset.y })));
    expect(first.nodes.map(node => node.opacity)).toEqual(initial.nodes.map(node => node.opacity));
    expect(first.labels.map(label => ({ ...label, left: label.left - offset.x, right: label.right - offset.x, top: label.top - offset.y, bottom: label.bottom - offset.y }))).toEqual(initial.labels);
  });

  it("approaches settled opacity continuously and samples a 132-card tree without rebuilding layouts", () => {
    const { view, zones } = fixture(124), before = boundedTreeLayout(view, ["root", "a", "d"], 800), after = boundedTreeLayout(view, ["root", "a", "b", "d"], 800, before.columns);
    expect(after.nodes).toHaveLength(132);
    const initial = settled(before, zones), motion = planInlineTreeTransition(before.nodes.map(restingInlineTreeNode), after.nodes, "b");
    const plan = planAnimatedRegions({ previous: initial, targetNodes: after.nodes, zones, width: after.width, height: after.height });
    const almost = sampleAnimatedRegions(plan, frameAt(motion, .999999), .999999), final = sampleAnimatedRegions(plan, frameAt(motion, 1), 1);
    expect(Math.min(...almost.nodes.map(node => node.opacity))).toBeGreaterThan(.98);
    expect(final.nodes.every(node => node.opacity === 1)).toBe(true);
    const timings: number[] = [];
    for (let i = 1; i <= 40; i++) {
      const p = i / 40, frame = frameAt(motion, p), start = performance.now();
      const snapshot = sampleAnimatedRegions(plan, frame, p);
      timings.push(performance.now() - start);
      expectSafe(snapshot);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[38]!;
    console.info(`132-card region sample p95=${p95.toFixed(2)} ms`);
    expect(p95).toBeLessThan(20);
  });
});

describe("region definition changes within one node-motion epoch", () => {
  function scenario() {
    const { view, zones } = fixture(), before = boundedTreeLayout(view, ["root", "a", "d"], 800), after = boundedTreeLayout(view, ["root", "a", "b", "d"], 800, before.columns);
    const motion = planInlineTreeTransition(before.nodes.map(restingInlineTreeNode), after.nodes, "b");
    const input = (layout: BoundedTreeLayout, nodes: AnimatedRegionFrameInput["frame"]["nodes"], progress: number, transitionId: number, definitions = zones): AnimatedRegionFrameInput => ({
      layout, zones: definitions, workspaceKey: "same-workspace",
      frame: { nodes, layoutSignature: layout.signature, progress, transitionId, originOffset: { x: 0, y: 0 } }
    });
    return { zones, before, after, motion, input };
  }

  it("does not replay .4 as .64 when a background update changes only hidden descendants", () => {
    const { zones, before, after, motion, input } = scenario();
    const rest = advanceAnimatedRegions(input(before, before.nodes.map(restingInlineTreeNode), 1, 1));
    const start = advanceAnimatedRegions(input(after, frameAt(motion, 0), 0, 2), rest);
    const half = advanceAnimatedRegions(input(after, frameAt(motion, .4), .4, 2), start);
    const hiddenUpdate = zones.map(zone => ({ ...zone, node_ids: [...zone.node_ids, `hidden-child:${zone.id}`] }));
    const updated = advanceAnimatedRegions(input(after, frameAt(motion, .4), .4, 2, hiddenUpdate), half);
    expect(updated.zonesKey).toBe(half.zonesKey);
    expect(updated.plan).toBe(half.plan);
    expect(updated.snapshot).toEqual(half.snapshot);
    const movingGroup = updated.snapshot.groups.find(group => group.id === "b")!;
    const targetGroup = after.groups.find(group => group.id === "b")!;
    expect(movingGroup.height / targetGroup.height).toBeCloseTo(.4);
    const finish = advanceAnimatedRegions(input(after, after.nodes.map(restingInlineTreeNode), 1, 2, hiddenUpdate), updated);
    expect(finish.snapshot.groups.map(geometry)).toEqual(settled(after, zones).groups.map(geometry));
    expect(finish.snapshot.nodes.every(node => node.opacity === 1)).toBe(true);
  });

  it("rebases a real visible definition change onto remaining progress and settles exactly", () => {
    const { zones, before, after, motion, input } = scenario();
    const withoutA = zones.filter(zone => zone.id !== "zone-a");
    const rest = advanceAnimatedRegions(input(before, before.nodes.map(restingInlineTreeNode), 1, 1, withoutA));
    const start = advanceAnimatedRegions(input(after, frameAt(motion, 0), 0, 2, withoutA), rest);
    const half = advanceAnimatedRegions(input(after, frameAt(motion, .4), .4, 2, withoutA), start);
    const changed = advanceAnimatedRegions(input(after, frameAt(motion, .4), .4, 2), half);
    expect(changed.plan).not.toBe(half.plan);
    expect(changed.progressOrigin).toBe(.4);
    expect(changed.snapshot.groups.map(geometry)).toEqual(half.snapshot.groups.map(geometry));
    for (const zone of half.snapshot.zones) expect(geometry(changed.snapshot.zones.find(item => item.id === zone.id)!)).toEqual(geometry(zone));
    expect(changed.snapshot.nodes.map(node => node.opacity)).toEqual(half.snapshot.nodes.map(node => node.opacity));
    const later = advanceAnimatedRegions(input(after, frameAt(motion, .7), .7, 2), changed);
    const from = half.snapshot.groups.find(group => group.id === "b")!, target = after.groups.find(group => group.id === "b")!;
    expect(later.snapshot.groups.find(group => group.id === "b")!.height).toBeCloseTo(from.height + (target.height - from.height) * .5);
    const finish = advanceAnimatedRegions(input(after, after.nodes.map(restingInlineTreeNode), 1, 2), later);
    expect(finish.snapshot.groups.map(geometry)).toEqual(settled(after, zones).groups.map(geometry));
    expect(finish.snapshot.zones.map(geometry)).toEqual(settled(after, zones).zones.map(geometry));
    expect(finish.snapshot.nodes.every(node => node.opacity === 1)).toBe(true);
  });

  it("holds a mismatched frame and resets the progress origin on reversal without moving backwards at finish", () => {
    const { zones, before, after, motion, input } = scenario();
    const withoutA = zones.filter(zone => zone.id !== "zone-a");
    const rest = advanceAnimatedRegions(input(before, before.nodes.map(restingInlineTreeNode), 1, 1, withoutA));
    const start = advanceAnimatedRegions(input(after, frameAt(motion, 0), 0, 2, withoutA), rest);
    const half = advanceAnimatedRegions(input(after, frameAt(motion, .4), .4, 2, withoutA), start);
    const changed = advanceAnimatedRegions(input(after, frameAt(motion, .4), .4, 2), half);
    const raw = frameAt(motion, .7), later = advanceAnimatedRegions(input(after, raw, .7, 2), changed);
    const waiting = { ...input(before, raw, .7, 2), frame: { ...input(before, raw, .7, 2).frame, layoutSignature: after.signature } };
    expect(advanceAnimatedRegions(waiting, later)).toBe(later);
    const reverse = planInlineTreeTransition(raw, before.nodes, "b");
    const reversed = advanceAnimatedRegions(input(before, frameAt(reverse, 0), 0, 3), later);
    expect(reversed.progressOrigin).toBe(0);
    for (const group of reversed.snapshot.groups) expect(geometry(group)).toEqual(geometry(later.snapshot.groups.find(item => item.id === group.id)!));
    for (const node of reversed.snapshot.nodes) expect(node.opacity).toBe(later.snapshot.nodes.find(item => item.id === node.id && item.ghost === node.ghost)!.opacity);
    const middle = advanceAnimatedRegions(input(before, frameAt(reverse, .5), .5, 3), reversed);
    expect(middle.snapshot.groups.find(group => group.id === "b")!.height).toBeCloseTo(reversed.snapshot.groups.find(group => group.id === "b")!.height / 2);
    const finish = advanceAnimatedRegions(input(before, before.nodes.map(restingInlineTreeNode), 1, 3), middle);
    expect(finish.snapshot.groups.map(geometry)).toEqual(settled(before, zones).groups.map(geometry));
    expect(finish.snapshot.zones.map(geometry)).toEqual(settled(before, zones).zones.map(geometry));
    expect(advanceAnimatedRegions(input(before, before.nodes.map(restingInlineTreeNode), 1, 3), finish).snapshot).toEqual(finish.snapshot);
  });
});

describe("region snapshot identity across unrelated renders", () => {
  function inputFor(count = 3): { input: AnimatedRegionFrameInput; view: ReturnType<typeof fixture>["view"] } {
    const { view, zones } = fixture(count), layout = boundedTreeLayout(view, ["root", "a", "b", "d"], 800);
    return { view, input: { workspaceKey: "same-workspace", layout, zones,
      frame: { nodes: layout.nodes.map(restingInlineTreeNode), layoutSignature: layout.signature, transitionId: 4, progress: 1, originOffset: { x: 0, y: 0 } } } };
  }

  it("does not resample the same 132-card frame when input wrappers change during camera renders", () => {
    const { input } = inputFor(124);
    expect(input.frame.nodes).toHaveLength(132);
    const sampleNodes = vi.spyOn(input.frame.nodes, "map");
    const first = advanceAnimatedRegions(input);
    expect(sampleNodes).toHaveBeenCalledTimes(1);
    let current = first;
    for (let i = 0; i < 132; i++) current = advanceAnimatedRegions({ ...input, frame: { ...input.frame, originOffset: { x: 0, y: 0 } }, layout: { ...input.layout } }, current);
    expect(current).toBe(first);
    expect(current.snapshot).toBe(first.snapshot);
    expect(sampleNodes).toHaveBeenCalledTimes(1);
    sampleNodes.mockRestore();
  });

  it("reuses equivalent filtered arrays and hidden-zone updates, including a title-only layout refresh", () => {
    const { input, view } = inputFor();
    const first = advanceAnimatedRegions(input);
    const renamed = deriveEngineeringView({ ...view.document, nodes: view.document.nodes.map(node => node.id === "a" ? { ...node, title: "更新后的真实标题" } : node) });
    const layout = boundedTreeLayout(renamed, ["root", "a", "b", "d"], 800);
    const equivalent = { ...input, layout, zones: input.zones.map(zone => ({ ...zone, node_ids: [...zone.node_ids, `hidden:${zone.id}`] })),
      frame: { ...input.frame, nodes: [...input.frame.nodes] } };
    const updated = advanceAnimatedRegions(equivalent, first);
    expect(updated.plan).toBe(first.plan);
    expect(updated.snapshot).toBe(first.snapshot);
    expect(renamed.document.nodes.find(node => node.id === "a")!.title).toBe("更新后的真实标题");
    expect(advanceAnimatedRegions(equivalent, updated)).toBe(updated);
    const countOnly = { ...equivalent, layout: { ...layout, nodes: layout.nodes.map(node => node.id === "c" ? { ...node, childCount: node.childCount + 1 } : node) } };
    expect(advanceAnimatedRegions(countOnly, updated).snapshot).toBe(updated.snapshot);
    const visibleChange = { ...equivalent, zones: equivalent.zones.map(zone => zone.id === "zone-a" ? { ...zone, node_ids: ["a"] } : zone) };
    const changed = advanceAnimatedRegions(visibleChange, updated);
    expect(changed.plan).not.toBe(updated.plan);
    expect(changed.snapshot.zones.find(zone => zone.id === "zone-a")!.nodeIds).toEqual(["a"]);
  });

  it("invalidates actual frame geometry, opacity, ghost identity and removal without hiding their new values", () => {
    const { input } = inputFor();
    const first = advanceAnimatedRegions(input);
    const changedNodes = input.frame.nodes.map((node, index) => index === 0 ? { ...node, x: node.x + 7, opacity: .6 } : node);
    const moved = advanceAnimatedRegions({ ...input, frame: { ...input.frame, nodes: changedNodes } }, first);
    expect(moved.snapshot).not.toBe(first.snapshot);
    expect(moved.snapshot.nodes[0]).toMatchObject({ x: changedNodes[0]!.x, opacity: .6 });
    const ghost = { ...input.frame.nodes[0]!, ghost: true, renderKey: "root:new-ghost", exiting: true, motionRole: "crossfade-out" as const };
    const ghostFrame = advanceAnimatedRegions({ ...input, frame: { ...input.frame, nodes: [ghost, ...input.frame.nodes.slice(1)] } }, first);
    expect(ghostFrame.snapshot).not.toBe(first.snapshot);
    expect(ghostFrame.snapshot.nodes[0]).toMatchObject({ ghost: true, renderKey: "root:new-ghost", exiting: true, motionRole: "crossfade-out" });
    const removed = advanceAnimatedRegions({ ...input, frame: { ...input.frame, nodes: input.frame.nodes.filter(node => node.id !== "stable") } }, first);
    expect(removed.snapshot.nodes.some(node => node.id === "stable")).toBe(false);
    expect(removed.snapshot).not.toBe(first.snapshot);
  });

  it("does not cache a changed clock, target geometry, canvas size, world origin or workspace", () => {
    const { input } = inputFor();
    const first = advanceAnimatedRegions(input);
    const progress = advanceAnimatedRegions({ ...input, frame: { ...input.frame, progress: .8 } }, first);
    expect(progress.snapshot).not.toBe(first.snapshot);
    expect(progress.plan).toBe(first.plan);
    const resized = advanceAnimatedRegions({ ...input, layout: { ...input.layout, width: input.layout.width + 80, height: input.layout.height + 20 } }, first);
    expect(resized.plan).not.toBe(first.plan);
    expect(resized.snapshot).not.toBe(first.snapshot);
    const relocated = advanceAnimatedRegions({ ...input, layout: { ...input.layout, nodes: input.layout.nodes.map(node => ({ ...node, x: node.x + 3 })) } }, first);
    expect(relocated.plan).not.toBe(first.plan);
    const origin = advanceAnimatedRegions({ ...input, frame: { ...input.frame, originOffset: { x: 12, y: 7 } } }, first);
    expect(origin.snapshot).not.toBe(first.snapshot);
    const fresh = advanceAnimatedRegions({ ...input, workspaceKey: "another-workspace" }, first);
    expect(fresh.plan).not.toBe(first.plan);
    expect(fresh.snapshot).not.toBe(first.snapshot);
    expect(fresh.progressOrigin).toBe(0);
    const reversedInput = { ...input, frame: { ...input.frame, transitionId: 5, progress: 0 } };
    const reversed = advanceAnimatedRegions(reversedInput, first);
    expect(reversed.plan).not.toBe(first.plan);
    expect(reversed.progressOrigin).toBe(0);
    expect(advanceAnimatedRegions(reversedInput, reversed)).toBe(reversed);
  });
});
