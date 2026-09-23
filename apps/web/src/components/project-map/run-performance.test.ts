import { describe, expect, it } from "vitest";
import { deriveEngineeringView, type EngineeringRunMetrics } from "@epm/domain";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { durationLabel, projectRunPerformance, tokenLabel } from "./run-performance.ts";

const metrics = (baseline: number, latest: number, state: EngineeringRunMetrics["state"]): EngineeringRunMetrics => ({
  source: "codex_rollout", attribution: "assigned_task_window", state,
  baseline: { input_tokens: baseline, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: baseline, observed_at: "2026-09-11T10:00:00.000Z" },
  latest: { input_tokens: latest, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: latest, observed_at: "2026-09-11T10:15:00.000Z" },
  token_usage: { input_tokens: latest - baseline, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: latest - baseline }
});

describe("project run performance", () => {
  it("measures actual overlap without claiming an invented speedup", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("one", "root"), inspectorNode("two", "root")]);
    const one = inspectorRun(doc, "one", "accepted", "external"), two = inspectorRun(doc, "two", "review", "external");
    one.started_at = "2026-09-11T10:00:00.000Z"; one.finished_at = "2026-09-11T10:10:00.000Z"; one.metrics = metrics(100, 140, "final");
    two.started_at = "2026-09-11T10:05:00.000Z"; two.finished_at = "2026-09-11T10:15:00.000Z"; two.metrics = metrics(200, 260, "observed");
    doc.runs.push(one, two);
    expect(projectRunPerformance(deriveEngineeringView(doc), "root")).toEqual({
      runCount: 2, runningCount: 0, measuredTokenRuns: 2,
      agentMs: 20 * 60_000, wallMs: 15 * 60_000, overlapMs: 5 * 60_000, peakParallel: 2,
      totalTokens: 100, tokenState: "observed"
    });
  });

  it("ignores unclaimed and stale records", () => {
    const doc = inspectorDocument();
    const unclaimed = inspectorRun(doc, "step", "queued", "external");
    const stale = inspectorRun(doc, "step", "accepted", "external"); doc.nodes[1].revision++;
    doc.runs.push(unclaimed, stale);
    expect(projectRunPerformance(deriveEngineeringView(doc), "root").runCount).toBe(0);
  });

  it("formats compact human-readable values", () => {
    expect(durationLabel(42_000)).toBe("42 秒");
    expect(durationLabel(75 * 60_000)).toBe("1 小时 15 分");
    expect(tokenLabel(9_500)).toBe("9.5k");
    expect(tokenLabel(2_400_000)).toBe("2.4m");
  });
});
