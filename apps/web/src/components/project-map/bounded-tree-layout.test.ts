import { describe, expect, it, vi } from "vitest";
import { EngineeringNodeSchema, deriveEngineeringView, type EngineeringDocument } from "@epm/domain";
import { dependencySegmentCrossesRect } from "../engineering/dependency-routing.ts";
import { boundedCompositionEdges, boundedCompositionSegments, boundedTreeLayout, COMPOSITION_BOUNDARY_CLEARANCE, COMPOSITION_LANE_CLEARANCE, ROOT_CORRIDOR_CLEARANCE, type BoundedCompositionEdge, type BoundedTreeLayout } from "./bounded-tree-layout.ts";

const stamp = "2026-09-06T00:00:00Z";
const node = (id: string, parent_id: string | null, extra: Record<string, unknown> = {}) => EngineeringNodeSchema.parse({ id, parent_id, title: id, kind: parent_id ? "task" : "project", objective: "真实结果", owner: "未分配", order: 0, revision: 1, status: "draft", constraints: {}, created_at: stamp, updated_at: stamp, ...extra });
const document = (nodes = [node("root", null), node("a", "root"), node("b", "root", { order: 1 }), node("task", "a"), node("component", "task"), node("leaf", "component"), node("other", "b")]): EngineeringDocument => ({ schema_version: 1, id: "bounded-unit", root_id: "root", revision: 1, nodes, runs: [], events: [], changes: [], capability_uses: [], created_at: stamp, updated_at: stamp });
const branching = (counts = [2, 2, 2, 2, 2]) => document([node("root", null), ...counts.flatMap((count, i) => [node("branch-" + i, "root", { order: i }), ...Array.from({ length: count }, (_, j) => node(`leaf-${i}-${j}`, "branch-" + i, { order: j }))])]);
const positions = (layout: BoundedTreeLayout) => new Map(layout.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
const pathPoints = (d: string) => [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
const siblingRows = (layout: BoundedTreeLayout, parentId: string) => {
  const rows = new Map<number, string[]>();
  for (const child of layout.nodes.filter(item => item.parentId === parentId)) rows.set(child.y, [...rows.get(child.y) ?? [], child.id]);
  return [...rows.values()];
};

function expectNoVisibleSegmentOverlap(segments: ReturnType<typeof boundedCompositionSegments>, context: string) {
  expect(new Set(segments.map(segment => segment.id)).size, `duplicate visible segment id ${context}`).toBe(segments.length);
  for (const [index, one] of segments.entries()) for (const two of segments.slice(index + 1)) {
    const [a, b] = pathPoints(one.d), [c, d] = pathPoints(two.d);
    const vertical = a.x === b.x && c.x === d.x && a.x === c.x;
    const horizontal = a.y === b.y && c.y === d.y && a.y === c.y;
    if (!vertical && !horizontal) continue;
    const overlap = vertical
      ? Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
      : Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
    expect(overlap, `${one.id} overlaps ${two.id} ${context}`).toBeLessThanOrEqual(0.001);
  }
}

function expectSafeGeometry(layout: BoundedTreeLayout, availableWidth: number) {
  expect(Number.isFinite(layout.width) && Number.isFinite(layout.height)).toBe(true);
  expect(layout.width).toBeLessThanOrEqual(availableWidth);
  for (const n of layout.nodes) {
    expect(n.width).toBe(208); expect(n.height).toBe(120);
    expect(n.x).toBeGreaterThanOrEqual(28); expect(n.y).toBeGreaterThanOrEqual(28);
    expect(n.x + n.width + 28).toBeLessThanOrEqual(layout.width);
    expect(n.y + n.height + 28).toBeLessThanOrEqual(layout.height);
  }
  for (const [i, a] of layout.nodes.entries()) for (const b of layout.nodes.slice(i + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} overlaps ${b.id}`).toBe(true);
  expect(layout.edges).toHaveLength(Math.max(0, layout.nodes.length - 1));
  const byId = new Map(layout.nodes.map(n => [n.id, n]));
  for (const edge of layout.edges) {
    const points = pathPoints(edge.d), parent = byId.get(edge.from)!, child = byId.get(edge.to)!;
    expect(points[0]).toEqual({ x: parent.x + parent.width / 2, y: parent.y + parent.height });
    expect(points.at(-1)).toEqual({ x: child.x + child.width / 2, y: child.y });
    for (const p of points) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(layout.width); }
    for (const n of layout.nodes) for (let i = 1; i < points.length; i++) expect(dependencySegmentCrossesRect(points[i - 1], points[i], { id: n.id, left: n.x, top: n.y, right: n.x + n.width, bottom: n.y + n.height }), `${edge.id} crosses ${n.id}`).toBe(false);
  }
}

describe("width-bounded engineering containment", () => {
  it("shares reference scans and region lookups across all 131 relationships", () => {
    const doc = branching([1, 1, 2, 0, 120]);
    doc.nodes.push(node("nested", "leaf-0-0"), node("nested-leaf", "nested"));
    const layout = boundedTreeLayout(deriveEngineeringView(doc), ["root", "branch-0", "branch-1", "branch-2", "branch-4", "leaf-0-0", "nested"], 800);
    const settled = layout.nodes.slice(), groups = layout.groups.slice();
    const scan = vi.spyOn(settled, "filter"), find = vi.spyOn(groups, "find");
    try {
      const edges = boundedCompositionEdges(layout.nodes, layout.width, settled, { groups });
      expect(edges).toEqual(layout.edges);
      expect(edges).toHaveLength(131);
      // Only the one reference-group build scans this full array. Root edges
      // consume their indexed siblings, not another complete-node filter each.
      expect(scan).toHaveBeenCalledTimes(1);
      expect(find).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); find.mockRestore(); }
  });
  it("builds groups once when displayed and settled nodes are the same input", () => {
    const layout = boundedTreeLayout(deriveEngineeringView(branching([4, 4, 4, 4, 4])), ["root", "branch-0", "branch-1"], 800);
    const nodes = layout.nodes.slice(), scan = vi.spyOn(nodes, "filter");
    try {
      expect(boundedCompositionEdges(nodes, layout.width)).toEqual(layout.edges);
      expect(scan).toHaveBeenCalledTimes(1);
    } finally { scan.mockRestore(); }
  });
  it("does not build unused settled groups when every root child stays in the first row", () => {
    const doc = branching([1, 1, 2, 0, 120]);
    doc.nodes.push(node("nested", "leaf-0-0"), node("nested-leaf", "nested"));
    const layout = boundedTreeLayout(deriveEngineeringView(doc), ["root", "branch-0", "branch-1", "branch-2", "branch-4", "leaf-0-0", "nested"], 1450);
    expect(layout.nodes).toHaveLength(132);
    const settled = layout.nodes.slice(), scan = vi.spyOn(settled, "filter");
    try {
      expect(boundedCompositionEdges(layout.nodes, layout.width, settled, { groups: layout.groups })).toEqual(layout.edges);
      expect(scan).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  });
  it("defaults to root children and keeps an explicit collapsed root collapsed", () => {
    const view = deriveEngineeringView(document());
    expect(boundedTreeLayout(view, undefined, 800).nodes.map(n => n.id)).toEqual(["root", "a", "b"]);
    const collapsed = boundedTreeLayout(view, [], 800);
    expect(collapsed.nodes.map(n => n.id)).toEqual(["root"]); expect(collapsed.groups).toEqual([]);
  });
  it.each(["root", "a"])("honors explicit collapse while %s remains the requested scope", rootId => {
    const view = deriveEngineeringView(document());
    const opened = boundedTreeLayout(view, [rootId], 800, undefined, rootId);
    expect(opened.nodes.length).toBeGreaterThan(1);
    // Descendant expansion survives a parent toggle, but must not force that
    // parent open. This is the same input the persistent graph passes on Enter.
    for (const expanded of [[], rootId === "root" ? ["a", "task"] : ["root", "task"]]) {
      const collapsed = boundedTreeLayout(view, expanded, 800, opened.columns, rootId);
      expect(collapsed.rootId).toBe(rootId);
      expect(collapsed.nodes.map(n => n.id)).toEqual([rootId]);
      expect(collapsed.nodes[0]).toMatchObject({ parentId: null, depth: 0, expanded: false });
      expect(collapsed.edges).toEqual([]); expect(collapsed.groups).toEqual([]);
      expect(collapsed.signature).not.toBe(opened.signature);
      expect(boundedTreeLayout(view, [rootId], 800, collapsed.columns, rootId)).toEqual(opened);
    }
  });
  it("defaults a requested scope to its first level only when expansion is unspecified", () => {
    const view = deriveEngineeringView(document());
    for (const [rootId, ids] of [["root", ["root", "a", "b"]], ["a", ["a", "task"]]] as const) {
      const layout = boundedTreeLayout(view, undefined, 800, undefined, rootId);
      expect(layout.nodes.map(n => n.id)).toEqual(ids);
      expect(boundedTreeLayout(view, [rootId], 800, undefined, rootId)).toEqual(layout);
    }
  });
  it("keeps explicit root collapse when a missing or archived requested scope falls back", () => {
    const doc = document(); doc.nodes.find(n => n.id === "a")!.status = "archived";
    const view = deriveEngineeringView(doc);
    for (const requested of ["missing", "a"]) {
      expect(boundedTreeLayout(view, [], 800, undefined, requested)).toEqual(boundedTreeLayout(view, [], 800));
      expect(boundedTreeLayout(view, undefined, 800, undefined, requested).nodes.map(n => n.id)).toEqual(["root", "b"]);
    }
  });
  it("wraps siblings into rows at readable card size within the complete canvas budget", () => {
    const doc = document([node("root", null), ...Array.from({ length: 12 }, (_, i) => node("child-" + i, "root", { order: i }))]);
    const layout = boundedTreeLayout(deriveEngineeringView(doc), undefined, 800), children = layout.nodes.slice(1);
    expect(layout.columns).toBe(3);
    expect(new Set(children.map(n => n.y)).size).toBe(4);
    for (let row = 0; row < 4; row++) expect(children.slice(row * 3, row * 3 + 3).map(n => n.x)).toEqual([32, 296, 560]);
    expectSafeGeometry(layout, 800);
  });
  it("keeps the root anchored while complete expanded branches wrap without losing their children", () => {
    const view = deriveEngineeringView(branching()), before = boundedTreeLayout(view, undefined, 1250), after = boundedTreeLayout(view, ["root", "branch-2"], 1250);
    const found = positions(after);
    expect(found.get("root")).toEqual(positions(before).get("root"));
    const parent = after.nodes.find(n => n.id === "branch-2")!, kids = after.nodes.filter(n => n.parentId === parent.id);
    expect((kids[0].x + kids[1].x) / 2).toBe(parent.x);
    expect(kids.every(child => child.y > parent.y + parent.height)).toBe(true);
    expect(found.get("branch-4")!.y).toBeGreaterThan(kids[0].y + kids[0].height);
    expectSafeGeometry(after, 1250);
  });
  it("preserves the same sibling rows while each of five branches expands and collapses", () => {
    const view = deriveEngineeringView(branching([2, 2, 2, 3, 2]));
    const ids = Array.from({ length: 5 }, (_, index) => `branch-${index}`);
    for (const width of [390, 800, 1250, 1558]) {
      const before = boundedTreeLayout(view, ["root"], width), expected = siblingRows(before, "root");
      for (const expanded of ids.map(id => ["root", id]).concat([["root", ...ids], ["root"]])) {
        const after = boundedTreeLayout(view, expanded, width);
        expect(siblingRows(after, "root"), `${expanded.join(",")} at ${width}`).toEqual(expected);
        expect(positions(after).get("root")).toEqual(positions(before).get("root"));
        expectSafeGeometry(after, width);
      }
    }
    expect(siblingRows(boundedTreeLayout(view, ["root", ...ids], 800), "root")).toEqual([ids.slice(0, 3), ids.slice(3)]);
  });
  it("does not take an already open neighbour's columns when another branch expands", () => {
    const doc = branching([5, 5]);
    doc.nodes.push(...Array.from({ length: 8 }, (_, index) => node(`deep-${index}`, "leaf-1-0", { order: index })));
    const view = deriveEngineeringView(doc);
    for (const width of [800, 1250, 1600]) {
      const before = boundedTreeLayout(view, ["root", "branch-1", "leaf-1-0"], width);
      for (const expanded of [["root", "branch-0", "branch-1", "leaf-1-0"], ["root", "branch-1", "leaf-1-0"]]) {
        const after = boundedTreeLayout(view, expanded, width);
        for (const parent of ["root", "branch-1", "leaf-1-0"]) expect(siblingRows(after, parent), `${parent} at ${width}`).toEqual(siblingRows(before, parent));
        expectSafeGeometry(after, width);
      }
    }
  });
  it("does not allocate the visible width of unopened descendants to collapsed cards", () => {
    const small = boundedTreeLayout(deriveEngineeringView(branching([1, 1])), ["root"], 1600);
    const large = boundedTreeLayout(deriveEngineeringView(branching([120, 120])), ["root"], 1600);
    expect(positions(large)).toEqual(positions(small));
    expect(large.nodes[2].x - large.nodes[1].x).toBe(264);
    expect(large.height).toBe(small.height);
  });
  it("keeps parallel expanded branches in their original row and reserves the tallest subtree", () => {
    const view = deriveEngineeringView(branching([12, 9, 7, 2, 2]));
    const layout = boundedTreeLayout(view, ["root", "branch-0", "branch-1", "branch-2"], 800);
    const a = layout.nodes.filter(n => n.parentId === "branch-0"), b = layout.nodes.filter(n => n.parentId === "branch-1"), c = layout.nodes.filter(n => n.parentId === "branch-2");
    expect(siblingRows(layout, "root")).toEqual([["branch-0", "branch-1", "branch-2"], ["branch-3", "branch-4"]]);
    expect(b[0].y).toBe(a[0].y); expect(c[0].y).toBe(a[0].y);
    expect(layout.nodes.find(n => n.id === "branch-3")!.y).toBeGreaterThan(Math.max(...[...a, ...b, ...c].map(n => n.y + n.height)));
    expectSafeGeometry(layout, 800);
  });
  it("keeps every relationship in five simultaneously expanded product branches", () => {
    const view = deriveEngineeringView(branching([2, 2, 2, 3, 2]));
    for (const width of [1541, 1558, 1250, 1024, 800, 350]) {
      const layout = boundedTreeLayout(view, ["root", ...Array.from({ length: 5 }, (_, i) => "branch-" + i)], width);
      expect(layout.edges.map(e => e.to).sort(), `all links at width ${width}`).toEqual(layout.nodes.filter(n => n.parentId).map(n => n.id).sort());
      expectSafeGeometry(layout, width);
    }
  });
  it("enters first-row branch regions beyond their rounded corners", () => {
    const view = deriveEngineeringView(branching([2, 2, 2, 3, 2]));
    for (const width of [1558, 1096, 350]) {
      const layout = boundedTreeLayout(view, ["root", ...Array.from({ length: 5 }, (_, i) => "branch-" + i)], width);
      for (const group of layout.groups) {
        const children = layout.nodes.filter(n => n.parentId === group.id), firstY = Math.min(...children.map(n => n.y));
        for (const child of children.filter(n => n.y === firstY)) {
          const points = pathPoints(layout.edges.find(e => e.to === child.id)!.d);
          const crossings = points.slice(1).flatMap((b, i) => {
            const a = points[i];
            return a.x === b.x && a.y < group.y && b.y > group.y ? [a.x] : [];
          });
          expect(crossings, child.id).toHaveLength(1);
          expect(crossings[0]).toBeGreaterThan(group.x + 10);
          expect(crossings[0]).toBeLessThan(group.x + group.width - 10);
        }
      }
      expectSafeGeometry(layout, width);
    }
  });
  it("keeps wrapped root routes in clear side corridors instead of hugging branch bounds", () => {
    const view = deriveEngineeringView(branching([2, 2, 2, 3, 2, 2, 2]));
    for (const width of [1541, 1558]) {
      const layout = boundedTreeLayout(view, ["root", ...Array.from({ length: 7 }, (_, i) => "branch-" + i)], width);
      const rootChildren = layout.nodes.filter(n => n.parentId === "root"), firstChildY = Math.min(...rootChildren.map(n => n.y));
      const firstRow = rootChildren.filter(n => n.y === firstChildY), wrapped = rootChildren.filter(n => n.y > firstChildY);
      expect(firstRow.length).toBeGreaterThan(1); expect(wrapped.length).toBeGreaterThan(0);
      for (const node of wrapped) {
        const edge = boundedCompositionEdges(layout.nodes, layout.width).find(item => item.to === node.id)!;
        expect(edge.route).toBe("continuation");
        const path = pathPoints(edge.d), rail = path.slice(1).flatMap((b, index) => path[index]!.x === b.x ? [{ x: b.x, length: Math.abs(b.y - path[index]!.y) }] : []).sort((one, two) => two.length - one.length)[0]!.x;
        expect(rail).toBeGreaterThan(4); expect(rail).toBeLessThan(layout.width - 4);
        expect(path[1]!.y).toBeLessThan(firstRow[0]!.y);
        for (const region of layout.groups) {
        expect(Math.min(Math.abs(rail - region.x), Math.abs(rail - region.x - region.width))).toBeGreaterThanOrEqual(ROOT_CORRIDOR_CLEARANCE);
        }
      }
      expectSafeGeometry(layout, width);
    }
  });
  it("uses internal side corridors when available and a clear outer fallback at tablet width", () => {
    const view = deriveEngineeringView(branching([2, 2, 2, 3, 2, 2, 2]));
    for (const width of [1024, 1600]) {
      const layout = boundedTreeLayout(view, ["root", ...Array.from({ length: 7 }, (_, i) => "branch-" + i)], width);
      const rootChildren = layout.nodes.filter(item => item.parentId === "root"), firstY = Math.min(...rootChildren.map(item => item.y));
      const groupById = new Map(layout.groups.map(group => [group.id, group]));
      const spans = rootChildren.filter(item => item.y === firstY).map(item => {
        const group = groupById.get(item.id);
        return { left: Math.min(group?.x ?? Infinity, item.x - 8), right: Math.max(group ? group.x + group.width : -Infinity, item.x + item.width + 8) };
      }).sort((one, two) => one.left - two.left);
      const corridors = spans.slice(1).flatMap((span, index) => spans[index]!.right + ROOT_CORRIDOR_CLEARANCE * 2 <= span.left
        ? [{ left: spans[index]!.right, right: span.left }]
        : []);
      const wrapped = boundedCompositionEdges(layout.nodes, layout.width).filter(edge => edge.from === "root" && edge.route === "continuation");
      const rails = wrapped.map(edge => edge.points.slice(1).flatMap((b, index) => {
        const a = edge.points[index]!;
        return a.x === b.x ? [{ x: a.x, length: Math.abs(a.y - b.y) }] : [];
      }).sort((one, two) => two.length - one.length)[0]!);
      expect(wrapped.length, `wrapped root relationships at ${width}`).toBeGreaterThan(0);
      if (width >= 1600) {
        expect(corridors.length, `internal corridors at ${width}`).toBeGreaterThan(0);
        expect(rails.some(rail => corridors.some(corridor => rail.x >= corridor.left + ROOT_CORRIDOR_CLEARANCE && rail.x <= corridor.right - ROOT_CORRIDOR_CLEARANCE)), `an internal side rail at ${width}`).toBe(true);
      }
      for (const rail of rails) {
        const internal = corridors.some(corridor => rail.x >= corridor.left + ROOT_CORRIDOR_CLEARANCE && rail.x <= corridor.right - ROOT_CORRIDOR_CLEARANCE);
        const external = rail.x <= spans[0]!.left - COMPOSITION_BOUNDARY_CLEARANCE || rail.x >= spans.at(-1)!.right + COMPOSITION_BOUNDARY_CLEARANCE;
        expect(internal || external, `readable root rail ${rail.x} at ${width}`).toBe(true);
      }
      expectSafeGeometry(layout, width);
    }
  });
  it("emits one explicit visible segment for shared collinear geometry at responsive widths", () => {
    const view = deriveEngineeringView(branching([5, 4, 3, 2])), expanded = ["root", "branch-0", "branch-1", "branch-2", "branch-3"];
    for (const width of [390, 1024, 1600]) {
      const layout = boundedTreeLayout(view, expanded, width);
      const edges = boundedCompositionEdges(layout.nodes, layout.width), segments = boundedCompositionSegments(edges);
      expect(new Set(segments.map(segment => segment.d)).size, `unique visible geometry at ${width}`).toBe(segments.length);
      expect(new Set(segments.flatMap(segment => segment.edgeIds))).toEqual(new Set(edges.map(edge => edge.id)));
      expect(segments.some(segment => segment.kind === "bus" && segment.edgeIds.length > 1), `shared bus at ${width}`).toBe(true);
      expect(segments.every(segment => segment.contributors.length > 0)).toBe(true);
      expectNoVisibleSegmentOverlap(segments, `at ${width}`);
      expectSafeGeometry(layout, width);
    }
  });
  it("assigns stable unique ids when one source set appears in separated pieces", () => {
    const edge = (id: string, from: string, to: string, start: number, end: number): BoundedCompositionEdge => ({
      id, from, to, level: "trunk", route: "continuation",
      points: [{ x: 40, y: start }, { x: 40, y: end }],
      d: `M 40 ${start} L 40 ${end}`
    });
    const segments = boundedCompositionSegments([
      edge("parent-a>child-a", "parent-a", "child-a", 0, 30),
      edge("parent-b>child-b", "parent-b", "child-b", 10, 20)
    ]);
    const ids = segments.map(segment => segment.id);
    expect(segments.map(segment => segment.d)).toEqual(["M 40 0 L 40 10", "M 40 10 L 40 20", "M 40 20 L 40 30"]);
    expect(new Set(ids).size).toBe(segments.length);
    expect(ids[0]).not.toBe(ids[2]);
    expect(segments[0].contributors).toEqual(segments[2].contributors);
  });
  it("globally unions long mobile lanes shared by deep nodes in different branches", () => {
    const branchIds = Array.from({ length: 5 }, (_, branch) => `mobile-branch-${branch}`);
    const nodes = [node("root", null), ...branchIds.flatMap((id, branch) => [
      node(id, "root", { order: branch }),
      ...Array.from({ length: 4 }, (_, item) => node(`mobile-leaf-${branch}-${item}`, id, { order: item }))
    ])];
    nodes.push(...Array.from({ length: 6 }, (_, item) => node(`mobile-deep-${item}`, "mobile-leaf-0-0", { order: item })));
    nodes.push(node("mobile-deeper-parent", "mobile-deep-0"), ...Array.from({ length: 4 }, (_, item) => node(`mobile-deeper-${item}`, "mobile-deeper-parent", { order: item })));
    const expanded = ["root", ...branchIds, "mobile-leaf-0-0", "mobile-deep-0", "mobile-deeper-parent"];
    const layout = boundedTreeLayout(deriveEngineeringView(document(nodes)), expanded, 390);
    const edges = boundedCompositionEdges(layout.nodes, layout.width), segments = boundedCompositionSegments(edges);
    const crossParentBus = segments.find(segment => new Set(segment.edgeIds.map(id => id.slice(0, id.indexOf(">")))).size > 1);
    expect(crossParentBus?.kind).toBe("bus");
    expect(crossParentBus?.contributors.length).toBeGreaterThanOrEqual(crossParentBus?.edgeIds.length ?? Infinity);
    expectNoVisibleSegmentOverlap(segments, "in the 390px deep multi-branch fixture");
    expectSafeGeometry(layout, 390);
  });
  it("keeps every continuation lane clear of parallel branch and agent-like borders", () => {
    const view = deriveEngineeringView(branching([9, 6, 4, 3])), expanded = ["root", "branch-0", "branch-1", "branch-2", "branch-3"];
    for (const width of [390, 1024, 1600]) {
      const layout = boundedTreeLayout(view, expanded, width);
      const continuations = boundedCompositionEdges(layout.nodes, layout.width).filter(edge => edge.route === "continuation");
      expect(continuations.length, `continuations at ${width}`).toBeGreaterThan(0);
      for (const edge of continuations) {
        const a = edge.points[2]!, b = edge.points[3]!;
        expect(a.x, edge.id).toBe(b.x);
        for (const group of layout.groups) {
          const overlap = Math.min(Math.max(a.y, b.y), group.y + group.height) - Math.max(Math.min(a.y, b.y), group.y);
          if (overlap <= 1) continue;
          for (const inset of [0, 2]) expect(Math.min(Math.abs(a.x - group.x - inset), Math.abs(a.x - group.x - group.width + inset)), `${edge.id} near ${group.id} at ${width}`).toBeGreaterThanOrEqual(COMPOSITION_BOUNDARY_CLEARANCE);
        }
      }
      expectSafeGeometry(layout, width);
    }
  });
  it("uses the parent region perimeter consistently for later nested rows", () => {
    const view = deriveEngineeringView(branching([8, 2, 2]));
    for (const width of [350, 800]) {
      const layout = boundedTreeLayout(view, ["root", "branch-0", "branch-1"], width);
      const byId = new Map(layout.nodes.map(n => [n.id,n]));
      for (const parentId of ["branch-0"]) {
        const children = layout.nodes.filter(n => n.parentId === parentId), firstY = Math.min(...children.map(n => n.y));
        const region = layout.groups.find(g => g.id === parentId);
        for (const child of children.filter(n => n.y > firstY)) {
          const points = pathPoints(layout.edges.find(e => e.to === child.id)!.d), rail = points[2].x;
          const own = region ?? { x: Math.min(...layout.nodes.map(n=>n.x))-10, width: Math.max(...layout.nodes.map(n=>n.x+n.width))-Math.min(...layout.nodes.map(n=>n.x))+20 };
          expect(rail < own.x || rail > own.x + own.width, `${parentId}>${child.id} must leave through an outside lane`).toBe(true);
          expect(points[1].y).toBeLessThan(firstY);
          expect(points[0].x).toBe(byId.get(parentId)!.x + 104);
        }
      }
      expectSafeGeometry(layout, width);
    }
  });
  it("keeps the accepted corridor side while a lower node animates across the parent's centre", () => {
    const view = deriveEngineeringView(branching([2, 2, 2, 3, 2, 2, 2]));
    const layout = boundedTreeLayout(view, ["root", "branch-0", "branch-1", "branch-2"], 1558);
    const target = layout.nodes.find(n => n.id === "branch-5")!, parent = layout.nodes[0];
    expect(target.y).toBeGreaterThan(layout.nodes.find(n=>n.id==="branch-0")!.y);
    const firstSide = pathPoints(layout.edges.find(e => e.to === target.id)!.d)[2].x;
    for (const x of [parent.x - 30, parent.x, parent.x + 30]) {
      const frame = layout.nodes.map(n => n.id === target.id ? {...n,x} : n);
      const path = pathPoints(boundedCompositionEdges(frame, layout.width, layout.nodes).find(e=>e.to===target.id)!.d);
      expect(path[2].x < parent.x).toBe(firstSide < parent.x);
    }
  });
  it("routes between deep and wide neighbouring branches without dropping connections", () => {
    const doc = branching([1, 1, 2, 0, 120]);
    doc.nodes.push(node("nested", "leaf-0-0"), node("nested-leaf", "nested"));
    for (const width of [1433, 1007, 373]) {
      const layout = boundedTreeLayout(deriveEngineeringView(doc), ["root", "branch-0", "branch-1", "branch-2", "branch-4", "leaf-0-0", "nested"], width);
      expect(layout.edges.map(e => e.to).sort(), `all links at width ${width}`).toEqual(layout.nodes.filter(n => n.parentId).map(n => n.id).sort());
      expectSafeGeometry(layout, width);
    }
  });
  it("preserves five real levels, source order, and parent identity without depth indentation", () => {
    const layout = boundedTreeLayout(deriveEngineeringView(document()), ["root", "a", "task", "component", "b"], 350);
    expect(layout.nodes.map(n => n.id)).toEqual(["root", "a", "task", "component", "leaf", "b", "other"]);
    expect(layout.nodes.find(n => n.id === "leaf")).toMatchObject({ parentId: "component", depth: 4 });
    expect(new Set(layout.nodes.map(n => n.x)).size).toBe(1);
    expect(layout.groups.find(g => g.id === "a")).toMatchObject({ parentId: "root", childIds: ["task"], descendantIds: ["task", "component", "leaf"] });
    expectSafeGeometry(layout, 350);
  });
  it("retains every one of 120 children on narrow, medium, and wide canvases", () => {
    const doc = branching([120, 2, 2]), view = deriveEngineeringView(doc);
    for (const width of [350, 800, 1250]) {
      const layout = boundedTreeLayout(view, ["root", "branch-0", "branch-1", "branch-2"], width);
      expect(layout.nodes).toHaveLength(128); expect(layout.nodes.some(n => n.id === "leaf-0-119")).toBe(true);
      expectSafeGeometry(layout, width);
    }
  });
  it("handles 200 descendants across twenty simultaneously expanded branches without collisions", () => {
    const view = deriveEngineeringView(branching(Array(20).fill(9))), expanded = ["root", ...Array.from({ length: 20 }, (_, i) => "branch-" + i)];
    const layout = boundedTreeLayout(view, expanded, 1024);
    expect(layout.nodes).toHaveLength(201); expectSafeGeometry(layout, 1024);
    expect(boundedTreeLayout(view, expanded, 1024)).toEqual(layout);
  });
  it("keeps routed relationships and unique segments through a deeply expanded chain", () => {
    const nodes = [node("root", null)]; let parent = "root";
    for (let depth = 0; depth < 64; depth++) { const id = `deep-${depth}`; nodes.push(node(id, parent)); parent = id; }
    const view = deriveEngineeringView(document(nodes)), expanded = nodes.slice(0, -1).map(item => item.id);
    for (const width of [390, 1024, 1600]) {
      const layout = boundedTreeLayout(view, expanded, width), edges = boundedCompositionEdges(layout.nodes, layout.width);
      expect(layout.nodes).toHaveLength(nodes.length); expect(edges).toHaveLength(nodes.length - 1);
      expect(new Set(boundedCompositionSegments(edges).map(segment => segment.id)).size).toBe(boundedCompositionSegments(edges).length);
      expectSafeGeometry(layout, width);
    }
  });
  it("restores exactly the same geometry after arbitrary expand-collapse cycles", () => {
    const view = deriveEngineeringView(branching()), expanded = ["root", "branch-0", "branch-2"], initial = boundedTreeLayout(view, expanded, 800);
    for (let i = 0; i < 5; i++) {
      boundedTreeLayout(view, ["root", "branch-0", "branch-1", "branch-2", "branch-3"], 800);
      expect(boundedTreeLayout(view, expanded, 800)).toEqual(initial);
    }
    const narrowed = boundedTreeLayout(view, expanded, 350);
    expectSafeGeometry(narrowed, 350);
    expect(boundedTreeLayout(view, expanded, 800)).toEqual(initial);
  });
  it("requires a spare gutter to add a responsive column and immediately removes columns that no longer fit", () => {
    const view = deriveEngineeringView(document());
    expect(boundedTreeLayout(view, undefined, 528).columns).toBe(2);
    expect(boundedTreeLayout(view, undefined, 528, 1).columns).toBe(1);
    expect(boundedTreeLayout(view, undefined, 583, 1).columns).toBe(1);
    expect(boundedTreeLayout(view, undefined, 584, 1).columns).toBe(2);
    expect(boundedTreeLayout(view, undefined, 527, 2).columns).toBe(1);
    expect(boundedTreeLayout(view, undefined, 528, 0).columns).toBe(2);
    expect(boundedTreeLayout(view, undefined, 528, 1).signature).not.toBe(boundedTreeLayout(view, undefined, 528, 2).signature);
  });
  it("is unchanged by titles, statuses, evidence and cross-tree dependencies", () => {
    const doc = document(), before = boundedTreeLayout(deriveEngineeringView(doc), ["root", "a"], 800);
    doc.nodes[1].title = "这是需要保留所属关系和成果含义的超长中文模块名称".repeat(20); doc.nodes[1].status = "blocked"; doc.nodes[2].dependencies = ["leaf"];
    expect(boundedTreeLayout(deriveEngineeringView(doc), ["root", "a"], 800)).toEqual(before);
  });
  it("excludes archived branches including their still-active descendants", () => {
    const doc = document(); doc.nodes[1].status = "archived";
    const layout = boundedTreeLayout(deriveEngineeringView(doc), ["root", "a", "task", "component", "missing"], 800);
    expect(layout.nodes.map(n => n.id)).toEqual(["root", "b"]); expectSafeGeometry(layout, 800);
    doc.nodes[0].status = "archived";
    expect(boundedTreeLayout(deriveEngineeringView(doc), undefined, 800).nodes).toEqual([]);
  });
  it("derives animation paths from displayed coordinates and suppresses impossible overlapping transitions", () => {
    const layout = boundedTreeLayout(deriveEngineeringView(document()), undefined, 800);
    const moving = layout.nodes.map(n => ({ ...n, x: n.x + 1.5, y: n.y + 12.25 }));
    const movingEdges = boundedCompositionEdges(moving, 804), [edge] = movingEdges, parent = moving[0], child = moving.find(n => n.id === edge.to)!;
    expect(pathPoints(edge.d)[0]).toEqual({ x: parent.x + 104, y: parent.y + 120 });
    expect(pathPoints(edge.d).at(-1)).toEqual({ x: child.x + 104, y: child.y });
    expect(boundedCompositionSegments(movingEdges).map(segment => segment.id)).toEqual(boundedCompositionSegments(layout.edges as ReturnType<typeof boundedCompositionEdges>).map(segment => segment.id));
    expect(boundedCompositionEdges([parent, { ...child, x: parent.x, y: parent.y }], 804)).toEqual([]);
  });
  it("uses a finite minimum canvas before measurement without shrinking readable cards", () => {
    const view = deriveEngineeringView(document());
    for (const width of [0, -10, NaN, Infinity]) {
      const layout = boundedTreeLayout(view, undefined, width);
      expect(layout.width).toBe(264); expectSafeGeometry(layout, 264);
    }
  });
});
