import { describe, expect, it } from "vitest";
import { AUTO_FIT_MIN_MAP_SCALE, clampProjectCamera, fitProjectCamera, fitReadingProjectCamera, interpolateProjectCamera, preserveProjectWorldAnchor, projectReadingContext, projectScreenRect, readingProjectCamera, resizeProjectCamera, restoreProjectCamera, revealAnchoredProjectRectCamera, type MapCamera } from "./map-camera.ts";

describe("inline expansion camera continuity", () => {
  it("keeps the observed four-column lowest route inside the default focus view at 85%", () => {
    // Anonymized camera/world measurements from actual-three/four-column-after.
    const before = { width: 986, height: 311.203125 }, focus = { width: 1278, height: 482 };
    const layout = { width: 1278, height: 528 }, camera = { x: 74, y: 5.9, scale: .85 };
    const ordinary = clampProjectCamera(restoreProjectCamera(camera, before, focus), layout, focus);
    expect(ordinary.x).toBeCloseTo(143.7); expect(ordinary.y).toBe(48);
    expect(522 * ordinary.scale + ordinary.y - focus.height).toBeCloseTo(9.7);
    const fitted = resizeProjectCamera(camera, layout, before, focus);
    expect(fitted.scale).toBe(.85); expect(fitted.x).toBe(ordinary.x); expect(fitted.y).toBeCloseTo(33.2);
    const world = projectScreenRect({ x: 0, y: 0, ...layout }, fitted);
    expect(world.x).toBeGreaterThanOrEqual(0); expect(world.y).toBeGreaterThanOrEqual(0);
    expect(world.x + world.width).toBeLessThanOrEqual(focus.width);
    expect(world.y + world.height).toBeLessThanOrEqual(focus.height);
    expect(522 * fitted.scale + fitted.y).toBeLessThan(focus.height);
    const selected = { x: 535, y: 28, width: 208, height: 120 }, child = { x: 403, y: 204, width: 208, height: 120 };
    const context = projectReadingContext(selected, child, focus, fitted.scale);
    expect(revealAnchoredProjectRectCamera(context.rect, fitted, layout, focus, context.padding)).toEqual(fitted);
  });

  it("preserves a manually chosen focus view even when the whole world could fit", () => {
    const before = { width: 986, height: 311.203125 }, focus = { width: 1278, height: 482 };
    const layout = { width: 1278, height: 528 }, camera = { x: 74, y: 5.9, scale: .85 };
    expect(resizeProjectCamera(camera, layout, before, focus, true)).toEqual(clampProjectCamera(restoreProjectCamera(camera, before, focus), layout, focus));
  });

  it("moves only a clipping fitting axis and leaves an already visible default view unchanged", () => {
    const layout = { width: 600, height: 400 }, before = { width: 800, height: 600 }, next = { width: 820, height: 620 };
    const camera = { x: 100, y: 100, scale: 1 };
    expect(resizeProjectCamera(camera, layout, before, next)).toEqual(restoreProjectCamera(camera, before, next));
    // A nearly full width has no room for the ordinary pan allowance, while
    // a tall axis should not jump to the start of an oversized project.
    const tall = { width: 800, height: 4000 }, viewport = { width: 800, height: 430 };
    const current = { x: -24, y: -1200, scale: 1 };
    expect(resizeProjectCamera(current, tall, viewport, viewport)).toEqual({ x: 0, y: -1200, scale: 1 });
  });

  it("keeps the reading scale through a short opinion dock and preserves the selected-card reveal", () => {
    const wide = { width: 1278, height: 482 }, narrow = { width: 378, height: 199 };
    const layout = { width: 378, height: 2800 }, camera = { x: 33.2, y: 33.2, scale: .85 };
    const resized = resizeProjectCamera(camera, layout, wide, narrow);
    const ordinary = clampProjectCamera(restoreProjectCamera(camera, wide, narrow), layout, narrow);
    expect(resized.scale).toBe(camera.scale); expect(resized.y).toBe(ordinary.y);
    const selected = { x: 85, y: 1084, width: 208, height: 120 }, child = { ...selected, y: 1260 };
    const context = projectReadingContext(selected, child, narrow, resized.scale);
    const revealed = revealAnchoredProjectRectCamera(context.rect, resized, layout, narrow, context.padding);
    const screen = projectScreenRect(selected, revealed);
    expect(revealed.scale).toBe(.85); expect(context.includesChild).toBe(false);
    expect(screen.x).toBeGreaterThanOrEqual(0); expect(screen.x + screen.width).toBeLessThanOrEqual(narrow.width);
    expect(screen.y).toBeGreaterThanOrEqual(0); expect(screen.y + screen.height).toBeLessThanOrEqual(narrow.height);
  });

  it("uses the short viewport margin to show the parent and first child before clipping to a readable title", () => {
    const parent = { x: 400, y: 204, width: 208, height: 120 }, child = { x: 400, y: 380, width: 208, height: 120 };
    const full = projectReadingContext(parent, child, { width: 1000, height: 280 }, .85);
    expect(full.complete).toBe(true); expect(full.rect.height).toBe(296); expect(full.padding).toBeCloseTo(14.2);
    const title = projectReadingContext(parent, child, { width: 1000, height: 220 }, .85);
    expect(title.complete).toBe(false); expect(title.includesChild).toBe(true); expect(title.rect.y + title.rect.height).toBe(child.y + 48);
    expect(projectReadingContext(parent, child, { width: 1000, height: 170 }, .85).includesChild).toBe(false);
  });

  it("fits selected visible content at reading scale and starts a huge branch with its parent and child", () => {
    const parent = { x: 400, y: 204, width: 208, height: 120 }, child = { x: 400, y: 380, width: 208, height: 120 };
    const viewport = { width: 1000, height: 280 };
    const fitted = fitReadingProjectCamera([parent, child, { ...child, y: 21324 }], parent, child, viewport);
    expect(fitted.scale).toBeGreaterThanOrEqual(.85);
    for (const rect of [parent, child]) {
      const screen = projectScreenRect(rect, fitted);
      expect(screen.y).toBeGreaterThanOrEqual(8); expect(screen.y + screen.height).toBeLessThanOrEqual(viewport.height - 8);
    }
    expect(fitReadingProjectCamera([parent, child], parent, child, { width: 1000, height: 600 }).scale).toBe(1);
  });

  it("opens a tall project at readable scale from its first row while explicit fit can show an overview", () => {
    const layout = { width: 1250, height: 2800 }, viewport = { width: 1250, height: 590 };
    const reading = readingProjectCamera(layout, viewport);
    expect(reading).toEqual({ scale: .85, x: 94, y: 22 });
    const root = projectScreenRect({ x: 521, y: 28, width: 208, height: 120 }, reading);
    expect(root.y).toBeGreaterThanOrEqual(22);
    expect(root.y + root.height).toBeLessThan(viewport.height);
    expect(fitProjectCamera(layout, viewport, AUTO_FIT_MIN_MAP_SCALE).scale).toBe(.42);
  });

  it("keeps a fitting new map at native scale and aligns its reading offset to device pixels", () => {
    expect(readingProjectCamera({ width: 1250, height: 352 }, { width: 1250, height: 590 })).toEqual({ scale: 1, x: 0, y: 119 });
    const origin = { x: 301, y: 258.796875 };
    const camera = readingProjectCamera({ width: 1608, height: 4000 }, { width: 1608, height: 742.2 }, 1.25, origin);
    expect(camera.scale).toBe(.85);
    expect((origin.x + camera.x) * 1.25).toBeCloseTo(Math.round((origin.x + camera.x) * 1.25));
    expect((origin.y + camera.y) * 1.25).toBeCloseTo(Math.round((origin.y + camera.y) * 1.25));
  });

  // Captured from five branches with two children each, opening branch three.
  // The expanded parent and first child remain fully readable after anchoring.
  it.each([
    { width: 1250, height: 704, oldAnchor: { x: 753, y: 264 }, nextAnchor: { x: 881, y: 264 }, rect: { x: 649, y: 204, width: 336, height: 296 }, anchoredX: -128, anchoredY: 31, ordinaryX: -48 },
    { width: 800, height: 880, oldAnchor: { x: 656, y: 264 }, nextAnchor: { x: 272, y: 440 }, rect: { x: 40, y: 380, width: 336, height: 296 }, anchoredX: 384, anchoredY: -145, ordinaryX: 48 }
  ])("does not follow an anchored expansion with a second horizontal trip at $width px", ({ width, height, oldAnchor, nextAnchor, rect, anchoredX, anchoredY, ordinaryX }) => {
    const viewport = { width, height: 590 }, layout = { width, height };
    const camera = preserveProjectWorldAnchor({ x: 0, y: 31, scale: 1 }, oldAnchor, nextAnchor);
    expect(camera).toEqual({ x: anchoredX, y: anchoredY, scale: 1 });
    const screen = projectScreenRect(rect, camera);
    expect(screen.x).toBeGreaterThanOrEqual(36);
    expect(screen.x + screen.width).toBeLessThanOrEqual(viewport.width - 36);
    expect(screen.y).toBeGreaterThanOrEqual(36);
    expect(screen.y + screen.height).toBeLessThanOrEqual(viewport.height - 36);

    const target = revealAnchoredProjectRectCamera(rect, camera, layout, viewport);
    expect(target).toEqual(camera);
    for (const progress of [0, .25, .5, .75, 1]) expect(interpolateProjectCamera(camera, target, progress)).toEqual(camera);
    // Explicit pan/zoom/fit retain their ordinary bounds; reveal is the exception.
    expect(clampProjectCamera(camera, layout, viewport).x).toBe(ordinaryX);
  });

  it("reveals an offscreen child vertically without losing the readable horizontal anchor", () => {
    const camera: MapCamera = { x: -128, y: 31, scale: 1 };
    const viewport = { width: 1250, height: 590 }, layout = { width: 1250, height: 1400 };
    const rect = { x: 649, y: 850, width: 208, height: 120 };
    const target = revealAnchoredProjectRectCamera(rect, camera, layout, viewport);
    expect(target).toEqual({ x: -128, y: -416, scale: 1 });
    const screen = projectScreenRect(rect, target);
    expect(screen.y + screen.height).toBe(viewport.height - 36);
    expect(target.y).toBe(clampProjectCamera(target, layout, viewport).y);
  });

  it("keeps a manually chosen reading point and scale when a dock changes viewport height", () => {
    const camera: MapCamera = { x: -180, y: -160, scale: .76 };
    const layout = { width: 2400, height: 1800 }, before = { width: 1250, height: 590 }, after = { width: 1250, height: 430 };
    const readingPoint = { x: (before.width / 2 - camera.x) / camera.scale, y: (before.height / 2 - camera.y) / camera.scale };
    const resized = clampProjectCamera(restoreProjectCamera(camera, before, after), layout, after);
    expect(resized.scale).toBe(camera.scale);
    expect(readingPoint.x * resized.scale + resized.x).toBeCloseTo(after.width / 2);
    expect(readingPoint.y * resized.scale + resized.y).toBeCloseTo(after.height / 2);
    expect(clampProjectCamera(restoreProjectCamera(resized, after, before), layout, before)).toEqual(camera);
  });
});
