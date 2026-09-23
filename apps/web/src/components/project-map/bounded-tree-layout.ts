import type { EngineeringView } from "@epm/domain";
import { overviewIndex } from "../engineering/overview-selectors.ts";
import { INLINE_NODE_WIDTH, type InlineTreeEdge, type InlineTreeLayout, type InlineTreeNode } from "./inline-tree-layout.ts";

// Two 10px group pads plus an 18px continuation lane clearance on either
// side need a 56px card gutter when expanded sibling branches stay parallel.
const MARGIN = 28, COLUMN_GAP = 56, ROW_GAP = 56;
export const BOUNDED_NODE_HEIGHT = 120;
export const BOUNDED_TREE_MIN_WIDTH = INLINE_NODE_WIDTH + MARGIN * 2;
export const COMPOSITION_LANE_CLEARANCE = 18;
export const COMPOSITION_BOUNDARY_CLEARANCE = 16;
export const ROOT_CORRIDOR_CLEARANCE = 12;
export interface BoundedTreeGroup {
  /** The real parent whose children this presentation region contains. */
  id: string; parentId: string | null; x: number; y: number; width: number; height: number;
  childIds: string[]; descendantIds: string[];
}
export interface BoundedTreeLayout extends InlineTreeLayout { groups: BoundedTreeGroup[]; columns: number }
interface Point { x: number; y: number }
interface Rect { left: number; right: number; top: number; bottom: number }
export type BoundedCompositionLevel = "trunk" | "branch";
export type BoundedCompositionRoute = "direct" | "continuation";
export interface BoundedCompositionEdge extends InlineTreeEdge {
  points: readonly Point[];
  level: BoundedCompositionLevel;
  route: BoundedCompositionRoute;
}
export interface BoundedCompositionSegment {
  id: string;
  parentId: string;
  a: Point;
  b: Point;
  d: string;
  contributors: string[];
  edgeIds: string[];
  level: BoundedCompositionLevel;
  route: BoundedCompositionRoute;
  kind: "bus" | "connector";
}
export interface BoundedCompositionRoutingOptions {
  /** Actual presentation regions for this frame. Omitted by settled callers. */
  groups?: readonly BoundedTreeGroup[];
  /** Visible labels share the same geometry clock as cards and regions. */
  labelObstacles?: readonly { left: number; right: number; top: number; bottom: number }[];
  /** World-space distance used for outside lanes. The map supplies a
   * scale-adjusted value so the visible corridor stays readable after fit. */
  laneClearance?: number;
  /** World-space clearance reserved on both sides of a root corridor. */
  rootCorridorClearance?: number;
  /** Wrapped root links may enter a branch card from its nearest side. This
   * avoids drawing the final approach beside the branch region's top edge. */
  wrappedRootSideEntry?: boolean;
  /** Keep aligned continuation links on one dedicated side so another visual
   * relation family can use the opposite channel on very narrow canvases. */
  alignedLaneSide?: "left" | "right";
}
const epsilon = 0.001;

/** Regions follow real containment; unrelated subtrees never share their space. */
export function boundedBranchGroups(nodes: readonly InlineTreeNode[], width: number): BoundedTreeGroup[] {
  const children = new Map<string, InlineTreeNode[]>();
  for (const node of nodes) if (node.parentId) children.set(node.parentId, [...children.get(node.parentId) ?? [], node]);
  const descendants = new Map<string, InlineTreeNode[]>();
  for (const node of [...nodes].sort((a, b) => b.depth - a.depth)) descendants.set(node.id, (children.get(node.id) ?? []).flatMap(child => [child, ...descendants.get(child.id) ?? []]));
  return nodes.filter(parent => parent.parentId && children.has(parent.id)).map(parent => {
    const members = descendants.get(parent.id)!;
    // Ten pixels of padding fit inside the 24px gutter between separate branches.
    const x = Math.max(8, Math.min(...members.map(n => n.x)) - 10);
    const right = Math.min(width - 8, Math.max(...members.map(n => n.x + n.width)) + 10);
    const y = Math.min(...members.map(n => n.y)) - 36;
    return { id: parent.id, parentId: parent.parentId, x, y, width: right - x,
      height: Math.max(...members.map(n => n.y + n.height)) + 12 - y,
      childIds: children.get(parent.id)!.map(n => n.id), descendantIds: members.map(n => n.id) };
  });
}

