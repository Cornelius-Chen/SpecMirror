export interface ProjectMapRoutingClearance {
  compositionLane: number;
  rootCorridor: number;
  dependencyBoundary: number;
  dependencyLane: number;
}

const quantizedWorldDistance = (screenPixels: number, scale: number, minimum: number) => {
  const safeScale = Math.max(.12, Math.min(1.7, Number.isFinite(scale) ? scale : 1));
  return Math.max(minimum, Math.ceil(screenPixels / safeScale / 4) * 4);
};

/**
 * Routing happens in the transformed world while people judge spacing on the
 * screen. Convert the visual safety contract back to world units, otherwise a
 * valid 10px lane becomes an unreadable 2px lane after fitting a large map.
 */
export function projectMapRoutingClearance(scale: number): ProjectMapRoutingClearance {
  return {
    compositionLane: quantizedWorldDistance(17, scale, 18),
    rootCorridor: quantizedWorldDistance(13, scale, 12),
    dependencyBoundary: quantizedWorldDistance(9, scale, 10),
    dependencyLane: quantizedWorldDistance(7, scale, 8)
  };
}
