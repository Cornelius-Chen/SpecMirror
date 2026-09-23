import type { MapRect, MapViewport, ProjectMapLayout } from "./map-layout.ts";
export interface MapCamera { x: number; y: number; scale: number }
export type ProjectMapSemanticDensity = "overview" | "structure" | "detail";
export const MIN_MAP_SCALE = .12, AUTO_FIT_MIN_MAP_SCALE = .42, READING_MIN_MAP_SCALE = .85, MAX_MAP_SCALE = 1.7;
const snapToDevicePixel = (value: number, pixelRatio: number) => Math.round(value * pixelRatio) / pixelRatio;
export function fitProjectCamera(layout: Pick<ProjectMapLayout, "width" | "height">, viewport: MapViewport, minimumScale = .65, pixelRatio = 1, viewportOrigin = { x: 0, y: 0 }): MapCamera {
  // The bounded layout already includes its own outer breathing room. Applying
  // another 22px inset used to turn an otherwise native-size map into a 97%
  // transformed DOM layer, which visibly softened every glyph and card border.
  // Keep a fitting scene at 100%; only scale when the world really exceeds the
  // viewport. Pixel-align the resting translation for the current display.
  const fitsAtNativeSize = layout.width <= viewport.width && layout.height <= viewport.height;
  const scale = fitsAtNativeSize ? 1 : Math.max(minimumScale, Math.min(1, (viewport.width - 44) / layout.width, (viewport.height - 44) / layout.height));
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const x = (viewport.width - layout.width * scale) / 2, y = (viewport.height - layout.height * scale) / 2;
  return { scale,
    x: snapToDevicePixel(viewportOrigin.x + x, ratio) - viewportOrigin.x,
    y: snapToDevicePixel(viewportOrigin.y + y, ratio) - viewportOrigin.y };
}
/** Start a new map at reading size; a tall project begins at its root row. */
export function readingProjectCamera(layout: Pick<ProjectMapLayout, "width" | "height">, viewport: MapViewport, pixelRatio = 1, viewportOrigin = { x: 0, y: 0 }): MapCamera {
  const camera = fitProjectCamera(layout, viewport, READING_MIN_MAP_SCALE, pixelRatio, viewportOrigin);
  if (layout.height * camera.scale <= viewport.height) return camera;
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { ...camera, y: snapToDevicePixel(viewportOrigin.y + 22, ratio) - viewportOrigin.y };
}
export function clampProjectCamera(camera: MapCamera, layout: Pick<ProjectMapLayout, "width" | "height">, viewport: MapViewport): MapCamera {
  const scale = Math.max(MIN_MAP_SCALE, Math.min(MAX_MAP_SCALE, camera.scale));
  const xFar = viewport.width - layout.width * scale - 48, yFar = viewport.height - layout.height * scale - 48;
  return { scale, x: Math.max(Math.min(48, xFar), Math.min(Math.max(48, xFar), camera.x)), y: Math.max(Math.min(48, yFar), Math.min(Math.max(48, yFar), camera.y)) };
}
/**
 * Keep the same graph point under the cursor while a local branch changes the
 * world's packing. This intentionally does not clamp: a fitting world may need
 * more than the normal 48px pan allowance for one frame-preserving reflow.
 * The inverse collapse restores the previous camera, and explicit pan/fit/zoom
 * actions still use the ordinary bounded camera.
 */
