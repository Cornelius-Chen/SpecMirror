import { describe, expect, it } from "vitest";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import { INLINE_TREE_MAX_SHIFT, planInlineTreeTransition, restingInlineTreeNode } from "./inline-tree-transition.ts";

const node = (id: string, x: number, y: number, parentId: string | null = "root"): InlineTreeNode => ({
  id, parentId, x, y, width: 208, height: 120, depth: parentId ? 1 : 0, childCount: 0, expanded: false
});

describe("inline tree transition planning", () => {
  it("keeps the clicked node fixed and reveals a new child at its final branch", () => {
    const current = [restingInlineTreeNode(node("root", 300, 28, null)), restingInlineTreeNode(node("branch", 40, 200))];
    const targets = [node("root", 300, 28, null), node("branch", 280, 200), node("child", 280, 376, "branch")];
    const plan = planInlineTreeTransition(current, targets, "branch");
    const anchor = plan.from.find(item => item.id === "branch" && !item.ghost)!;
    const child = plan.from.find(item => item.id === "child")!;
    expect(anchor).toMatchObject({ x: 280, y: 200, opacity: 1, motionRole: "anchor" });
    expect(child).toMatchObject({ x: 280, opacity: 0, motionRole: "enter" });
    expect(Math.abs(child.y - targets[2]!.y)).toBeLessThanOrEqual(14);
  });

  it("offsets every old card against the anchor camera correction on the first frame", () => {
    const current = [restingInlineTreeNode(node("root", 300, 28, null)), restingInlineTreeNode(node("branch", 40, 200)), restingInlineTreeNode(node("peer", 300, 200))];
    const targets = [node("root", 420, 28, null), node("branch", 160, 200), node("peer", 420, 200), node("child", 160, 376, "branch")];
    const offset = { x: 120, y: 0 };
    const plan = planInlineTreeTransition(current, targets, "branch", offset);
    expect(plan.from.find(item => item.id === "branch" && !item.ghost)).toMatchObject({ x: 160, y: 200, motionRole: "anchor" });
    expect(plan.from.find(item => item.id === "root" && !item.ghost)).toMatchObject({ x: 420, y: 28 });
    expect(plan.from.find(item => item.id === "peer" && !item.ghost)).toMatchObject({ x: 420, y: 200 });
  });

  it("smoothly makes one card-width of room within the same row", () => {
    const current = [restingInlineTreeNode(node("left", 100, 200)), restingInlineTreeNode(node("right", 332, 200))];
    const targets = [node("left", 228, 200), node("right", 460, 200)];
    const plan = planInlineTreeTransition(current, targets);
    expect(plan.from.find(item => item.id === "left")).toMatchObject({ x: 100, y: 200, opacity: 1, motionRole: "shift" });
    expect(plan.from.find(item => item.id === "right")).toMatchObject({ x: 332, y: 200, opacity: 1, motionRole: "shift" });
    expect(plan.from.some(item => item.ghost)).toBe(false);
  });

  it("moves later rows along the same column without swapping card identity", () => {
    const current = [restingInlineTreeNode(node("later", 40, 400))];
    const plan = planInlineTreeTransition(current, [node("later", 40, 800)]);
    expect(plan.from).toHaveLength(1);
    expect(plan.from[0]).toMatchObject({ x: 40, y: 400, opacity: 1, motionRole: "shift" });
    expect(plan.to[0]).toMatchObject({ x: 40, y: 800, opacity: 1 });
  });

  it("crossfades a large reflow and only translates a nearby card", () => {
    const current = [restingInlineTreeNode(node("far", 20, 200)), restingInlineTreeNode(node("near", 300, 200))];
    const targets = [node("far", 420, 420), node("near", 300 + INLINE_TREE_MAX_SHIFT, 200)];
    const plan = planInlineTreeTransition(current, targets);
    const farIn = plan.from.find(item => item.id === "far" && !item.ghost)!;
    const farOut = plan.from.find(item => item.id === "far" && item.ghost)!;
    const farOutTarget = plan.to[plan.from.indexOf(farOut)]!;
    expect(farIn).toMatchObject({ opacity: 0, motionRole: "crossfade-in" });
    expect(Math.hypot(farIn.x - 420, farIn.y - 420)).toBeCloseTo(8);
    expect(plan.from.find(item => item.id === "far" && item.ghost)).toMatchObject({ x: 20, y: 200, opacity: 1, motionRole: "crossfade-out", exiting: true });
    expect(Math.hypot(farOutTarget.x - farOut.x, farOutTarget.y - farOut.y)).toBeCloseTo(8);
    expect(plan.from.find(item => item.id === "near")).toMatchObject({ x: 300, y: 200, motionRole: "shift" });
  });

  it("fades a removed node in place instead of flying it back to its parent", () => {
    const current = [restingInlineTreeNode(node("root", 300, 28, null)), restingInlineTreeNode(node("child", 80, 400))];
    const plan = planInlineTreeTransition(current, [node("root", 300, 28, null)], "root");
    const from = plan.from.find(item => item.id === "child")!, to = plan.to[plan.from.indexOf(from)]!;
    expect(from).toMatchObject({ x: 80, y: 400, motionRole: "exit", exiting: true });
    expect(to).toMatchObject({ x: 80, y: 390, opacity: 0 });
  });
});
