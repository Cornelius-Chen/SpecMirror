import { describe, expect, it } from "vitest";
import { nodeResultSummary, parseEngineeringRunResult, type EngineeringRunResult } from "./node-result-state.ts";

const result = (patch: Partial<EngineeringRunResult> = {}): EngineeringRunResult => ({
  schema_version: 1, kind: "engineering-run-result", workspace_id: "feedback-workspace", node_id: "step", run_id: "submitted-run",
  observed_at: "2026-09-13T12:00:00Z", contract_key: "frozen-feedback-version", node_revision: 1,
  run_status: "review", current_contract: true, started_at: "2026-09-13T11:00:00Z", finished_at: "2026-09-13T11:30:00Z",
  review: null, artifacts: [], source_checks: [{ id: "syntax", title: "源码检查", status: "passed", exit_code: 0 }], metrics: null, issues: [], ...patch
});

describe("feedback result material contract", () => {
  it("preserves the original review while flagging missing current-material evidence in a compatible response", () => {
    const value = result({ run_status: "accepted", review: { reviewed_at: "2026-09-13T11:45:00Z", review_note: "原人工复核意见" } });
    const before = structuredClone(value);
    const summary = nodeResultSummary(parseEngineeringRunResult(value), true);
    expect(summary).toMatchObject({ reviewed: true, label: "需要处理", tone: "attention" });
    expect(summary.issues).toContain("源码检查：当前材料尚未核实");
    expect(summary.summary).toBe("原人工验收记录已保留，当前材料需要处理。");
    expect(value).toEqual(before);
  });

  it.each(["review", "rejected", "blocked", "paused", "stale"] as const)("keeps missing current-material evidence visible for a %s result", run_status => {
    const summary = nodeResultSummary(result({ run_status }), false);
    expect(summary).toMatchObject({ current: false, reviewed: false, label: "需要处理" });
    expect(summary.issues).toContain("源码检查：当前材料尚未核实");
  });

  it.each(["queued", "running"] as const)("keeps an unexecuted check as a progress notice while %s", run_status => {
    for (const material_status of [undefined, "unrecorded"]) {
      const summary = nodeResultSummary(result({ run_status, finished_at: null,
        source_checks: [{ id: "syntax", title: "源码检查", status: "not_run", exit_code: null, ...(material_status ? { material_status } : {}) }]
      }), true);
      expect(summary.issues).toEqual([]);
      expect(summary.notices).toContain("源码检查：尚未执行检查");
      expect(summary.label).toBe(run_status === "queued" ? "等待执行" : "进行中");
    }
  });

  it("requires a recorded human review even when current source material is verified", () => {
    const value = result({ source_checks: [{ id: "syntax", title: "源码检查", status: "passed", exit_code: 0, material_status: "verified" }] });
    expect(nodeResultSummary(value, true)).toMatchObject({ reviewed: false, label: "待查收", issues: [] });
    expect(nodeResultSummary({ ...value, run_status: "accepted", review: { reviewed_at: "2026-09-13T11:45:00Z", review_note: "原人工复核意见" } }, true))
      .toMatchObject({ reviewed: true, label: "已验收", issues: [] });
  });
});
