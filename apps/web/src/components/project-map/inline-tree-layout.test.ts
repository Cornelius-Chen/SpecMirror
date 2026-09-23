import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, deriveEngineeringView, type EngineeringDocument } from "@epm/domain";
import { compositionEdges, inlineTreeLayout, inlineTreeRelations, type InlineTreeLayout } from "./inline-tree-layout.ts";
import { dependencySegmentCrossesRect } from "../engineering/dependency-routing.ts";
const stamp = "2026-09-05T00:00:00Z";
const node = (id: string, parent_id: string | null, extra: Record<string, unknown> = {}) => EngineeringNodeSchema.parse({ id, parent_id, title: id, kind: parent_id ? "task" : "project", objective: "真实结果", owner: "未分配", order: 0, revision: 1, status: "draft", constraints: {}, created_at: stamp, updated_at: stamp, ...extra });
const document = (nodes = [node("root", null), node("a", "root"), node("b", "root", { order: 1 }), node("task", "a"), node("component", "task"), node("leaf", "component"), node("other", "b")]): EngineeringDocument => ({ schema_version: 1, id: "inline-unit", root_id: "root", revision: 1, nodes, runs: [], events: [], changes: [], capability_uses: [], created_at: stamp, updated_at: stamp });
const branchingDocument = (counts = [2, 2, 2, 2, 2]) => document([node("root", null), ...counts.flatMap((count, i) => [node("branch-" + i, "root", { order: i }), ...Array.from({ length: count }, (_, j) => node(`leaf-${i}-${j}`, "branch-" + i, { order: j }))])]);
const coordinates = (layout: InlineTreeLayout) => new Map(layout.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
const expectOrderedRows = (layout: InlineTreeLayout) => {
  expect(Number.isFinite(layout.width) && Number.isFinite(layout.height)).toBe(true);
  for (const depth of new Set(layout.nodes.map(n => n.depth))) {
    const row = layout.nodes.filter(n => n.depth === depth);
    for (const [i, current] of row.entries()) {
      expect(current.x).toBeGreaterThanOrEqual(28);
      expect(current.width).toBe(208); expect(current.height).toBe(188);
      expect(current.x + current.width + 28).toBeLessThanOrEqual(layout.width);
      expect(current.y + current.height + 28).toBeLessThanOrEqual(layout.height);
      if (i) expect(current.x - (row[i - 1].x + row[i - 1].width)).toBeGreaterThanOrEqual(24 - 1e-8);
    }
  }
};

describe("inline engineering containment", () => {
  it("defaults to the root and its immediate children; an explicit empty expansion stays collapsed", () => {
    const view = deriveEngineeringView(document());
    expect(inlineTreeLayout(view).nodes.map(n => n.id)).toEqual(["root", "a", "b"]);
    expect(inlineTreeLayout(view, []).nodes.map(n => n.id)).toEqual(["root"]);
  });
  it("keeps five real levels and independently expanded siblings in the same tree", () => {
    const view = deriveEngineeringView(document()), expanded = ["root", "a", "task", "component", "b"];
    expect(inlineTreeLayout(view, expanded).nodes.map(n => n.id)).toEqual(["root", "a", "task", "component", "leaf", "b", "other"]);
    const folded = inlineTreeLayout(view, expanded.filter(id => id !== "a"));
    expect(folded.nodes.map(n => n.id)).toEqual(["root", "a", "b", "other"]);
    expect(folded.nodes.find(n => n.id === "b")?.expanded).toBe(true);
    expect(inlineTreeLayout(view, expanded).nodes.find(n => n.id === "leaf")?.depth).toBe(4);
  });
  it("lays out nonoverlapping hit areas and routes every composition line only through level gaps", () => {
    const layout = inlineTreeLayout(deriveEngineeringView(document()), ["root", "a", "task", "component", "b"]);
    expect(layout.edges).toHaveLength(layout.nodes.length - 1);
    for (const a of layout.nodes) for (const b of layout.nodes) if (a.id !== b.id) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    const byId = new Map(layout.nodes.map(n => [n.id, n]));
    for (const edge of layout.edges) {
      const a = byId.get(edge.from)!, b = byId.get(edge.to)!;
      const points = [{ x: a.x + a.width / 2, y: a.y + a.height }, { x: a.x + a.width / 2, y: a.y + a.height + 28 }, { x: b.x + b.width / 2, y: a.y + a.height + 28 }, { x: b.x + b.width / 2, y: b.y }];
      for (const other of layout.nodes) for (let i = 1; i < points.length; i++) expect(dependencySegmentCrossesRect(points[i - 1], points[i], { id: other.id, left: other.x, right: other.x + other.width, top: other.y, bottom: other.y + other.height })).toBe(false);
    }
  });
  it("does not rearrange containment when status, evidence, title, or dependencies refresh", () => {
    const doc = document(), before = inlineTreeLayout(deriveEngineeringView(doc), ["root", "a"]);
    doc.nodes[1].status = "blocked"; doc.nodes[1].title = "更长的中文任务名称"; doc.nodes[2].dependencies = ["a"];
    expect(inlineTreeLayout(deriveEngineeringView(doc), ["root", "a"])).toEqual(before);
  });
  it("excludes whole archived branches even if descendants are active and listed as expanded", () => {
    const doc = document(); doc.nodes[1].status = "archived";
    expect(inlineTreeLayout(deriveEngineeringView(doc), ["root", "a", "task", "component", "missing"]).nodes.map(n => n.id)).toEqual(["root", "b"]);
  });
  it("retains all large-branch children at normal logical size instead of shrinking or slicing them", () => {
    const doc = document([node("root", null), ...Array.from({ length: 1200 }, (_, i) => node("child-" + i, "root", { order: i }))]);
    const layout = inlineTreeLayout(deriveEngineeringView(doc));
    expect(layout.nodes).toHaveLength(1201); expect(layout.edges).toHaveLength(1200);
    expect(layout.nodes.at(-1)?.id).toBe("child-1199"); expect(layout.nodes.every(n => n.width === 208)).toBe(true);
    expect(layout.width).toBeGreaterThan(200000);
  });
  it("keeps inherited and collapsed-source dependency records distinct from containment", () => {
    const doc = document(); doc.nodes[1].dependencies = ["other"];
    const view = deriveEngineeringView(doc), layout = inlineTreeLayout(view, ["root", "a"]);
    expect(layout.nodes.some(n => n.id === "other")).toBe(false);
    expect(inlineTreeRelations(view, layout)).toEqual(expect.arrayContaining([expect.objectContaining({ from: "other", to: "task", origin: "a", inherited: true })]));
    expect(layout.edges.some(edge => edge.from === "other")).toBe(false);
  });
  it("reveals the middle branch under five modules without moving any visible node", () => {
    const view = deriveEngineeringView(branchingDocument()), before = inlineTreeLayout(view), saved = structuredClone(before);
    const after = inlineTreeLayout(view, ["root", "branch-2"], before), positions = coordinates(after);
    for (const [id, position] of coordinates(before)) expect(positions.get(id)).toEqual(position);
    const parent = after.nodes.find(n => n.id === "branch-2")!, children = after.nodes.filter(n => n.parentId === parent.id);
    expect((children[0].x + children[1].x) / 2).toBe(parent.x);
    expect(before).toEqual(saved); expectOrderedRows(after);
  });
  it("keeps the first open branch still while fitting a neighbouring branch beside it", () => {
    const view = deriveEngineeringView(branchingDocument()), first = inlineTreeLayout(view, ["root", "branch-2"], inlineTreeLayout(view));
    const next = inlineTreeLayout(view, ["root", "branch-2", "branch-3"], first), positions = coordinates(next);
    for (const [id, position] of coordinates(first)) expect(positions.get(id)).toEqual(position);
    expect(next.nodes.filter(n => n.depth === 2).map(n => n.id)).toEqual(["leaf-2-0", "leaf-2-1", "leaf-3-0", "leaf-3-1"]);
    expectOrderedRows(next);
  });
  it("fits a new branch between separated open branches without disturbing their anchors", () => {
    const view = deriveEngineeringView(branchingDocument([1, 1, 1, 1, 1]));
    const first = inlineTreeLayout(view, ["root", "branch-0", "branch-4"], inlineTreeLayout(view));
    const next = inlineTreeLayout(view, ["root", "branch-0", "branch-2", "branch-4"], first), positions = coordinates(next);
    for (const [id, position] of coordinates(first)) expect(positions.get(id)).toEqual(position);
    expect(next.nodes.find(n => n.id === "leaf-2-0")?.x).toBe(next.nodes.find(n => n.id === "branch-2")?.x);
    expectOrderedRows(next);
  });
  it("only moves the conflicting portion of a crowded row while keeping other levels fixed", () => {
    const view = deriveEngineeringView(branchingDocument([1, 1, 1, 2, 1, 1, 1]));
    const previous = inlineTreeLayout(view, ["root", "branch-0", "branch-2", "branch-4", "branch-6"]);
    const after = inlineTreeLayout(view, ["root", "branch-0", "branch-2", "branch-3", "branch-4", "branch-6"], previous);
    const positions = coordinates(after);
    for (const old of previous.nodes.filter(n => n.depth < 2 || n.id === "leaf-0-0" || n.id === "leaf-6-0")) expect(positions.get(old.id)).toEqual({ x: old.x, y: old.y });
    const oldLeft = previous.nodes.find(n => n.id === "leaf-2-0")!, oldRight = previous.nodes.find(n => n.id === "leaf-4-0")!;
    expect(positions.get(oldLeft.id)!.x).toBe(oldLeft.x - 116);
    expect(positions.get(oldRight.id)!.x).toBe(oldRight.x + 116);
    expectOrderedRows(after);
  });
  it("retains the camera extent on collapse and does not accumulate drift across repeated toggles", () => {
    const view = deriveEngineeringView(branchingDocument()), initial = inlineTreeLayout(view), opened = inlineTreeLayout(view, ["root", "branch-2", "branch-3"], initial);
    let latest = opened;
    for (let i = 0; i < 12; i++) {
      const closed = inlineTreeLayout(view, ["root", "branch-3"], latest), closedPositions = coordinates(closed);
      for (const current of latest.nodes.filter(n => n.parentId !== "branch-2")) expect(closedPositions.get(current.id)).toEqual({ x: current.x, y: current.y });
      expect(closed.width).toBe(latest.width); expect(closed.height).toBe(latest.height);
      latest = inlineTreeLayout(view, ["root", "branch-2", "branch-3"], closed);
      expectOrderedRows(latest);
    }
    expect(latest).toEqual(opened);
  });
  it("translates left overflow uniformly without deforming existing branches", () => {
    const view = deriveEngineeringView(branchingDocument([7, 1, 1, 1, 1])), before = inlineTreeLayout(view);
    const after = inlineTreeLayout(view, ["root", "branch-0"], before), positions = coordinates(after);
    const translation = positions.get("root")!.x - coordinates(before).get("root")!.x;
    expect(translation).toBeGreaterThan(0);
    for (const old of before.nodes) expect(positions.get(old.id)).toEqual({ x: old.x + translation, y: old.y });
    expectOrderedRows(after);
  });
  it("preserves stable geometry on source refresh and removes archived branches", () => {
    const doc = branchingDocument(), previous = inlineTreeLayout(deriveEngineeringView(doc), ["root", "branch-2"], inlineTreeLayout(deriveEngineeringView(doc)));
    doc.nodes.find(n => n.id === "branch-2")!.title = "新的完整名称";
    doc.nodes.find(n => n.id === "branch-3")!.dependencies = ["leaf-2-1"];
    expect(inlineTreeLayout(deriveEngineeringView(doc), ["root", "branch-2"], previous)).toEqual(previous);
    doc.nodes.find(n => n.id === "branch-2")!.status = "archived";
    const after = inlineTreeLayout(deriveEngineeringView(doc), ["root", "branch-2"], previous);
    expect(after.nodes.some(n => n.id === "branch-2" || n.parentId === "branch-2")).toBe(false);
    for (const current of after.nodes) expect(coordinates(previous).get(current.id)).toEqual({ x: current.x, y: current.y });
  });
  it("discards a previous graph with another root instead of inheriting its camera extent", () => {
    const view = deriveEngineeringView(document()), expected = inlineTreeLayout(view);
    expect(inlineTreeLayout(view, undefined, { ...expected, rootId: "other-root", width: 1e6, height: 1e6 })).toEqual(expected);
  });
  it("keeps 200 descendants ordered and finite through mixed multi-branch expansion", () => {
    const view = deriveEngineeringView(branchingDocument(Array(20).fill(9))), expanded = ["root"];
    let current = inlineTreeLayout(view);
    for (const i of [10, 9, 11, 0, 19, 1, 18, 2, 17, 3, 16, 4, 15, 5, 14, 6, 13, 7, 12, 8]) {
      expanded.push("branch-" + i); current = inlineTreeLayout(view, expanded, current); expectOrderedRows(current);
    }
    expect(current.nodes).toHaveLength(201); expect(current.edges).toHaveLength(200);
    expect(current.width).toBeLessThan(100000);
    expect(current.height).toBe(732);
  });
  it("builds composition edges from displayed intermediate positions", () => {
    const layout = inlineTreeLayout(deriveEngineeringView(document())), moving = layout.nodes.map(n => ({ ...n, x: n.x + 37.5, y: n.y + 12.25 }));
    const edge = compositionEdges(moving)[0], parent = moving.find(n => n.id === edge.from)!, child = moving.find(n => n.id === edge.to)!;
    expect(edge.d).toBe(`M ${parent.x + 104} ${parent.y + 188} V ${parent.y + 216} H ${child.x + 104} V ${child.y}`);
    expect(edge.id).toBe(layout.edges[0].id);
  });
  it("keeps animated bends within the actual gap before the child reaches its final row", () => {
    const parent = inlineTreeLayout(deriveEngineeringView(document()), []).nodes[0];
    const child = { ...parent, id: "child", parentId: parent.id, depth: 1, x: parent.x + 50, y: parent.y + parent.height + 8 };
    const [edge] = compositionEdges([parent, child]);
    expect(edge.d).toBe(`M ${parent.x + 104} ${parent.y + 188} V ${parent.y + 192} H ${child.x + 104} V ${child.y}`);
  });
});
