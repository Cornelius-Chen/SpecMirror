import { describe, expect, it } from "vitest";
import { searchOrthogonalRoute, type OrthogonalRoutePort } from "./orthogonal-route-search.ts";
import { dependencySegmentCrossesRect } from "./dependency-routing.ts";

const source = (y: number, cost = 0): OrthogonalRoutePort => ({ terminal: { x: 20, y }, point: { x: 26, y }, cost });
const target = (y: number, cost = 0): OrthogonalRoutePort => ({ terminal: { x: 177, y }, point: { x: 174, y }, cost });
describe("one orthogonal graph with alternative endpoints", () => {
  it("chooses a reachable endpoint without repeating the obstacle graph for each port pair", () => {
    const obstacles = [{ id: "wall", left: 80, right: 120, top: 0, bottom: 100 }];
    let checks = 0;
    const path = searchOrthogonalRoute({ sources: [source(30), source(130, 10)], targets: [target(30), target(130, 10)], xs: [0, 80, 120, 200], ys: [0, 100, 150], obstacles, segmentCost: () => { checks++; return 0; } });
    expect(path).toEqual([{ x: 20, y: 130 }, { x: 177, y: 130 }]);
    for (const [i, b] of path.slice(1).entries()) expect(dependencySegmentCrossesRect(path[i]!, b, obstacles[0]!)).toBe(false);
    expect(checks).toBeGreaterThan(0);
  });

  it("keeps an assigned port when geometric savings only come from moving along the card", () => {
    const path = searchOrthogonalRoute({ sources: [source(30), source(60, 30.03)], targets: [target(90)], xs: [100], ys: [0, 120], obstacles: [], segmentCost: () => 0 });
    expect(path[0]).toEqual({ x: 20, y: 30 }); expect(path.at(-1)).toEqual({ x: 177, y: 90 });
  });

  it("does not reuse occupancy from an earlier search", () => {
    const input = { sources: [source(60)], targets: [target(60)], xs: [80, 120], ys: [20, 100], obstacles: [] };
    const before = searchOrthogonalRoute({ ...input, segmentCost: () => 0 });
    const blocked = { id: "reserved", left: 70, right: 130, top: 55, bottom: 65 };
    const after = searchOrthogonalRoute({ ...input, segmentCost: (a, b) => dependencySegmentCrossesRect(a, b, blocked) ? undefined : 0 });
    expect(before).toEqual([{ x: 20, y: 60 }, { x: 177, y: 60 }]);
    expect(after).not.toEqual(before); expect(after.length).toBeGreaterThan(2);
    for (const [i, b] of after.slice(1).entries()) expect(dependencySegmentCrossesRect(after[i]!, b, blocked)).toBe(false);
  });

  it("reports an impossible route without a fallback through a solid obstacle", () => {
    expect(searchOrthogonalRoute({ sources: [source(30), source(60)], targets: [target(30), target(60)], xs: [0, 80, 120, 200], ys: [10, 90],
      obstacles: [{ id: "closed", left: 80, right: 120, top: 0, bottom: 100 }], segmentCost: () => 0 })).toEqual([]);
  });
});
