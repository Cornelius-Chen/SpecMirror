import { boundedCompositionEdges, boundedCompositionSegments, type BoundedCompositionEdge, type BoundedCompositionRoutingOptions, type BoundedCompositionSegment } from "./bounded-tree-layout.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import type { AnimatedInlineTreeNode } from "./inline-tree-transition.ts";

export interface AnimatedCompositionEdge extends BoundedCompositionEdge { opacity: number }
export interface AnimatedCompositionSegment extends BoundedCompositionSegment { opacity: number }
export interface AnimatedComposition {
  edges: AnimatedCompositionEdge[];
  segments: AnimatedCompositionSegment[];
  /** Visible logical relations for which the current frame has no safe route. */
  suppressedEdgeIds: string[];
}

/**
 * Presentation geometry only. The existing bounded router keeps final-layout
 * lane preferences while checking every path against the displayed cards and
 * captions. Exiting cards retain their real parent until they disappear; ghosts
 * are detached obstacle copies and can never introduce another relationship.
 *
 * Work inherits the router's candidate-by-obstacle scans and materialized
 * descendant groups, plus shared-rail segment splitting. Pathologically deep
 * trees can be superquadratic; measure representative visible frames rather
 * than assuming linear cost. No dependency routing or engineering index is
 * rebuilt on animation frames.
 */
export function animatedComposition(
  frameNodes: readonly AnimatedInlineTreeNode[],
  settledNodes: readonly InlineTreeNode[],
  width: number,
  options: BoundedCompositionRoutingOptions = {}
): AnimatedComposition {
  // Fully transparent cards neither draw a relation nor block a visible one.
  const visible = frameNodes.filter(node => node.opacity > 0);
  const real = visible.filter(node => !node.ghost);
  const realById = new Map(real.map(node => [node.id, node]));
  const occupiedIds = new Set([...frameNodes, ...settledNodes].flatMap(node => [node.id, ...(node.parentId ? [node.parentId] : [])]));
  const obstacles = visible.filter(node => node.ghost).map((node, index): InlineTreeNode => {
    let id = `:composition-ghost:${index}`;
    while (occupiedIds.has(id)) id += ":";
    occupiedIds.add(id);
    return { ...node, id, parentId: null, expanded: false, childCount: 0 };
  });
  const settledIds = new Set(settledNodes.map(node => node.id));
  // A collapse removes children from the target layout before their fade ends.
  // Keep their displayed order as a reference so wrapped exit routes stay wrapped.
  const exiting = real.filter(node => !settledIds.has(node.id));
  const reference = exiting.length ? [...settledNodes, ...exiting] : settledNodes;
  const edges = boundedCompositionEdges([...real, ...obstacles], width, reference, options).map((edge): AnimatedCompositionEdge => ({
    ...edge,
    opacity: Math.min(1, realById.get(edge.from)!.opacity, realById.get(edge.to)!.opacity)
  }));
  const edgeById = new Map(edges.map(edge => [edge.id, edge]));
  const segments = boundedCompositionSegments(edges).map((segment): AnimatedCompositionSegment => ({
    ...segment,
    // A common trunk remains visible while any contributing relation is visible.
    opacity: Math.max(...segment.edgeIds.map(id => edgeById.get(id)!.opacity))
  }));
  const suppressedEdgeIds = real.flatMap(node => node.parentId && realById.has(node.parentId) && !edgeById.has(`${node.parentId}>${node.id}`) ? [`${node.parentId}>${node.id}`] : []);
  return { edges, segments, suppressedEdgeIds };
}
