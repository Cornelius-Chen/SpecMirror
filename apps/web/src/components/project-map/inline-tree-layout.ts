import type { EngineeringView } from "@epm/domain";
import { effectiveDependencyLinks, overviewIndex, type DependencyLink } from "../engineering/overview-selectors.ts";

export const INLINE_NODE_WIDTH = 208;
export const INLINE_NODE_HEIGHT = 188;
const COLUMN_GAP = 24, LEVEL_GAP = 56, MARGIN = 28;
export interface InlineTreeNode { id: string; parentId: string | null; depth: number; x: number; y: number; width: number; height: number; childCount: number; expanded: boolean }
export interface InlineTreeEdge { id: string; from: string; to: string; d: string }
export interface InlineTreeLayout { rootId: string; nodes: InlineTreeNode[]; edges: InlineTreeEdge[]; width: number; height: number; signature: string }

/** The closest ordered positions, obtained by pooling only neighbouring conflicts. */
function orderedPositions(preferred: number[]): number[] {
  const blocks: Array<{ start: number; end: number; total: number; count: number }> = [];
  for (const [i, value] of preferred.entries()) {
    blocks.push({ start: i, end: i + 1, total: value, count: 1 });
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2], b = blocks[blocks.length - 1];
      if (a.total / a.count <= b.total / b.count) break;
      blocks.splice(-2, 2, { start: a.start, end: b.end, total: a.total + b.total, count: a.count + b.count });
    }
  }
  const result: number[] = [];
  for (const block of blocks) for (let i = block.start; i < block.end; i++) result[i] = block.total / block.count;
  return result;
}

/** Keep old rows still when possible, then fit new children into the available gaps. */
function retainPositions(nodes: InlineTreeNode[], previous: InlineTreeLayout): number {
  const old = new Map(previous.nodes.map(node => [node.id, node])), byId = new Map(nodes.map(node => [node.id, node]));
  const rows = new Map<number, InlineTreeNode[]>(), siblings = new Map<string, InlineTreeNode[]>();
  for (const node of nodes) {
    const row = rows.get(node.depth) ?? []; row.push(node); rows.set(node.depth, row);
    if (node.parentId) { const group = siblings.get(node.parentId) ?? []; group.push(node); siblings.set(node.parentId, group); }
  }
  const pitch = INLINE_NODE_WIDTH + COLUMN_GAP;
  const offsets = new Map<string, number>();
  for (const group of siblings.values()) for (const [i, node] of group.entries()) offsets.set(node.id, (i - (group.length - 1) / 2) * pitch);
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    const anchors = row.flatMap((node, i) => {
      const found = old.get(node.id);
      return found && found.depth === node.depth && found.parentId === node.parentId && Number.isFinite(found.x) ? [{ i, x: found.x }] : [];
    });
    // Subtracting the required spacing turns non-overlap into a simple ordering
    // constraint. Old nodes take priority over centring the newly revealed row.
    const positions = orderedPositions(anchors.map(anchor => anchor.x - anchor.i * pitch));
    for (const [j, anchor] of anchors.entries()) row[anchor.i].x = positions[j] + anchor.i * pitch;
    const boundaries = [{ i: -1, value: -Infinity }, ...anchors.map((anchor, j) => ({ i: anchor.i, value: positions[j] })), { i: row.length, value: Infinity }];
    for (let j = 1; j < boundaries.length; j++) {
      const left = boundaries[j - 1], right = boundaries[j], first = left.i + 1;
      const preferred = row.slice(first, right.i).map((node, offset) => {
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        const desired = parent ? parent.x + (offsets.get(node.id) ?? 0) : node.x;
        return desired - (first + offset) * pitch;
      });
      for (const [offset, value] of orderedPositions(preferred).entries()) row[first + offset].x = Math.max(left.value, Math.min(right.value, value)) + (first + offset) * pitch;
    }
  }
  // Coordinates must stay scrollable. The component compensates this uniform
  // translation in its camera rather than presenting it as a branch movement.
  const shift = Math.max(0, MARGIN - Math.min(...nodes.map(node => node.x)));
  if (shift) for (const node of nodes) node.x += shift;
  return shift;
}

