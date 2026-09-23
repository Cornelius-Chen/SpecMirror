import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { EngineeringView } from "@epm/domain";
import type { InlineTreeNode } from "./inline-tree-layout.ts";
import { boundedTreeLayout, BOUNDED_TREE_MIN_WIDTH, type BoundedTreeLayout } from "./bounded-tree-layout.ts";
import { planInlineTreeTransition, restingInlineTreeNode, type AnimatedInlineTreeNode } from "./inline-tree-transition.ts";

export type AnimatedTreeNode = AnimatedInlineTreeNode;
interface Frame {
  nodes: AnimatedTreeNode[]; width: number; height: number; moving: boolean; layoutSignature: string;
  /** Shared eased clock for region/label presentation; never a second animation loop. */
  transitionId: number; progress: number;
  /** Applied to the old world when keeping the clicked anchor fixed on screen. */
  originOffset: { x: number; y: number };
}
interface Camera { x: number; y: number }
interface History { workspace: string; layout: BoundedTreeLayout; selected?: string | null }
interface Transition { id: number; cameraActive: boolean; finish: () => void }
const DURATION = 380, INSET = 20;
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, Math.max(0, max)));
const atRest = (node: InlineTreeNode): AnimatedTreeNode => restingInlineTreeNode(node);

/** Presentation only: the owner accepts navigation before this hook sees a new tree. */
export function useInlineTreeMotion(view: EngineeringView, expanded: readonly string[] | undefined, workspace: string, selected: string | null | undefined, viewport: RefObject<HTMLDivElement | null>, scopeRootId?: string | null, externalCamera = false) {
  const history = useRef<History | null>(null);
  const [availableWidth, setAvailableWidth] = useState(BOUNDED_TREE_MIN_WIDTH);
  const layout = useMemo(() => boundedTreeLayout(view, expanded, availableWidth, history.current?.workspace === workspace ? history.current.layout.columns : undefined, scopeRootId), [view, expanded, availableWidth, workspace, scopeRootId]);
  const [frame, setFrame] = useState<Frame>(() => ({ nodes: layout.nodes.map(node => atRest(node)), width: layout.width, height: layout.height, moving: false, layoutSignature: layout.signature, transitionId: 0, progress: 1, originOffset: { x: 0, y: 0 } }));
  const displayed = useRef(frame), transition = useRef<Transition | null>(null), nextId = useRef(0), animationFrame = useRef(0);
  const returns = useRef(new Map<string, Camera>());
  const [measureEpoch, setMeasureEpoch] = useState(0);
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const publish = (value: Frame) => { displayed.current = value; setFrame(value); };

  useLayoutEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)"), change = () => setReduced(media.matches);
    media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    let width = element.clientWidth, height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      if (width === element.clientWidth && height === element.clientHeight) return;
      width = element.clientWidth; height = element.clientHeight;
      if (width > 0) setAvailableWidth(width);
      setMeasureEpoch(value => value + 1);
    });
    const releaseCamera = () => { if (transition.current) transition.current.cameraActive = false; returns.current.clear(); };
    const pointer = (event: PointerEvent) => { if (!(event.target as Element).closest(".psm-card,.psm-branch-caption")) releaseCamera(); };
    const key = (event: KeyboardEvent) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) releaseCamera(); };
    observer.observe(element);
    // Release the camera before the browser applies native wheel scrolling.
    // A passive listener can arrive after compositor scrolling and lose its last frame.
    if (!externalCamera) {
      element.addEventListener("wheel", releaseCamera, { passive: false }); element.addEventListener("touchmove", releaseCamera, { passive: true });
      element.addEventListener("pointerdown", pointer); element.addEventListener("keydown", key);
    }
    return () => {
      observer.disconnect();
      if (!externalCamera) {
        element.removeEventListener("wheel", releaseCamera); element.removeEventListener("touchmove", releaseCamera);
        element.removeEventListener("pointerdown", pointer); element.removeEventListener("keydown", key);
      }
    };
  }, [viewport, workspace, Boolean(layout.nodes.length), externalCamera]);
  useLayoutEffect(() => () => { cancelAnimationFrame(animationFrame.current); transition.current = null; }, []);

  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    // Initially hidden conversation panels initialize only when they can be measured.
    if (!element.clientWidth || !element.clientHeight) { transition.current?.finish(); return; }
    if (availableWidth !== element.clientWidth) { setAvailableWidth(element.clientWidth); return; }
    const before = history.current, fresh = !before || before.workspace !== workspace || before.layout.rootId !== layout.rootId;
    const targetNodes = layout.nodes.map(node => atRest(node));
    const targets = new Map(targetNodes.map(node => [node.id, node]));
    const width = Math.max(element.clientWidth, layout.width);
    const restHeight = Math.max(element.clientHeight, layout.height);
    const height = Math.max(restHeight, fresh ? 0 : displayed.current.height);
    const active = targets.get(selected ?? layout.rootId) ?? targetNodes[0];
    const cameraNow = { x: element.scrollLeft, y: element.scrollTop };
    let camera = { ...cameraNow };
    const constrain = (value: Camera): Camera => ({ x: clamp(value.x, width - element.clientWidth), y: clamp(value.y, restHeight - element.clientHeight) });
    const reveal = (node: AnimatedTreeNode, center = false) => {
      if (center || node.x < camera.x + INSET || node.x + node.width > camera.x + element.clientWidth - INSET) camera.x = node.x + node.width / 2 - element.clientWidth / 2;
      if (center || node.y < camera.y + INSET || node.y + node.height > camera.y + element.clientHeight - INSET) camera.y = node.y - 28;
    };
    if (fresh) {
      cancelAnimationFrame(animationFrame.current); transition.current = null; returns.current.clear();
      camera = { x: 0, y: 0 }; if (active) reveal(active, true); camera = constrain(camera);
      // Set the scroll range before moving: React applies the frame before paint.
      publish({ nodes: targetNodes, width, height, moving: false, layoutSignature: layout.signature, transitionId: ++nextId.current, progress: 1, originOffset: { x: 0, y: 0 } });
      if (!externalCamera) {
        const canvas = element.firstElementChild as HTMLElement | null;
        if (canvas) { canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
        element.scrollLeft = camera.x; element.scrollTop = camera.y;
      }
      history.current = { workspace, layout, selected }; return;
    }

    const resized = before.layout.width !== layout.width || before.layout.columns !== layout.columns;
    const structureChanged = before.layout.signature !== layout.signature;
    const selectionChanged = before.selected !== selected;
    const currentNodes = displayed.current.nodes.filter(node => !node.ghost), current = new Map(currentNodes.map(node => [node.id, node]));
    const oldActive = active && current.get(active.id);
    const oldLogical = active && before.layout.nodes.find(node => node.id === active.id);
    const toggled = active && oldLogical && active.expanded !== oldLogical.expanded;
    if (resized) returns.current.clear();
    if (structureChanged && active && oldActive) {
      // Follow any required world-origin correction without losing the clicked point.
      camera.x += active.x - oldActive.x; camera.y += active.y - oldActive.y;
      if (toggled && active.expanded) {
        if (!returns.current.has(active.id)) returns.current.set(active.id, { x: oldActive.x - cameraNow.x, y: oldActive.y - cameraNow.y });
        const child = targetNodes.find(node => node.parentId === active.id);
        if (child) {
          if (child.y + child.height - active.y + INSET * 2 <= element.clientHeight) {
            camera.y = Math.max(camera.y, child.y + child.height + INSET - element.clientHeight);
            camera.y = Math.min(camera.y, active.y - INSET);
          } else {
            // Earlier open branches stay open. The new region carries its parent
            // name and a collapse control when both rows cannot fit in view.
            camera.y = child.y - 56;
          }
        }
      } else if (toggled) {
        const saved = returns.current.get(active.id);
        if (saved) camera = { x: active.x - saved.x, y: active.y - saved.y };
        else reveal(active);
      } else if (selectionChanged) reveal(active);
    } else if (active && selectionChanged) reveal(active);
    if (resized && active) reveal(active);
    camera = constrain(camera);
    history.current = { workspace, layout, selected };

    // A status refresh is not navigation and must neither restart motion nor steal scrolling.
    if (!structureChanged && !selectionChanged && !reduced) {
      if (transition.current) return;
      if (frameDimensionsChanged()) publish({ nodes: targetNodes, width, height, moving: false, layoutSignature: layout.signature, transitionId: nextId.current, progress: 1, originOffset: { x: 0, y: 0 } });
      return;
    }
    function frameDimensionsChanged() { return displayed.current.width !== width || displayed.current.height !== height; }
    cancelAnimationFrame(animationFrame.current);
    const id = ++nextId.current;
    const screenPreservingOffset = toggled && active && oldLogical
      ? { x: active.x - oldLogical.x, y: active.y - oldLogical.y }
      : { x: 0, y: 0 };
    const { from, to } = planInlineTreeTransition(currentNodes, layout.nodes, toggled ? active?.id : null, screenPreservingOffset);
    const finish = () => {
      if (transition.current?.id !== id) return;
      cancelAnimationFrame(animationFrame.current);
      if (!externalCamera) {
        const canvas = element.firstElementChild as HTMLElement | null;
        if (canvas) { canvas.style.width = `${width}px`; canvas.style.height = `${restHeight}px`; }
        if (transition.current.cameraActive && element.clientWidth) { element.scrollLeft = camera.x; element.scrollTop = camera.y; }
      }
      for (const nodeId of returns.current.keys()) if (!targets.get(nodeId)?.expanded) returns.current.delete(nodeId);
      transition.current = null; publish({ nodes: targetNodes, width, height: restHeight, moving: false, layoutSignature: layout.signature, transitionId: id, progress: 1, originOffset: { x: 0, y: 0 } });
    };
    transition.current = { id, cameraActive: true, finish };
    if (!externalCamera) {
      const canvas = element.firstElementChild as HTMLElement | null;
      if (canvas) { canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
    }
    if (reduced || resized || !currentNodes.length || (!oldActive && (Math.abs(camera.x - cameraNow.x) > element.clientWidth * 2 || Math.abs(camera.y - cameraNow.y) > element.clientHeight * 2))) { finish(); return; }
    const hasMotion = from.some((node, i) => node.x !== to[i].x || node.y !== to[i].y || node.opacity !== to[i].opacity) || (!externalCamera && (camera.x !== cameraNow.x || camera.y !== cameraNow.y));
    if (!hasMotion) { finish(); return; }
    publish({ nodes: from, width, height, moving: true, layoutSignature: layout.signature, transitionId: id, progress: 0, originOffset: screenPreservingOffset });
    const start = performance.now();
    const tick = (now: number) => {
      if (transition.current?.id !== id) return;
      // A queued animation-frame timestamp can precede setup completion. Never
      // extrapolate backwards: it briefly pushes cards outside the width budget.
      const progress = Math.max(0, Math.min(1, (now - start) / DURATION));
      // Smoothstep starts and ends at zero velocity. The previous quartic
      // ease-out covered roughly a quarter of the trip on its first frame,
      // which made a valid reflow look like an instantaneous jump.
      const ease = progress * progress * (3 - 2 * progress);
      if (progress === 1 || !element.clientWidth) { finish(); return; }
      const nodes = from.map((node, i) => ({ ...node, x: node.x + (to[i]!.x - node.x) * ease, y: node.y + (to[i]!.y - node.y) * ease, opacity: node.opacity + (to[i]!.opacity - node.opacity) * ease }));
      if (!externalCamera && transition.current.cameraActive) { element.scrollLeft = cameraNow.x + (camera.x - cameraNow.x) * ease; element.scrollTop = cameraNow.y + (camera.y - cameraNow.y) * ease; }
      publish({ nodes, width, height, moving: true, layoutSignature: layout.signature, transitionId: id, progress: ease, originOffset: screenPreservingOffset }); animationFrame.current = requestAnimationFrame(tick);
    };
    animationFrame.current = requestAnimationFrame(tick);
  }, [layout, workspace, selected, measureEpoch, reduced, viewport, availableWidth, externalCamera]);

  return { layout, frame };
}
