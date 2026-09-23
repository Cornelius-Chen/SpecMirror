import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { MapRect, MapViewport } from "./map-layout.ts";
import { AUTO_FIT_MIN_MAP_SCALE, clampProjectCamera, fitProjectCamera, fitProjectRectCamera, fitReadingProjectCamera, interpolateProjectCamera, preserveProjectWorldAnchor, projectEntryCamera, readingProjectCamera, resizeProjectCamera, revealAnchoredProjectRectCamera, zoomProjectCamera, type MapCamera } from "./map-camera.ts";

interface CameraLayout { rootId: string; width: number; height: number; signature: string }
interface Entry { nodeId: string; screenRect: MapRect }
interface Pan { pointerId: number; x: number; y: number; camera: MapCamera; moved: boolean }

const CAMERA_DURATION = 280;
const storageKey = (workspaceId: string, scopeId: string) => `mirror:project-map-camera:${workspaceId}:${scopeId}`;
const displayPixelRatio = () => typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
interface StoredManualCamera { version: 1; source: "manual"; camera: MapCamera }

function readCamera(workspaceId: string, scopeId: string): MapCamera | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(workspaceId, scopeId)) || "null") as Partial<StoredManualCamera> | null;
    const camera = value?.camera;
    return value?.version === 1 && value.source === "manual" && camera && [camera.x, camera.y, camera.scale].every(Number.isFinite) ? camera : null;
  } catch { return null; }
}

function writeCamera(workspaceId: string, scopeId: string, camera: MapCamera) {
  try { sessionStorage.setItem(storageKey(workspaceId, scopeId), JSON.stringify({ version: 1, source: "manual", camera } satisfies StoredManualCamera)); } catch { /* Storage can be unavailable in an isolated webview. */ }
}

function clearCamera(workspaceId: string, scopeId: string) {
  try { sessionStorage.removeItem(storageKey(workspaceId, scopeId)); } catch { /* Storage can be unavailable in an isolated webview. */ }
}

