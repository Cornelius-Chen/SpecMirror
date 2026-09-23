import type { AgentRun } from "@epm/domain";

export interface CodexSmokeValidationInput {
  run: Pick<AgentRun, "status" | "events">;
  finalChangeStatus?: string;
  startSha: string;
  finalMain: string;
  markerPresent: boolean;
}

function latestRunFailure(events: readonly string[]) {
  const event = [...events].reverse().find(item => item.trim());
  return (event ?? "run_failed_without_recorded_event").replace(/\s+/g, " ").slice(0, 800);
}

/**
 * Validate the real run before touching an optional integration checkpoint.
 * The callback stays lazy so a failed App Server run cannot be hidden by a
 * subsequent `git rev-parse` failure for a checkpoint that was never created.
 */
export function validateCodexSmoke(
  input: CodexSmokeValidationInput,
  readCheckpoint: () => string | null
) {
  const changeStatus = input.finalChangeStatus ?? "missing";
  if (input.run.status !== "verified" || changeStatus !== "verified") {
    throw new Error(`smoke_run_failed:run=${input.run.status}:change=${changeStatus}:cause=${latestRunFailure(input.run.events)}`);
  }
  if (input.finalMain === input.startSha) throw new Error("smoke_main_not_merged");
  if (!input.markerPresent) throw new Error("smoke_marker_missing");
  const checkpoint = readCheckpoint();
  if (!checkpoint) throw new Error("smoke_checkpoint_missing");
  if (checkpoint !== input.startSha) throw new Error(`smoke_checkpoint_mismatch:expected=${input.startSha}:actual=${checkpoint}`);
  return checkpoint;
}
