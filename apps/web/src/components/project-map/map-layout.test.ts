import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, deriveEngineeringView, type EngineeringDocument } from "@epm/domain";
import { projectMapLayout, projectMapRelations, visibleProjectCards } from "./map-layout.ts";
import { clampProjectCamera, fitProjectCamera, interpolateProjectCamera, preserveProjectWorldAnchor, projectEntryCamera, projectScreenRect, restoreProjectCamera, revealProjectRectCamera, semanticDensityForScale, zoomProjectCamera } from "./map-camera.ts";
const now = "2026-09-05T12:00:00Z";
const node = (id: string, parent_id: string | null, extra: Record<string, unknown> = {}) => EngineeringNodeSchema.parse({ id, parent_id, title: "工程成果 " + id, kind: parent_id ? "task" : "project", order: 0, revision: 1, status: "draft", constraints: { allow: [], deny: [], rules: [], resources: [] }, created_at: now, updated_at: now, ...extra });
const doc = (nodes = [node("root", null), node("a", "root"), node("b", "root", { order: 1 }), node("task", "a"), node("component", "task"), node("leaf", "component")]): EngineeringDocument => ({ schema_version: 1, id: "map", root_id: "root", revision: 1, created_at: now, updated_at: now, nodes, runs: [], events: [], changes: [], capability_uses: [] });
const viewport = { width: 1200, height: 560 };

