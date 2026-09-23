import { describe, expect, it } from "vitest";
import { projectMapRoutingClearance } from "./map-routing-clearance.ts";

describe("projectMapRoutingClearance", () => {
  it("keeps every fitted map lane above its screen-space readability contract", () => {
    for (const scale of [1, .76, .33, .18, .12]) {
      const result = projectMapRoutingClearance(scale);
      expect(result.compositionLane * scale).toBeGreaterThanOrEqual(17);
      expect(result.rootCorridor * scale).toBeGreaterThanOrEqual(13);
      expect(result.dependencyBoundary * scale).toBeGreaterThanOrEqual(9);
      expect(result.dependencyLane * scale).toBeGreaterThanOrEqual(7);
    }
  });

  it("uses stable four-unit channels and ignores invalid scale input", () => {
    expect(projectMapRoutingClearance(.33)).toEqual({ compositionLane: 52, rootCorridor: 40, dependencyBoundary: 28, dependencyLane: 24 });
    expect(projectMapRoutingClearance(Number.NaN)).toEqual(projectMapRoutingClearance(1));
  });
});