/** One transform owns all canvas motion. The tree animation never writes scroll offsets. */
export function useProjectMapCamera(viewportRef: RefObject<HTMLDivElement | null>, workspaceId: string, scopeId: string, layout: CameraLayout) {
  const [viewport, setViewport] = useState<MapViewport>({ width: 0, height: 0 });
  const [camera, setCameraState] = useState<MapCamera>({ x: 0, y: 0, scale: 1 });
  const [moving, setMoving] = useState(false), [panning, setPanning] = useState(false);
  const [manualEpoch, setManualEpoch] = useState(0);
  const cameraRef = useRef(camera), viewportRefValue = useRef(viewport), scopeRef = useRef({ workspaceId, scopeId });
  const layoutRef = useRef(layout), initialized = useRef(false), userMoved = useRef(false), entry = useRef<Entry | null>(null), pan = useRef<Pan | null>(null);
  const animation = useRef(0), animationId = useRef(0), reducedMotion = useRef(false);

  const publish = useCallback((next: MapCamera, remember = false) => {
    cameraRef.current = next; setCameraState(next);
    if (remember) writeCamera(scopeRef.current.workspaceId, scopeRef.current.scopeId, next);
  }, []);
  const stop = useCallback(() => { cancelAnimationFrame(animation.current); animationId.current++; setMoving(false); }, []);
  const animateTo = useCallback((requested: MapCamera, from = cameraRef.current, remember = false, boundsResolved = false) => {
    const bounds = layoutRef.current, size = viewportRefValue.current;
    if (!size.width || !size.height) return;
    // A reveal has already constrained the axes it needs to move. Reapplying
    // ordinary pan bounds here would move an already-readable anchored axis.
    const target = boundsResolved ? requested : clampProjectCamera(requested, bounds, size);
    stop();
    const farTravel = Math.max(Math.abs(target.x - from.x), Math.abs(target.y - from.y)) > Math.max(size.width, size.height) * 1.25;
    // A locate action may cross thousands of pixels in a large project. A
    // direct cut is easier to follow than sweeping every unrelated card across
    // the viewport in a fixed 280 ms animation.
    if (reducedMotion.current || farTravel || ["x", "y", "scale"].every(key => Math.abs(from[key as keyof MapCamera] - target[key as keyof MapCamera]) < .001)) { publish(target, remember); return; }
    const id = ++animationId.current, started = performance.now(); setMoving(true); publish(from, false);
    const tick = (now: number) => {
      if (id !== animationId.current) return;
      const progress = Math.max(0, Math.min(1, (now - started) / CAMERA_DURATION));
      publish(interpolateProjectCamera(from, target, progress), false);
      if (progress < 1) animation.current = requestAnimationFrame(tick);
      else { setMoving(false); publish(target, remember); }
    };
    animation.current = requestAnimationFrame(tick);
  }, [publish, stop]);
  const fitForCurrentDisplay = useCallback((bounds: CameraLayout, size: MapViewport) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return fitProjectCamera(bounds, size, AUTO_FIT_MIN_MAP_SCALE, displayPixelRatio(), { x: rect?.left ?? 0, y: rect?.top ?? 0 });
  }, [viewportRef]);
  const readingForCurrentDisplay = useCallback((bounds: CameraLayout, size: MapViewport) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return readingProjectCamera(bounds, size, displayPixelRatio(), { x: rect?.left ?? 0, y: rect?.top ?? 0 });
  }, [viewportRef]);

  useLayoutEffect(() => {
    reducedMotion.current = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const element = viewportRef.current; if (!element) return;
    const measure = () => setViewport(current => current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [viewportRef]);

  useLayoutEffect(() => {
    const previous = viewportRefValue.current; viewportRefValue.current = viewport;
    if (!viewport.width || !viewport.height) return;
    const previousLayout = layoutRef.current;
    layoutRef.current = layout;
    const changedScope = scopeRef.current.workspaceId !== workspaceId || scopeRef.current.scopeId !== scopeId;
    if (changedScope || !initialized.current) {
      scopeRef.current = { workspaceId, scopeId };
      const stored = readCamera(workspaceId, scopeId), target = stored ? clampProjectCamera(stored, layout, viewport) : readingForCurrentDisplay(layout, viewport);
      const pending = entry.current?.nodeId === scopeId ? entry.current : null;
      const from = initialized.current && pending ? projectEntryCamera(layout, pending.screenRect) : initialized.current ? cameraRef.current : target;
      entry.current = null; initialized.current = true; userMoved.current = Boolean(stored);
      if (!stored) clearCamera(workspaceId, scopeId);
      if (from === target) publish(target, Boolean(stored)); else animateTo(target, from, Boolean(stored));
      return;
    }
    const viewportChanged = previous.width > 0 && (previous.width !== viewport.width || previous.height !== viewport.height);
    if (viewportChanged) {
      // A dock resize supersedes the old viewport's animation target.
      stop();
      const next = resizeProjectCamera(cameraRef.current, layout, previous, viewport, userMoved.current);
      if (!userMoved.current) clearCamera(workspaceId, scopeId);
      publish(next, userMoved.current); return;
    }
    if (previousLayout.signature !== layout.signature || previousLayout.width !== layout.width || previousLayout.height !== layout.height) {
      // Expanding one branch must not zoom or recenter the complete graph. Keep
      // the current reading position. The component's later layout effect will
      // translate it exactly once to preserve the clicked card on screen.
      return;
    }
  }, [workspaceId, scopeId, layout.signature, layout.width, layout.height, viewport.width, viewport.height, animateTo, readingForCurrentDisplay, publish, stop]);

  useLayoutEffect(() => () => cancelAnimationFrame(animation.current), []);

  const markEntry = useCallback((nodeId: string, screenRect: MapRect) => { entry.current = { nodeId, screenRect }; }, []);
  const fitAll = useCallback(() => { setManualEpoch(value => value + 1); userMoved.current = false; clearCamera(scopeRef.current.workspaceId, scopeRef.current.scopeId); animateTo(fitForCurrentDisplay(layoutRef.current, viewportRefValue.current)); }, [animateTo, fitForCurrentDisplay]);
  const fitRect = useCallback((rect: MapRect) => { setManualEpoch(value => value + 1); userMoved.current = true; animateTo(fitProjectRectCamera(rect, viewportRefValue.current), cameraRef.current, true); }, [animateTo]);
  const fitReading = useCallback((visibleRects: readonly MapRect[], active: MapRect, child?: MapRect) => {
    setManualEpoch(value => value + 1); userMoved.current = true;
    animateTo(fitReadingProjectCamera(visibleRects, active, child, viewportRefValue.current), cameraRef.current, true);
  }, [animateTo]);
  const revealRect = useCallback((rect: MapRect, padding = 36) => {
    const current = cameraRef.current;
    const target = revealAnchoredProjectRectCamera(rect, current, layoutRef.current, viewportRefValue.current, padding);
    animateTo(target, current, false, true);
  }, [animateTo]);
  const preserveWorldAnchor = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    const current = cameraRef.current;
    if (!viewportRefValue.current.width || !viewportRefValue.current.height) return;
    stop();
    publish(preserveProjectWorldAnchor(current, from, to));
  }, [publish, stop]);
  const moveTo = useCallback((requested: MapCamera) => animateTo(requested), [animateTo]);
  const zoomTo = useCallback((scale: number, anchor?: { x: number; y: number }) => {
    const size = viewportRefValue.current, point = anchor ?? { x: size.width / 2, y: size.height / 2 };
    setManualEpoch(value => value + 1); userMoved.current = true; animateTo(zoomProjectCamera(cameraRef.current, scale / cameraRef.current.scale, point), cameraRef.current, true);
  }, [animateTo]);
  const panBy = useCallback((x: number, y: number) => {
    setManualEpoch(value => value + 1); userMoved.current = true; stop(); publish(clampProjectCamera({ ...cameraRef.current, x: cameraRef.current.x + x, y: cameraRef.current.y + y }, layoutRef.current, viewportRefValue.current), true);
  }, [publish, stop]);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // An ordinary wheel belongs to the surrounding document. The canvas only
      // takes ownership when the user explicitly holds Ctrl to request zoom.
      if (!event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = element.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const factor = Math.exp(-event.deltaY * .0015);
      setManualEpoch(value => value + 1); userMoved.current = true; stop(); publish(clampProjectCamera(zoomProjectCamera(cameraRef.current, factor, anchor), layoutRef.current, viewportRefValue.current), true);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [publish, stop, viewportRef]);
  const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stop(); pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: cameraRef.current, moved: false };
    setPanning(true); event.currentTarget.setPointerCapture(event.pointerId);
  }, [stop]);
  const movePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const active = pan.current; if (!active || active.pointerId !== event.pointerId) return;
    if (!active.moved) setManualEpoch(value => value + 1);
    active.moved = true; userMoved.current = true;
    publish(clampProjectCamera({ ...active.camera, x: active.camera.x + event.clientX - active.x, y: active.camera.y + event.clientY - active.y }, layoutRef.current, viewportRefValue.current));
  }, [publish]);
  const endPan = useCallback((event?: ReactPointerEvent<HTMLDivElement>) => {
    const active = pan.current; if (!active) return;
    if (event?.currentTarget.hasPointerCapture(active.pointerId)) event.currentTarget.releasePointerCapture(active.pointerId);
    pan.current = null; setPanning(false); if (active.moved) writeCamera(scopeRef.current.workspaceId, scopeRef.current.scopeId, cameraRef.current);
  }, []);
  const centerWorldPoint = useCallback((point: { x: number; y: number }) => {
    const size = viewportRefValue.current; setManualEpoch(value => value + 1); userMoved.current = true;
    animateTo({ ...cameraRef.current, x: size.width / 2 - point.x * cameraRef.current.scale, y: size.height / 2 - point.y * cameraRef.current.scale }, cameraRef.current, true);
  }, [animateTo]);

  return { camera, viewport, moving, panning, manualEpoch, markEntry, fitAll, fitRect, fitReading, revealRect, preserveWorldAnchor, moveTo, zoomTo, panBy, startPan, movePan, endPan, centerWorldPoint };
}
