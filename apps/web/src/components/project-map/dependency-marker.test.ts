import { describe, expect, it } from "vitest";
import { dependencyMarkerGeometry } from "./ProjectStructureMap.tsx";

describe("project-map dependency markers", () => {
  it("uses fixed screen-space geometry and only enlarges emphasized arrows", () => {
    expect(dependencyMarkerGeometry(false)).toEqual({
      size: 7,
      refX: 6,
      refY: 3.5,
      markerUnits: "userSpaceOnUse",
      d: "M 0 0 L 7 3.5 L 0 7 z"
    });
    expect(dependencyMarkerGeometry(true)).toEqual({
      size: 8,
      refX: 7,
      refY: 4,
      markerUnits: "userSpaceOnUse",
      d: "M 0 0 L 8 4 L 0 8 z"
    });
  });
});