function crosses(a: Point, b: Point, rect: Rect): boolean {
  if (Math.abs(a.y - b.y) < epsilon) return a.y > rect.top + epsilon && a.y < rect.bottom - epsilon && Math.max(a.x, b.x) > rect.left + epsilon && Math.min(a.x, b.x) < rect.right - epsilon;
  return a.x > rect.left + epsilon && a.x < rect.right - epsilon && Math.max(a.y, b.y) > rect.top + epsilon && Math.min(a.y, b.y) < rect.bottom - epsilon;
}

/**
 * Adjacent rows use a short bus. Root links to later rows use stable gutters
 * between first-row branches; nested links leave through their parent's local
 * perimeter. Both choices preserve identity while avoiding cards and captions.
 */
export function boundedCompositionEdges(nodes: readonly InlineTreeNode[], availableWidth?: number, settledNodes: readonly InlineTreeNode[] = nodes, options: BoundedCompositionRoutingOptions = {}): BoundedCompositionEdge[] {
  if (!nodes.length) return [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const width = availableWidth ?? Math.max(...nodes.map(node => node.x + node.width)) + MARGIN;
  const cards = nodes.map(node => ({ left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + node.height }));
  const groups = options.groups ?? boundedBranchGroups(nodes, width);
  const settledById = settledNodes === nodes ? byId : new Map(settledNodes.map(node => [node.id, node]));
  let settledGroupById: Map<string, BoundedTreeGroup> | undefined;
  const firstChildY = new Map<string, number>();
  const settledChildren = new Map<string, InlineTreeNode[]>();
  for (const node of settledNodes) if (node.parentId) {
    firstChildY.set(node.parentId, Math.min(firstChildY.get(node.parentId) ?? Infinity, node.y));
    const children = settledChildren.get(node.parentId);
    if (children) children.push(node); else settledChildren.set(node.parentId, [node]);
  }
  // This index preserves Array.find's first-match semantics. Every region and
  // obstacle below belongs to this call's actual frame, never a retained frame.
  const groupById = new Map<string, BoundedTreeGroup>();
  const regionObstacles = groups.map(group => {
    if (!groupById.has(group.id)) groupById.set(group.id, group);
    return { id: group.id, descendants: new Set(group.descendantIds),
      caption: { left: group.x + 20, right: group.x + group.width - 20, top: group.y - 11, bottom: group.y + 11 },
      solid: { left: group.x, right: group.x + group.width, top: group.y - 11, bottom: group.y + group.height } };
  });
  const commonObstacles = [...cards, ...(options.labelObstacles ?? [])];
  // Wrapped routes use a real lane outside presentation bounds. Branch groups
  // extend 10px beyond their cards and Agent regions use a similar 8px pad, so
  // eighteen clear pixels keeps the route visually separate from either border
  // and its halo, including when several continuations share the same side rail.
  const laneClearance = Math.max(COMPOSITION_LANE_CLEARANCE, options.laneClearance ?? COMPOSITION_LANE_CLEARANCE);
  const rootCorridorClearance = Math.max(ROOT_CORRIDOR_CLEARANCE, options.rootCorridorClearance ?? ROOT_CORRIDOR_CLEARANCE);
  const leftBound = Math.min(...nodes.map(node => node.x - 8), ...groups.map(group => group.x));
  const rightBound = Math.max(...nodes.map(node => node.x + node.width + 8), ...groups.map(group => group.x + group.width));
  const leftLane = Math.max(4, leftBound - laneClearance);
  const rightLane = Math.min(width - 4, rightBound + laneClearance);
  const clearsEveryGroupBoundary = (x: number) => groups.every(group =>
    Math.min(Math.abs(x - group.x), Math.abs(x - group.x - group.width)) + epsilon >= rootCorridorClearance);
  // First-row spans are shared by all wrapped children of the same parent.
  // Only their final distance ordering depends on the individual target.
  const corridorsByParent = new Map<string, number[]>();
  const rootCorridorsFor = (parentId: string) => {
    const existing = corridorsByParent.get(parentId);
    if (existing) return existing;
    // Reference groups only inform wrapped root lanes. A one-row root needs
    // none, even when one of its branches contains many displayed descendants.
    settledGroupById ??= new Map((settledNodes === nodes && !options.groups ? groups : boundedBranchGroups(settledNodes, width)).map(group => [group.id, group]));
    const firstY = firstChildY.get(parentId) ?? Infinity;
    const spans = (settledChildren.get(parentId) ?? []).filter(item => Math.abs(item.y - firstY) < epsilon).map(item => {
      const group = settledGroupById!.get(item.id);
      // Collapsed Agent outlines also reserve eight pixels around their cards.
      return { left: Math.min(group?.x ?? Infinity, item.x - 8), right: Math.max(group ? group.x + group.width : -Infinity, item.x + item.width + 8) };
    }).sort((one, two) => one.left - two.left);
    const corridors = spans.slice(1).flatMap((span, index) => spans[index]!.right + rootCorridorClearance * 2 <= span.left ? [(spans[index]!.right + span.left) / 2] : []).filter(clearsEveryGroupBoundary);
    corridorsByParent.set(parentId, corridors);
    return corridors;
  };
  const clear = (points: Point[], obstacles: Rect[]) => {
    for (let i = 1; i < points.length; i++) for (const rect of obstacles) if (crosses(points[i - 1], points[i], rect)) return false;
    return true;
  };
  return nodes.flatMap(node => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!parent) return [];
    const obstacles = [...commonObstacles, ...regionObstacles.map(group => {
      const related = group.id === parent.id || group.id === node.id || group.descendants.has(parent.id) || group.descendants.has(node.id);
      // Match the caption's 20px inset in project-map.css. The two clear side
      // channels enter beyond the 10px corner radius without crossing controls.
      // Containment may enter its own region below that strip; other regions are solid obstacles.
      return related ? group.caption : group.solid;
    })];
    const a = { x: parent.x + parent.width / 2, y: parent.y + parent.height }, b = { x: node.x + node.width / 2, y: node.y };
    // Entering nested cards can momentarily coincide with their nearest visible
    // ancestor. Wait for an actual gap instead of drawing through those cards.
    if (b.y < a.y + epsilon) return [];
    const settled = settledById.get(node.id) ?? node, settledParent = settledById.get(parent.id) ?? parent;
    const wrapped = settled.y > (firstChildY.get(parent.id) ?? settled.y) + epsilon;
    const gap = b.y - a.y;
    // The branch region begins twenty world pixels below its parent card. At
    // the readable auto-fit floor, the old fixed four-pixel drop left the
    // horizontal departure only 6.7 screen pixels from that border. Adaptive
    // routes therefore leave directly from the card edge; the ordinary card
    // clearance still protects legacy callers that do not request it.
    const nearA = options.alignedLaneSide ? a.y : a.y + Math.min(4, gap / 3);
    const directRootDrop = gap >= 24 ? Math.min(40, gap - 12) : gap / 3;
    const nearB = b.y - (!wrapped && parent.depth === 0 ? directRootDrop : Math.min(10, gap / 3));
    const direct: Point[][] = [
      [a, { x: a.x, y: nearB }, { x: b.x, y: nearB }, b],
      [a, { x: a.x, y: nearA }, { x: b.x, y: nearA }, b],
    ];
    const own = groupById.get(parent.id);
    const sidePath = (x: number): Point[] => [a, { x: a.x, y: nearA }, { x, y: nearA }, { x, y: nearB }, { x: b.x, y: nearB }, b];
    const wrappedRootPath = (x: number): Point[] => {
      if (!options.wrappedRootSideEntry || parent.depth !== 0) return sidePath(x);
      const source = { x: x <= a.x ? parent.x : parent.x + parent.width, y: parent.y + parent.height / 2 };
      const target = { x: x <= b.x ? node.x : node.x + node.width, y: node.y + node.height / 2 };
      return [source, { x, y: source.y }, { x, y: target.y }, target];
    };
    // A local perimeter stays out of nested child regions. Root links prefer
    // the stable first-row corridors calculated below.
    const perimeter = own ? [Math.max(4, own.x - laneClearance), Math.min(width - 4, own.x + own.width + laneClearance)] : [leftLane, rightLane];
    // Use the accepted layout to choose sides; interpolation must not flip a
    // connection when its moving target passes through the parent's centre.
    const settledDelta = settled.x + settled.width / 2 - settledParent.x - settledParent.width / 2;
    const alignedSide = options.alignedLaneSide === "left" ? 0 : options.alignedLaneSide === "right" ? 1 : parent.depth % 2;
    const preferredSide = Math.abs(settledDelta) <= epsilon ? alignedSide : settledDelta < 0 ? 0 : 1;
    // Reject a lane which clears its own group only by entering the narrow
    // gutter beside a sibling group. That was the source of the apparently
    // doubled Agent-zone borders: the route was legal with respect to cards,
    // but only 4-7 screen pixels from the adjacent region outline. The global
    // outer rails are stable fallbacks when no local gutter is readable.
    const globalOutside = preferredSide === 0 ? [leftLane, rightLane] : [rightLane, leftLane];
    const outside = [...new Set([perimeter[preferredSide], perimeter[1 - preferredSide], ...globalOutside])]
      .filter(clearsEveryGroupBoundary);
    const rootCorridors = wrapped && parent.depth === 0 ? rootCorridorsFor(parent.id).slice()
      .sort((one, two) => Math.abs(settled.x + settled.width / 2 - one) - Math.abs(settled.x + settled.width / 2 - two)) : [];
    const entry = own ?? groupById.get(node.id);
    // These are two deliberate holes beside the 20px caption inset. Keep them
    // fixed when screen-space outside lanes grow; moving them inward would put
    // a connector through the caption and can make an otherwise valid child
    // relationship disappear.
    const entryLanes = entry ? [entry.x + COMPOSITION_LANE_CLEARANCE, entry.x + entry.width - COMPOSITION_LANE_CLEARANCE] : [];
    const lanes = [...new Set([Math.max(4, Math.min(parent.x, node.x) - 20), Math.min(width - 4, Math.max(parent.x + parent.width, node.x + node.width) + 20), leftLane, rightLane])]
      .filter(x => groups.every(group => Math.min(Math.abs(x - group.x), Math.abs(x - group.x - group.width)) + epsilon >= laneClearance))
      .sort((x, y) => Math.abs(a.x - x) + Math.abs(b.x - x) - Math.abs(a.x - y) - Math.abs(b.x - y));
    // Root links to later rows first use the nearest clear gutter between
    // branches. Reserving the complete canvas perimeter for them made several
    // links combine into a large rectangular frame that looked like another
    // containment boundary. Nested parents still use their own local perimeter.
    // A very deep map can be height-limited enough that no lane satisfies the
    // preferred screen-space clearance inside the fixed world bounds. Retain a
    // final collision-checked perimeter route in that case: a close but valid
    // relation is preferable to silently dropping a required parent link.
    const perimeterFallback = [perimeter[preferredSide], perimeter[1 - preferredSide]];
    // A real Agent title can occupy the strip above its card. If top entry is
    // obstructed, approach the card's side through the same checked corridors.
    // This changes only presentation ports, never parent-child membership.
    const labelledSideEntry = (x: number): Point[] => {
      const target = { x: x < node.x + node.width / 2 ? node.x : node.x + node.width, y: node.y + node.height / 2 };
      return [a, { x: a.x, y: nearA }, { x, y: nearA }, { x, y: target.y }, target];
    };
    const candidates = wrapped
      ? parent.depth === 0 ? [...rootCorridors.map(wrappedRootPath), ...outside.map(wrappedRootPath), ...lanes.map(wrappedRootPath), ...perimeterFallback.map(wrappedRootPath), ...direct] : [...outside.map(sidePath), ...lanes.map(sidePath), ...perimeterFallback.map(sidePath), ...direct]
      : [...direct, ...(options.alignedLaneSide ? outside.map(sidePath) : []), ...entryLanes.map(sidePath), ...lanes.map(sidePath)];
    if (options.labelObstacles?.length) {
      const targetPerimeter = [
        Math.max(4, Math.min(node.x - 8, entry?.x ?? Infinity) - laneClearance),
        Math.min(width - 4, Math.max(node.x + node.width + 8, entry ? entry.x + entry.width : -Infinity) + laneClearance)
      ].filter(clearsEveryGroupBoundary);
      candidates.push(...[...new Set([...targetPerimeter, ...outside, ...lanes, ...perimeterFallback])].map(labelledSideEntry));
    }
    const points = candidates.find(points => clear(points, obstacles));
    if (!points) return [];
    return [{ id: parent.id + ">" + node.id, from: parent.id, to: node.id, points,
      level: parent.depth === 0 ? "trunk" : "branch", route: wrapped ? "continuation" : "direct",
      d: points.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" ") }];
  });
}

