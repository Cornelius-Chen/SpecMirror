import type { InlineTreeNode } from "./inline-tree-layout.ts";

export type InlineTreeMotionRole = "rest" | "anchor" | "shift" | "enter" | "exit" | "crossfade-in" | "crossfade-out";

export interface AnimatedInlineTreeNode extends InlineTreeNode {
  opacity: number;
  exiting: boolean;
  ghost?: boolean;
  renderKey?: string;
  motionRole: InlineTreeMotionRole;
}

export interface InlineTreeTransitionPlan {
  from: AnimatedInlineTreeNode[];
  to: AnimatedInlineTreeNode[];
}

export const INLINE_TREE_MAX_SHIFT = 64;
const ENTER_OFFSET = 14;
const EXIT_OFFSET = 10;
const CROSSFADE_DIRECTION_HINT = 8;

export const restingInlineTreeNode = (node: InlineTreeNode): AnimatedInlineTreeNode => ({
  ...node,
  opacity: 1,
  exiting: false,
  motionRole: "rest"
});

/**
 * Keep an expansion legible: the clicked card is an anchor, nearby cards may
 * settle a short distance, and large reflows crossfade instead of travelling
 * through unrelated branches. New children reveal where they belong rather
 * than flying out of the parent card.
 */
export function planInlineTreeTransition(
  currentNodes: readonly AnimatedInlineTreeNode[],
  targetNodes: readonly InlineTreeNode[],
  anchorId?: string | null,
  screenPreservingOffset = { x: 0, y: 0 }
): InlineTreeTransitionPlan {
  const current = new Map(currentNodes.filter(node => !node.ghost).map(node => [node.id, node]));
  const targets = new Map(targetNodes.map(node => [node.id, node]));
  const from: AnimatedInlineTreeNode[] = [];
  const to: AnimatedInlineTreeNode[] = [];

  for (const target of targetNodes) {
    const old = current.get(target.id);
    if (!old) {
      from.push({ ...target, y: target.y - ENTER_OFFSET, opacity: 0, exiting: false, motionRole: "enter" });
      to.push(restingInlineTreeNode(target));
      continue;
    }

    if (target.id === anchorId) {
      from.push({ ...target, opacity: 1, exiting: false, motionRole: "anchor" });
      to.push(restingInlineTreeNode(target));
      continue;
    }

    // The camera moves by the inverse anchor delta before paint. Offset every
    // old world position by the same delta so its first rendered screen point
    // stays exactly where the user was already looking.
    const visualOld = { ...old, x: old.x + screenPreservingOffset.x, y: old.y + screenPreservingOffset.y };
    const dx = target.x - visualOld.x, dy = target.y - visualOld.y;
    const distance = Math.hypot(dx, dy);
    // Opening one card commonly asks its existing row to make roughly one
    // card-width of room. That is a meaningful local reflow, so let the row
    // visibly settle instead of replacing every card at its destination.
    // Cross-row repacking still crossfades to avoid cards sweeping through
    // unrelated branches.
    const localRowShift = Math.abs(dy) <= 1 && Math.abs(dx) <= target.width;
    // Stable row packing moves later rows down the same column. Preserve one
    // visual identity throughout that flow instead of crossfading to a clone.
    const columnFlow = Math.abs(dx) <= 1 && old.parentId === target.parentId && old.depth === target.depth;
    if (distance <= INLINE_TREE_MAX_SHIFT || localRowShift || columnFlow) {
      from.push({ ...target, x: visualOld.x, y: visualOld.y, opacity: old.opacity, exiting: false, motionRole: "shift" });
      to.push(restingInlineTreeNode(target));
      continue;
    }

    const hint = distance ? { x: dx / distance * CROSSFADE_DIRECTION_HINT, y: dy / distance * CROSSFADE_DIRECTION_HINT } : { x: 0, y: 0 };
    // A large reflow keeps the two representations near their own endpoints.
    // The small directional hint makes the destination understandable without
    // sending a card diagonally across the graph.
    from.push({ ...target, x: target.x - hint.x, y: target.y - hint.y, opacity: 0, exiting: false, motionRole: "crossfade-in" });
    to.push(restingInlineTreeNode(target));
    const ghost: AnimatedInlineTreeNode = {
      ...visualOld,
      opacity: old.opacity,
      exiting: true,
      ghost: true,
      renderKey: `${old.id}:motion-ghost`,
      motionRole: "crossfade-out"
    };
    from.push(ghost);
    to.push({ ...ghost, x: ghost.x + hint.x, y: ghost.y + hint.y, opacity: 0 });
  }

  for (const old of current.values()) {
    if (targets.has(old.id)) continue;
    const leaving: AnimatedInlineTreeNode = { ...old, x: old.x + screenPreservingOffset.x, y: old.y + screenPreservingOffset.y, exiting: true, motionRole: "exit" };
    from.push(leaving);
    to.push({ ...leaving, y: leaving.y - EXIT_OFFSET, opacity: 0 });
  }

  return { from, to };
}