export function preserveProjectWorldAnchor(camera: MapCamera, from: { x: number; y: number }, to: { x: number; y: number }): MapCamera {
  return {
    ...camera,
    x: camera.x + (from.x - to.x) * camera.scale,
    y: camera.y + (from.y - to.y) * camera.scale
  };
}
export function zoomProjectCamera(camera: MapCamera, factor: number, anchor: { x: number; y: number }): MapCamera {
  const scale = Math.max(MIN_MAP_SCALE, Math.min(MAX_MAP_SCALE, camera.scale * factor)), ratio = scale / camera.scale;
  return { scale, x: anchor.x - (anchor.x - camera.x) * ratio, y: anchor.y - (anchor.y - camera.y) * ratio };
}
export function projectScreenRect(rect: MapRect, camera: MapCamera): MapRect { return { x: rect.x * camera.scale + camera.x, y: rect.y * camera.scale + camera.y, width: rect.width * camera.scale, height: rect.height * camera.scale }; }
/** Pan just far enough to make a world-space result readable without changing zoom. */
export function revealProjectRectCamera(rect: MapRect, camera: MapCamera, viewport: MapViewport, padding = 36): MapCamera {
  const screen = projectScreenRect(rect, camera);
  const availableWidth = Math.max(0, viewport.width - padding * 2), availableHeight = Math.max(0, viewport.height - padding * 2);
  let x = camera.x, y = camera.y;
  if (screen.width > availableWidth) x += viewport.width / 2 - (screen.x + screen.width / 2);
  else if (screen.x < padding) x += padding - screen.x;
  else if (screen.x + screen.width > viewport.width - padding) x -= screen.x + screen.width - (viewport.width - padding);
  if (screen.height > availableHeight) y += viewport.height / 2 - (screen.y + screen.height / 2);
  else if (screen.y < padding) y += padding - screen.y;
  else if (screen.y + screen.height > viewport.height - padding) y -= screen.y + screen.height - (viewport.height - padding);
  return { x, y, scale: camera.scale };
}
/** Resolve reveal bounds once, preserving any axis whose content is already readable. */
export function revealAnchoredProjectRectCamera(rect: MapRect, camera: MapCamera, layout: Pick<ProjectMapLayout, "width" | "height">, viewport: MapViewport, padding = 36): MapCamera {
  const revealed = revealProjectRectCamera(rect, camera, viewport, padding);
  const bounded = clampProjectCamera(revealed, layout, viewport);
  return {
    ...bounded,
    x: Math.abs(revealed.x - camera.x) < .001 ? camera.x : bounded.x,
    y: Math.abs(revealed.y - camera.y) < .001 ? camera.y : bounded.y
  };
}
export function projectWorldRect(camera: MapCamera, viewport: MapViewport): MapRect {
  return { x: -camera.x / camera.scale, y: -camera.y / camera.scale, width: viewport.width / camera.scale, height: viewport.height / camera.scale };
}
export function fitProjectRectCamera(rect: MapRect, viewport: MapViewport, padding = 48, maximumScale = 1.18): MapCamera {
  const scale = Math.max(MIN_MAP_SCALE, Math.min(MAX_MAP_SCALE, maximumScale, (viewport.width - padding * 2) / rect.width, (viewport.height - padding * 2) / rect.height));
  return { scale, x: viewport.width / 2 - (rect.x + rect.width / 2) * scale, y: viewport.height / 2 - (rect.y + rect.height / 2) * scale };
}
const unionProjectRects = (rects: readonly MapRect[]): MapRect => {
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
};
/** Spend spare margin before dropping a child from a short reading viewport. */
export function projectReadingContext(active: MapRect, child: MapRect | undefined, viewport: MapViewport, scale: number) {
  const fits = (rect: MapRect) => rect.width * scale <= viewport.width - 16 && rect.height * scale <= viewport.height - 16;
  const full = child ? unionProjectRects([active, child]) : active;
  // Card headings use 9px padding plus two 18px lines. A clipped lower card
  // still exposes its complete title and the continuation below it.
  const preview = child ? unionProjectRects([active, { ...child, height: Math.min(child.height, 48) }]) : active;
  const rect = fits(full) ? full : fits(preview) ? preview : active;
  const padding = Math.max(8, Math.min(36, (viewport.width - rect.width * scale) / 2, (viewport.height - rect.height * scale) / 2));
  return { rect, padding, complete: rect === full, includesChild: Boolean(child && rect !== active) };
}
/** Fit visible selected content at reading size; a large branch starts locally. */
export function fitReadingProjectCamera(visibleRects: readonly MapRect[], active: MapRect, child: MapRect | undefined, viewport: MapViewport): MapCamera {
  const full = fitProjectRectCamera(unionProjectRects(visibleRects.length ? visibleRects : [active]), viewport, 24, 1);
  if (full.scale >= READING_MIN_MAP_SCALE) return full;
  const context = projectReadingContext(active, child, viewport, READING_MIN_MAP_SCALE);
  const fitted = fitProjectRectCamera(context.rect, viewport, context.padding, 1);
  const scale = Math.max(READING_MIN_MAP_SCALE, fitted.scale);
  return { scale, x: viewport.width / 2 - (context.rect.x + context.rect.width / 2) * scale, y: viewport.height / 2 - (context.rect.y + context.rect.height / 2) * scale };
}
export function semanticDensityForScale(scale: number): ProjectMapSemanticDensity {
  return scale < .58 ? "overview" : scale < .9 ? "structure" : "detail";
}
export function scaleForSemanticDensity(density: ProjectMapSemanticDensity): number {
  return density === "overview" ? .5 : density === "structure" ? .76 : 1.08;
}
export function projectEntryCamera(layout: Pick<ProjectMapLayout, "width" | "height">, sourceScreen: MapRect): MapCamera {
  const scale = Math.min(sourceScreen.width / layout.width, sourceScreen.height / layout.height);
  return { scale, x: sourceScreen.x + sourceScreen.width / 2 - layout.width * scale / 2, y: sourceScreen.y + sourceScreen.height / 2 - layout.height * scale / 2 };
}
export function interpolateProjectCamera(from: MapCamera, to: MapCamera, progress: number): MapCamera { const p = progress * progress * (3 - 2 * progress); return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p, scale: from.scale + (to.scale - from.scale) * p }; }
export function restoreProjectCamera(camera: MapCamera, previous: MapViewport, next: MapViewport): MapCamera { return { ...camera, x: camera.x + (next.width - previous.width) / 2, y: camera.y + (next.height - previous.height) / 2 }; }
/** Keep a resized default view inside fitting axes without changing reading scale. */
export function resizeProjectCamera(camera: MapCamera, layout: Pick<ProjectMapLayout, "width" | "height">, previous: MapViewport, next: MapViewport, manual = false): MapCamera {
  const restored = clampProjectCamera(restoreProjectCamera(camera, previous, next), layout, next);
  // Manual pan bounds deliberately allow 48px of travel. A default view should
  // not spend that allowance clipping a world which now fits after dock resize.
  // Oversized axes retain their reading position for the selected-card reveal.
  if (manual) return restored;
  const spareWidth = next.width - layout.width * restored.scale, spareHeight = next.height - layout.height * restored.scale;
  return {
    ...restored,
    x: spareWidth >= 0 ? Math.max(0, Math.min(spareWidth, restored.x)) : restored.x,
    y: spareHeight >= 0 ? Math.max(0, Math.min(spareHeight, restored.y)) : restored.y
  };
}