describe("project structure layout and camera", () => {
  it("starts at the engineering root and supports each real level without inventing a fixed depth", () => {
    const view = deriveEngineeringView(doc());
    expect(projectMapLayout(view, null, viewport).cards.map(card => card.id)).toEqual(["a", "b"]);
    for (const [focus, child] of [["a", "task"], ["task", "component"], ["component", "leaf"]]) expect(projectMapLayout(view, focus, viewport).cards.map(card => card.id)).toEqual([child]);
    expect(projectMapLayout(view, "leaf", viewport)).toMatchObject({ cards: [], path: ["root", "a", "task", "component", "leaf"] });
  });
  it("retains positions across status, evidence and dependency refreshes", () => {
    const document = doc(), before = projectMapLayout(deriveEngineeringView(document), "root", viewport);
    document.nodes[1].status = "blocked"; document.nodes[2].dependencies = ["a"]; document.revision++;
    const after = projectMapLayout(deriveEngineeringView(document), "root", viewport);
    expect(after).toEqual(before);
    expect(projectMapRelations(deriveEngineeringView(document), after)).toEqual([expect.objectContaining({ from: "a", to: "b" })]);
  });
  it("lays out all two thousand children while only mounting viewport neighbours and a selected result", () => {
    const document = doc([node("root", null), ...Array.from({ length: 2000 }, (_, i) => node("child-" + i, "root", { order: i }))]);
    const layout = projectMapLayout(deriveEngineeringView(document), "root", viewport), camera = fitProjectCamera(layout, viewport);
    expect(layout.cards).toHaveLength(2000);
    expect(visibleProjectCards(layout, camera, viewport).length).toBeLessThan(30);
    expect(visibleProjectCards(layout, camera, viewport, "child-1999").some(card => card.id === "child-1999")).toBe(true);
  }, 10_000);
  it("falls back from archived or missing focus and excludes archived children", () => {
    const view = deriveEngineeringView(doc([node("root", null), node("old", "root", { status: "archived" }), node("active", "root")]));
    for (const id of ["old", "missing"]) expect(projectMapLayout(view, id, viewport)).toMatchObject({ focusId: "root", cards: [expect.objectContaining({ id: "active" })] });
  });
  it("keeps inherited and outside-scope dependencies separate from containment", () => {
    const document = doc(); document.nodes[1].dependencies = ["b"];
    const view = deriveEngineeringView(document), layout = projectMapLayout(view, "task", viewport);
    expect(projectMapRelations(view, layout)).toEqual([expect.objectContaining({ from: "b", to: "component", inherited: true, origin: "a" })]);
    expect(layout.cards.map(card => card.id)).toEqual(["component"]);
  });
  it("begins an entering scene inside the clicked region and interpolates a continuous camera", () => {
    const target = projectMapLayout(deriveEngineeringView(doc()), "a", viewport), clicked = { x: 270, y: 185, width: 280, height: 176 }, from = projectEntryCamera(target, clicked), to = fitProjectCamera(target, viewport);
    const initialBounds = projectScreenRect({ x: 0, y: 0, width: target.width, height: target.height }, from);
    expect(initialBounds.x + initialBounds.width / 2).toBeCloseTo(clicked.x + clicked.width / 2); expect(initialBounds.y + initialBounds.height / 2).toBeCloseTo(clicked.y + clicked.height / 2);
    expect(initialBounds.width).toBeLessThanOrEqual(clicked.width); expect(initialBounds.height).toBeLessThanOrEqual(clicked.height);
    const early = interpolateProjectCamera(from, to, .1), middle = interpolateProjectCamera(from, to, .5);
    expect(early.scale - from.scale).toBeLessThan((to.scale - from.scale) * .04);
    expect(middle.scale).toBeGreaterThan(from.scale); expect(middle.scale).toBeLessThan(to.scale);
    expect(interpolateProjectCamera(from, to, 1)).toEqual(to);
  });
  it("zooms around the pointer and restores the same world centre after a viewport change", () => {
    const before = { x: -35, y: -70, scale: 1 }, pointer = { x: 220, y: 160 }, after = zoomProjectCamera(before, 1.3, pointer);
    expect((pointer.x - after.x) / after.scale).toBeCloseTo((pointer.x - before.x) / before.scale);
    expect((pointer.y - after.y) / after.scale).toBeCloseTo((pointer.y - before.y) / before.scale);
    const restored = restoreProjectCamera(before, { width: 900, height: 360 }, { width: 900, height: 560 }); expect(restored).toEqual({ ...before, y: 30 });
    expect(restoreProjectCamera(restored, { width: 900, height: 560 }, { width: 900, height: 360 })).toEqual(before);
  });
  it("preserves a clicked card across a local layout reflow even beyond normal fit padding", () => {
    const before = { x: -48, y: 181, scale: 1 }, oldPoint = { x: 621, y: 469 }, nextPoint = { x: 749, y: 469 };
    const after = preserveProjectWorldAnchor(before, oldPoint, nextPoint);
    expect(after).toEqual({ x: -176, y: 181, scale: 1 });
    expect(projectScreenRect({ ...nextPoint, width: 0, height: 0 }, after)).toMatchObject(projectScreenRect({ ...oldPoint, width: 0, height: 0 }, before));
  });
  it("keeps a fitting DOM scene at native scale and aligns its resting translation to device pixels", () => {
    expect(fitProjectCamera({ width: 1608, height: 352 }, { width: 1608, height: 742.2 }, .42, 1)).toEqual({ scale: 1, x: 0, y: 195 });
    expect(fitProjectCamera({ width: 800, height: 320 }, { width: 1001, height: 701 }, .42, 1.25)).toEqual({ scale: 1, x: 100.8, y: 190.4 });
    expect(fitProjectCamera({ width: 1608, height: 352 }, { width: 1608, height: 742.2 }, .42, 1, { x: 301, y: 258.796875 })).toEqual({ scale: 1, x: 0, y: 195.203125 });
    expect(fitProjectCamera({ width: 1800, height: 900 }, { width: 1000, height: 600 }, .42, 1).scale).toBeLessThan(1);
  });
  it("derives automatic information density from the readable scale", () => {
    expect(semanticDensityForScale(.57)).toBe("overview");
    expect(semanticDensityForScale(.58)).toBe("structure");
    expect(semanticDensityForScale(.89)).toBe("structure");
    expect(semanticDensityForScale(.9)).toBe("detail");
  });
  it("constrains dragging without making far-away children unreachable", () => {
    const bounds = { width: 500, height: 9000 }, camera = clampProjectCamera({ x: -90000, y: -90000, scale: .8 }, bounds, viewport);
    expect(camera.y + bounds.height * camera.scale).toBe(512);
    expect(camera.x).toBeGreaterThan(-1000);
  });
  it("reveals a distant result by panning while preserving the readable zoom", () => {
    const before = { x: 24, y: -120, scale: .82 };
    const revealed = revealProjectRectCamera({ x: 420, y: 4604, width: 208, height: 120 }, before, { width: 1024, height: 700 });
    const screen = projectScreenRect({ x: 420, y: 4604, width: 208, height: 120 }, revealed);
    expect(revealed.scale).toBe(before.scale);
    expect(screen.x).toBeGreaterThanOrEqual(36);
    expect(screen.x + screen.width).toBeLessThanOrEqual(1024 - 36);
    expect(screen.y).toBeGreaterThanOrEqual(36);
    expect(screen.y + screen.height).toBeLessThanOrEqual(700 - 36);
  });
});