interface RawCompositionSegment {
  edgeId: string;
  sourceId: string;
  parentId: string;
  axis: "horizontal" | "vertical";
  fixed: number;
  start: number;
  end: number;
  level: BoundedCompositionLevel;
  route: BoundedCompositionRoute;
}

const compositionSegmentEpsilon = 0.1;
const coordinateKey = (value: number) => Math.round(value / compositionSegmentEpsilon) * compositionSegmentEpsilon;
const uniqueCoordinates = (values: readonly number[]) => values.slice().sort((a, b) => a - b).filter((value, index, sorted) => !index || value - sorted[index - 1]! > compositionSegmentEpsilon);

/**
 * Turns complete relationship geometry into a visible segment layer. Collinear
 * overlap is split into maximal non-overlapping pieces across the complete tree,
 * so even long lanes shared by different parents have one visible DOM path.
 */
export function boundedCompositionSegments(edges: readonly BoundedCompositionEdge[]): BoundedCompositionSegment[] {
  const bins = new Map<string, { axis: RawCompositionSegment["axis"]; fixed: number; segments: RawCompositionSegment[] }>();
  for (const edge of edges) for (let index = 1; index < edge.points.length; index++) {
    const a = edge.points[index - 1]!, b = edge.points[index]!;
    const vertical = Math.abs(a.x - b.x) <= epsilon, horizontal = Math.abs(a.y - b.y) <= epsilon;
    if ((!vertical && !horizontal) || (vertical && horizontal)) continue;
    const axis = vertical ? "vertical" : "horizontal";
    const fixed = vertical ? a.x : a.y;
    const start = Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x), end = Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x);
    if (end - start <= epsilon) continue;
    const snappedFixed = coordinateKey(fixed), key = `${axis}|${snappedFixed}`;
    const bin = bins.get(key) ?? { axis, fixed: snappedFixed, segments: [] };
    bin.segments.push({ edgeId: edge.id, sourceId: `${edge.id}:${index - 1}`, parentId: edge.from, axis, fixed, start, end, level: edge.level, route: edge.route });
    bins.set(key, bin);
  }

  const visible: BoundedCompositionSegment[] = [];
  for (const bin of bins.values()) {
    const boundaries = uniqueCoordinates(bin.segments.flatMap(segment => [segment.start, segment.end]));
    const pieces: Array<{ start: number; end: number; contributors: RawCompositionSegment[]; sources: string[]; edgeIds: string[] }> = [];
    for (let index = 1; index < boundaries.length; index++) {
      const start = boundaries[index - 1]!, end = boundaries[index]!;
      if (end - start <= epsilon) continue;
      const contributors = bin.segments.filter(segment => segment.start < end - compositionSegmentEpsilon && segment.end > start + compositionSegmentEpsilon);
      if (!contributors.length) continue;
      const edgeIds = [...new Set(contributors.map(segment => segment.edgeId))].sort();
      const sources = [...new Set(contributors.map(segment => segment.sourceId))].sort();
      const previous = pieces.at(-1);
      if (previous && previous.end === start && previous.sources.join("|") === sources.join("|")) previous.end = end;
      else pieces.push({ start, end, contributors, sources, edgeIds });
    }
    const occurrences = new Map<string, number>();
    for (const piece of pieces) {
      // A shared segment remains a continuation lane when any wrapped edge
      // contributes to it. Otherwise its one visible DOM segment disappears
      // from continuation-lane inspection merely because a direct edge reuses
      // part of the same corridor.
      const route = piece.contributors.some(segment => segment.route === "continuation") ? "continuation" : "direct";
      const ordered = piece.contributors.slice().sort((one, two) => one.sourceId.localeCompare(two.sourceId));
      const a = bin.axis === "vertical" ? { x: bin.fixed, y: piece.start } : { x: piece.start, y: bin.fixed };
      const b = bin.axis === "vertical" ? { x: bin.fixed, y: piece.end } : { x: piece.end, y: bin.fixed };
      const signature = `${bin.axis}:${piece.sources.join("+")}`, occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      visible.push({ id: `composition:segment:${signature}:${occurrence}`, parentId: ordered[0]!.parentId, a, b,
        d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, contributors: piece.sources, edgeIds: piece.edgeIds,
        level: piece.contributors.some(segment => segment.level === "trunk") ? "trunk" : "branch", route,
        kind: piece.edgeIds.length > 1 ? "bus" : "connector" });
    }
  }
  return visible;
}

