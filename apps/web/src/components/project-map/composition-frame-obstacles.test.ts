import { describe, expect, it } from "vitest";
import { dependencySegmentCrossesRect } from "../engineering/dependency-routing.ts";
import { animatedComposition } from "./animated-composition.ts";
import { boundedCompositionEdges, type BoundedCompositionEdge } from "./bounded-tree-layout.ts";
import { restingInlineTreeNode } from "./inline-tree-transition.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";

const node = (id: string, x: number, y: number, parentId: string | null = "root"): InlineTreeNode => ({ id, x, y, parentId, width: 208, height: 120, depth: parentId ? 1 : 0, childCount: 0, expanded: false });
const nodes = [node("root", 300, 20, null), node("a", 60, 230), node("b", 420, 230)];
const label = { id: "moving-title", left: 250, right: 350, top: 180, bottom: 200 };
const crosses = (edge: BoundedCompositionEdge, rect: typeof label) => edge.points.slice(1).some((point, i) => dependencySegmentCrossesRect(edge.points[i]!, point, rect));

describe("composition uses displayed region titles", () => {
  it("reroutes around the visible title rather than the settled title position", () => {
    const before = boundedCompositionEdges(nodes, 800);
    expect(before.some(edge => crosses(edge, label))).toBe(true);
    const after = boundedCompositionEdges(nodes, 800, nodes, { labelObstacles: [label] });
    expect(after.map(edge => edge.id).sort()).toEqual(["root>a", "root>b"]);
    expect(after.some(edge => crosses(edge, label))).toBe(false);
    expect(after.find(edge => edge.id === "root>a")!.d).not.toBe(before.find(edge => edge.id === "root>a")!.d);
  });

  it("uses a provided branch-caption rectangle and leaves unrelated routes intact", () => {
    const actualGroup = { id: "a", parentId: "root", x: 230, y: 190, width: 150, height: 10, childIds: [], descendantIds: [] };
    const after = boundedCompositionEdges(nodes, 800, nodes, { groups: [actualGroup] });
    expect(after).toHaveLength(2);
    expect(after.some(edge => crosses(edge, { ...label, left: 250, right: 360, top: 179, bottom: 201 }))).toBe(false);
    expect(after.find(edge => edge.id === "root>b")!.d).toBe(boundedCompositionEdges(nodes, 800).find(edge => edge.id === "root>b")!.d);
  });

  it("reports only the blocked relation if a moving label encloses its target port", () => {
    const blockedPort = { left: 55, right: 273, top: 220, bottom: 355 };
    const result = animatedComposition(nodes.map(restingInlineTreeNode), nodes, 800, { labelObstacles: [blockedPort] });
    expect(result.suppressedEdgeIds).toEqual(["root>a"]);
    expect(result.edges.map(edge => edge.id)).toEqual(["root>b"]);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it("keeps the relation by entering the side when an Agent title blocks top entry", () => {
    const agentTitle = { id: "agent:a", left: 60, right: 250, top: 205, bottom: 227 };
    const result = animatedComposition(nodes.map(restingInlineTreeNode), nodes, 800, { labelObstacles: [agentTitle], alignedLaneSide: "left" });
    expect(result.suppressedEdgeIds).toEqual([]);
    const edge = result.edges.find(edge => edge.id === "root>a")!;
    expect(crosses(edge, agentTitle)).toBe(false);
    expect(edge.points.at(-1)!.y).toBe(290);
    expect([60, 268]).toContain(edge.points.at(-1)!.x);
  });

  it("uses the target branch gutter when global side entry would cross neighbouring cards", () => {
    const root = node("root", 621, 28, null);
    const siblings = [93, 357, 621, 885, 1149].map((x, i) => node(`s${i}`, x, 204));
    const children = [node("first", 621, 380, "s2"), node("second", 621, 556, "s2")].map(child => ({ ...child, depth: 2 }));
    const all = [root, ...siblings, ...children];
    const titles = siblings.map(sibling => ({ left: sibling.x, right: sibling.x + 190, top: sibling.y - 25, bottom: sibling.y - 3 }));
    const result = animatedComposition(all.map(restingInlineTreeNode), all, 1450, { labelObstacles: titles, alignedLaneSide: "left", wrappedRootSideEntry: true });
    expect(result.suppressedEdgeIds).toEqual([]);
    expect(result.edges).toHaveLength(7);
    const edge = result.edges.find(edge => edge.id === "root>s2")!;
    for (const title of titles) expect(crosses(edge, { id: "title", ...title })).toBe(false);
    for (const sibling of siblings.filter(sibling => sibling.id !== "s2")) expect(crosses(edge, { id: sibling.id, left: sibling.x, right: sibling.x + sibling.width, top: sibling.y, bottom: sibling.y + sibling.height })).toBe(false);
  });
});
