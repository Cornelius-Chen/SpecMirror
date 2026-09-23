import { describe, expect, it } from "vitest";
import { createDependencyReadabilityQuery } from "./dependency-readability-query.ts";
import { dependencyReadabilityPenalty, type DependencyPoint, type DependencyRect, type RoutingSegment } from "./dependency-routing.ts";

const point = (x: number, y: number): DependencyPoint => ({ x, y });
const line = (ax: number, ay: number, bx: number, by: number, id?: string): RoutingSegment => ({ id, a: point(ax, ay), b: point(bx, by) });

describe("per-relation readability lane queries", () => {
  it("matches the original scanner exactly across near-axis, reversed and negative-coordinate queries", () => {
    const boundaries: DependencyRect[] = [
      { id: "one", left: -35, right: 42, top: -20, bottom: 18 },
      { id: "reversed", left: 60, right: -18, top: 38, bottom: -45 },
      { id: "duplicate", left: -35, right: 42, top: -20, bottom: 18 },
      { id: "fractional", left: -.0004, right: 1.0002, top: -.0003, bottom: .0005 }
    ];
    const occupied = [line(-80, -12, 80, -12, "parallel"), line(53, 8, -31, 8),
      line(-24, -60, -24, 60, "shared"), line(27, 60, 27, -60, "shared"),
      line(-50, 23, 60, 23, ""), line(12, -50, 12, 50),
      line(-30, 10, 60, 10.0005, "nearly-horizontal"), line(14, -20, 14.0005, 50, "nearly-vertical"),
      line(.0002, -.0002, .0003, .0003, "both-axes"), line(-20, -20, 20, 20, "diagonal")];
    const queries: Array<[DependencyPoint, DependencyPoint]> = [];
    for (const at of [-60, -20, -12, -.0001, 0, .0001, 8, 18, 50]) for (const [low, high] of [[-90, 90], [-29, -28], [-29, -27.9995], [-.0002, .0002]]) {
      queries.push([point(low, at), point(high, at)], [point(at, low), point(at, high)],
        [point(low, at), point(high, at + .0005)], [point(at, low), point(at + .0005, high)]);
    }
    queries.push([point(-3, 2), point(10, 8)], [point(0, 0), point(.001, .001)]);
    for (const boundaryClearance of [-1, 0, .0005, .001, 8, 12]) for (const edgeSeparation of [0, .0005, .001, 8]) {
      const query = createDependencyReadabilityQuery(boundaries, occupied, boundaryClearance, edgeSeparation);
      for (const [a, b] of queries) for (const [from, to] of [[a, b], [b, a]]) {
        expect(query(from, to), `at ${JSON.stringify([from, to, boundaryClearance, edgeSeparation])}`).toEqual(
          dependencyReadabilityPenalty(from, to, boundaries, occupied, boundaryClearance, edgeSeparation));
      }
    }
  });

  it("keeps near-axis direction and exact clearance thresholds rather than rounding lane coordinates", () => {
    const boundary = { id: "outline", left: -20, right: 80, top: 0, bottom: 40 };
    const occupied = [line(-20, 0, 80, 0, "reserved")];
    const query = createDependencyReadabilityQuery([boundary], occupied, 8, 8);
    const a = point(0, 7.99875), b = point(20, 7.99925);
    expect(query(a, b)).toEqual({ cost: 183_600, hardConflict: true });
    expect(query(b, a)).toEqual({ cost: 0, hardConflict: false });
    expect(query(point(0, 7.999), point(20, 7.999))).toEqual({ cost: 0, hardConflict: false });
    expect(query(point(0, 0), point(1, 0))).toEqual({ cost: 0, hardConflict: false });
    expect(query(point(0, 0), point(1.0001, 0)).hardConflict).toBe(true);
  });

  it("preserves both near-axis branch precedence before crossing charges", () => {
    const occupied = [line(.0002, -4, .0002, 4, "vertical"), line(-4, .0002, 4, .0002, "horizontal")];
    const query = createDependencyReadabilityQuery([], occupied, 10, 10);
    const a = point(0, 0), b = point(.0004, .0004);
    expect(dependencyReadabilityPenalty(a, b, [], occupied, 10, 10)).toEqual({ cost: 0, hardConflict: false });
    expect(query(a, b)).toEqual({ cost: 0, hardConflict: false });
    const tiny = [line(0, 0, .0005, .0005, "both")];
    const tinyQuery = createDependencyReadabilityQuery([], tiny, 0, 10);
    // The tiny occupied segment is parallel before it can count as a crossing.
    expect(tinyQuery(point(-2, .0002), point(2, .0002))).toEqual({ cost: 0, hardConflict: false });
    expect(tinyQuery(point(.0002, -2), point(.0002, 2))).toEqual({ cost: 0, hardConflict: false });
  });

  it("charges each crossing identity once and retains anonymous original indices", () => {
    const occupied = [line(2, -5, 2, 5, "shared"), line(3, -5, 3, 5, "shared"),
      line(4, -5, 4, 5), line(5, -5, 5, 5, "2:4,-5:4,5"),
      line(6, -5, 6, 5, ""), line(7, -5, 7, 5, ""), line(-99, 90, 99, 90), line(8, -5, 8, 5)];
    const a = point(0, 0), b = point(10, 0);
    expect(dependencyReadabilityPenalty(a, b, [], occupied, 0, 0)).toEqual({ cost: 80_000, hardConflict: false });
    expect(createDependencyReadabilityQuery([], occupied, 0, 0)(a, b)).toEqual({ cost: 80_000, hardConflict: false });
  });

  it("snapshots one call's geometry and admits newly occupied lanes only in the next query", () => {
    const boundaries = [{ id: "outline", left: -20, right: 80, top: 100, bottom: 140 }];
    const occupied = [line(-20, 100, 80, 100, "first")];
    const query = createDependencyReadabilityQuery(boundaries, occupied, 8, 8);
    boundaries[0]!.top = 0; occupied[0]!.a.y = 0; occupied[0]!.b.y = 0;
    occupied.push(line(10, -20, 10, 20, "next"));
    // The first request deliberately occurs after the source changes: lazy
    // lane candidates must still consult the captured relation, not live input.
    const a = point(0, 0), b = point(20, 0);
    expect(query(a, b)).toEqual({ cost: 0, hardConflict: false });
    const next = createDependencyReadabilityQuery(boundaries, occupied, 8, 8);
    expect(next(a, b)).toEqual(dependencyReadabilityPenalty(a, b, boundaries, occupied, 8, 8));
    expect(next(a, b)).toEqual({ cost: 203_600, hardConflict: true });
  });

  it("reads the source geometry only during preparation, never per grid neighbour", () => {
    let reads = 0;
    const a = { get x() { reads++; return 10; }, get y() { reads++; return -20; } };
    const b = { get x() { reads++; return 10; }, get y() { reads++; return 20; } };
    const query = createDependencyReadabilityQuery([], [{ id: "one", a, b }], 0, 8);
    const preparedReads = reads; expect(preparedReads).toBe(4);
    for (let i = 0; i < 20; i++) expect(query(point(-i, 0), point(30 + i, 0))).toEqual({ cost: 20_000, hardConflict: false });
    expect(reads).toBe(preparedReads);
  });
});