/** Also accepts interpolated nodes so animated lines stay attached to their cards. */
export function compositionEdges(nodes: readonly InlineTreeNode[]): InlineTreeEdge[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return nodes.flatMap(node => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined; if (!parent) return [];
    const a = { x: parent.x + parent.width / 2, y: parent.y + parent.height }, b = { x: node.x + node.width / 2, y: node.y };
    return [{ id: parent.id + ">" + node.id, from: parent.id, to: node.id, d: `M ${a.x} ${a.y} V ${(a.y + b.y) / 2} H ${b.x} V ${b.y}` }];
  });
}

/** Only declared containment and the externally accepted expansion set affect layout. */
export function inlineTreeLayout(view: EngineeringView, expandedNodeIds?: readonly string[], previous?: InlineTreeLayout): InlineTreeLayout {
  const index = overviewIndex(view), rootId = view.document.root_id;
  const expanded = new Set(expandedNodeIds ?? [rootId]), root = index.nodes.get(rootId);
  if (!root || root.status === "archived") return { rootId, nodes: [], edges: [], width: 0, height: 0, signature: rootId };
  const entries: Array<{ id: string; parentId: string | null; depth: number; children: string[] }> = [];
  const stack = [{ id: rootId, parentId: null as string | null, depth: 0 }], seen = new Set<string>();
  while (stack.length) {
    const item = stack.pop()!; if (seen.has(item.id)) continue; seen.add(item.id);
    const children = expanded.has(item.id) ? (index.children.get(item.id) ?? []).map(node => node.id).filter(id => !seen.has(id)) : [];
    entries.push({ ...item, children });
    for (const id of [...children].reverse()) stack.push({ id, parentId: item.id, depth: item.depth + 1 });
  }
  const widths = new Map<string, number>();
  for (const item of [...entries].reverse()) widths.set(item.id, Math.max(INLINE_NODE_WIDTH, item.children.reduce((total, id) => total + (widths.get(id) ?? INLINE_NODE_WIDTH), 0) + Math.max(0, item.children.length - 1) * COLUMN_GAP));
  const starts = new Map([[rootId, MARGIN]]), nodes: InlineTreeNode[] = [];
  for (const item of entries) {
    const start = starts.get(item.id) ?? MARGIN, span = widths.get(item.id)!;
    nodes.push({ id: item.id, parentId: item.parentId, depth: item.depth, x: start + (span - INLINE_NODE_WIDTH) / 2, y: MARGIN + item.depth * (INLINE_NODE_HEIGHT + LEVEL_GAP), width: INLINE_NODE_WIDTH, height: INLINE_NODE_HEIGHT, childCount: index.children.get(item.id)?.length ?? 0, expanded: expanded.has(item.id) && Boolean(item.children.length) });
    let cursor = start; for (const id of item.children) { starts.set(id, cursor); cursor += (widths.get(id) ?? INLINE_NODE_WIDTH) + COLUMN_GAP; }
  }
  const retained = previous?.rootId === rootId && previous.nodes.length ? previous : undefined;
  const shift = retained ? retainPositions(nodes, retained) : 0;
  return { rootId, nodes, edges: compositionEdges(nodes), width: Math.max(retained ? retained.width + shift : 0, ...nodes.map(node => node.x + node.width + MARGIN)), height: Math.max(retained?.height ?? 0, ...nodes.map(node => node.y + node.height + MARGIN)), signature: entries.map(item => item.id + ":" + item.children.join(",")).join("|") };
}

/** Dependencies remain a separate relationship type; they never open or arrange a branch. */
export function inlineTreeRelations(view: EngineeringView, layout: InlineTreeLayout): DependencyLink[] {
  const index = overviewIndex(view), relations = new Map<string, DependencyLink>();
  for (const node of layout.nodes) for (const relation of effectiveDependencyLinks(index, node.id)) relations.set(relation.id, relation);
  return [...relations.values()];
}