/**
 * Keep sibling row membership independent of expansion. Every row reserves
 * one column per sibling first; stable shares of its spare columns can widen
 * expanded branches. Collapsed branches consume only one actual column, while
 * complete subtree heights keep later rows below their contents.
 */
export function boundedTreeLayout(view: EngineeringView, expandedNodeIds: readonly string[] | undefined, availableWidth: number, previousColumns?: number, requestedRootId?: string | null): BoundedTreeLayout {
  const index = overviewIndex(view);
  const requestedRoot = requestedRootId ? index.nodes.get(requestedRootId) : undefined;
  const rootId = requestedRoot && requestedRoot.status !== "archived" ? requestedRoot.id : view.document.root_id;
  // Navigation supplies explicit expansion intent, including a collapsed scope.
  // Only an unspecified expansion defaults to exposing the root's first level.
  const expanded = new Set(expandedNodeIds ?? [rootId]);
  const width = Math.max(BOUNDED_TREE_MIN_WIDTH, Math.floor(Number.isFinite(availableWidth) ? availableWidth : BOUNDED_TREE_MIN_WIDTH));
  const capacity = Math.max(1, Math.floor((width - MARGIN * 2 + COLUMN_GAP) / (INLINE_NODE_WIDTH + COLUMN_GAP)));
  const previous = previousColumns && Number.isInteger(previousColumns) && previousColumns > 0 ? previousColumns : undefined;
  const minimumForCapacity = MARGIN * 2 + capacity * INLINE_NODE_WIDTH + (capacity - 1) * COLUMN_GAP;
  // A few scrollbar pixels must not repeatedly add and remove a column. Shrink
  // immediately to fit; require one gutter of spare space before growing again.
  const columns = previous && capacity > previous && width - minimumForCapacity < COLUMN_GAP ? Math.max(previous, capacity - 1) : capacity;
  const root = index.nodes.get(rootId);
  if (!root || root.status === "archived") return { rootId, nodes: [], edges: [], groups: [], width, height: 0, signature: rootId + ":" + width, columns };

  const nodes: InlineTreeNode[] = [], byId = new Map<string, InlineTreeNode>(), children = new Map<string, string[]>(), seen = new Set<string>();
  const stack = [{ id: rootId, parentId: null as string | null, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const available = index.children.get(item.id) ?? [];
    const visible = expanded.has(item.id) ? available.filter(child => !seen.has(child.id)).map(child => child.id) : [];
    children.set(item.id, visible);
    const node: InlineTreeNode = { ...item, x: 0, y: 0, width: INLINE_NODE_WIDTH, height: BOUNDED_NODE_HEIGHT, childCount: available.length, expanded: Boolean(visible.length) };
    nodes.push(node); byId.set(node.id, node);
    for (const id of [...visible].reverse()) stack.push({ id, parentId: node.id, depth: node.depth + 1 });
  }
  const rowWidth = (count: number) => count * INLINE_NODE_WIDTH + Math.max(0, count - 1) * COLUMN_GAP;
  interface Block { id: string; columns: number; rows: string[][]; height: number }
  const blocks = new Map<string, Block>();
  // Iterative measurement and placement keep very deep plans off the call stack.
  const measure = [{ id: rootId, capacity: columns, done: false }];
  while (measure.length) {
    const item = measure.pop()!;
    if (!item.done) {
      const siblings = children.get(item.id) ?? [], rows: string[][] = [];
      const childColumns = new Map<string, number>();
      // Greedy packing by expanded subtree width used to push an unchanged
      // rightmost sibling to the left of the next row. Partition by sibling
      // count first, then grow inside that row's existing column budget.
      for (let start = 0; start < siblings.length; start += item.capacity) {
        const row = siblings.slice(start, start + item.capacity); rows.push(row);
        for (const id of row) childColumns.set(id, 1);
        let spare = item.capacity - row.length;
        while (spare > 0) {
          let grew = false;
          for (const id of row) {
            const count = childColumns.get(id)!;
            // Reserve a maximum share by stable sibling order, using only the
            // known fact that this card has children. Reassigning a neighbour's
            // share on expansion would rewrap that neighbour's already visible
            // children. Measurement below consumes only actual visible width.
            if (!byId.get(id)!.childCount) continue;
            childColumns.set(id, count + 1); spare--; grew = true;
            if (!spare) break;
          }
          if (!grew) break;
        }
      }
      blocks.set(item.id, { id: item.id, columns: 1, rows, height: BOUNDED_NODE_HEIGHT });
      measure.push({ ...item, done: true });
      for (const id of siblings.slice().reverse()) measure.push({ id, capacity: childColumns.get(id)!, done: false });
    } else {
      const block = blocks.get(item.id)!;
      block.columns = item.id === rootId ? columns : Math.max(1, ...block.rows.map(row => row.reduce((sum, id) => sum + blocks.get(id)!.columns, 0)));
      block.height = BOUNDED_NODE_HEIGHT + block.rows.reduce((sum, row) => sum + ROW_GAP + Math.max(...row.map(id => blocks.get(id)!.height)), 0);
    }
  }
  const place = [{ id: rootId, x: (width - rowWidth(columns)) / 2, y: MARGIN }];
  while (place.length) {
    const item = place.pop()!, block = blocks.get(item.id)!, node = byId.get(item.id)!;
    const span = rowWidth(block.columns);
    node.x = item.x + (span - node.width) / 2; node.y = item.y;
    let y = item.y + BOUNDED_NODE_HEIGHT + ROW_GAP;
    for (const row of block.rows) {
      const used = row.reduce((sum, id) => sum + blocks.get(id)!.columns, 0);
      let x = item.x + (span - rowWidth(used)) / 2;
      for (const id of row) { const child = blocks.get(id)!; place.push({ id, x, y }); x += rowWidth(child.columns) + COLUMN_GAP; }
      y += Math.max(...row.map(id => blocks.get(id)!.height)) + ROW_GAP;
    }
  }
  const groups = boundedBranchGroups(nodes, width);
  const signature = width + ":" + columns + "|" + nodes.map(node => node.id + ":" + blocks.get(node.id)!.columns + ":" + (children.get(node.id) ?? []).join(",")).join("|");
  return { rootId, nodes, edges: boundedCompositionEdges(nodes, width), groups, width, height: blocks.get(rootId)!.height + MARGIN * 2, signature, columns };
}
