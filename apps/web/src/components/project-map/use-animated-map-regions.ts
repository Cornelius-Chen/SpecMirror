import { useLayoutEffect, useRef } from "react";
import { advanceAnimatedRegions, type AnimatedMapRegions, type AnimatedRegionFrameInput, type AnimatedRegionFrameState } from "./animated-map-regions.ts";

/** Consume the node RAF and commit its displayed snapshot; equal frames retain identity across camera renders. */
export function useAnimatedMapRegions(input: AnimatedRegionFrameInput): AnimatedMapRegions {
  const committed = useRef<AnimatedRegionFrameState | undefined>(undefined);
  const next = advanceAnimatedRegions(input, committed.current);
  useLayoutEffect(() => { committed.current = next; }, [next]);
  return next.snapshot;
}
