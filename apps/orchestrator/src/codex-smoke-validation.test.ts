import { describe, expect, it, vi } from "vitest";
import { validateCodexSmoke } from "./codex-smoke-validation.ts";

const successful = {
  run: { status: "verified" as const, events: ["execution_completed"] },
  finalChangeStatus: "verified",
  startSha: "start-sha",
  finalMain: "merged-sha",
  markerPresent: true
};

describe("Codex real smoke result validation", () => {
  it("reports the real App Server failure before attempting to read a missing checkpoint", () => {
    const readCheckpoint = vi.fn(() => { throw new Error("fatal: ambiguous argument codex/checkpoint/missing"); });
    expect(() => validateCodexSmoke({
      ...successful,
      run: { status: "failed", events: ["App Server rejected sandbox=workspaceWrite; expected workspace-write"] },
      finalChangeStatus: "failed",
      finalMain: "start-sha",
      markerPresent: false
    }, readCheckpoint)).toThrow(/smoke_run_failed:.*App Server rejected sandbox=workspaceWrite; expected workspace-write/);
    expect(readCheckpoint).not.toHaveBeenCalled();
  });

  it("names a missing checkpoint after the run, merge and marker have succeeded", () => {
    expect(() => validateCodexSmoke(successful, () => null)).toThrow("smoke_checkpoint_missing");
  });

  it("returns the verified starting checkpoint", () => {
    expect(validateCodexSmoke(successful, () => "start-sha")).toBe("start-sha");
  });
});
