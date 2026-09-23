import { describe, expect, it } from "vitest";
import { deriveEngineeringView } from "@epm/domain";
import { inspectorDocument, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { isResultArtifactPath, nodeResultRuns, nodeResultSummary, parseEngineeringRunResult, type EngineeringRunResult } from "./node-result-state.ts";

const result = (patch: Partial<EngineeringRunResult> = {}): EngineeringRunResult => ({
  schema_version: 1, kind: "engineering-run-result", workspace_id: "fixture-workspace", node_id: "step", run_id: "run-one",
  observed_at: "2026-09-12T21:00:00Z", contract_key: "frozen", node_revision: 1, run_status: "review", current_contract: true,
  started_at: "2026-09-12T20:00:00Z", finished_at: "2026-09-12T20:30:00Z", review: null, metrics: null,
  artifacts: [{ evidence_id: "output-one", path: "artifacts/node-result/report.md", recorded_sha256: "a".repeat(64), actual_sha256: "a".repeat(64), status: "verified" }], source_checks: [], issues: [], ...patch
});

describe("node result truth", () => {
  it("does not use a plan or historical accepted run as current execution", () => {
    const doc = inspectorDocument(); const run = inspectorRun(doc, "step", "accepted"); doc.runs.push(run); doc.nodes[1].revision++;
    const before = JSON.stringify(doc); const selection = nodeResultRuns(deriveEngineeringView(doc), "step");
    expect(selection.current).toBeUndefined(); expect(selection.history.map(item => item.id)).toEqual([run.id]); expect(JSON.stringify(doc)).toBe(before);
  });
  it("keeps automatic checks at pending review and requires an actual review timestamp", () => {
    expect(nodeResultSummary(result(), true).label).toBe("待查收");
    for (const review of [null, { reviewed_at: null, review_note: "通过" }, { reviewed_at: "bad-time", review_note: "通过" }]) {
      expect(nodeResultSummary(result({ run_status: "accepted", review }), true).label).toBe("需要处理");
    }
    const accepted = result({ run_status: "accepted", review: { reviewed_at: "2026-09-12T21:00:00Z", review_note: "已逐项核对" } });
    expect(nodeResultSummary(accepted, true)).toMatchObject({ label: "已验收", current: true });
    expect(nodeResultSummary({ ...accepted, current_contract: false, issues: [{ code: "historical_run", message: "历史运行" }] }, true)).toMatchObject({ label: "已验收", current: false });
    expect(nodeResultSummary(accepted, false).current).toBe(false);
  });
  it("detects material problems even if backend issues is empty and preserves original acceptance", () => {
    for (const status of ["missing", "changed", "unrecorded", "unreadable"] as const) {
      const value = result({ run_status: "accepted", review: { reviewed_at: "2026-09-12T21:00:00Z", review_note: "已核对" } });
      value.artifacts[0].status = status;
      expect(nodeResultSummary(value, true)).toMatchObject({ reviewed: true, label: "需要处理" });
    }
    const incomplete = result(); incomplete.artifacts[0].recorded_sha256 = null;
    expect(nodeResultSummary(incomplete, true).issues.join()).toContain("校验依据");
    expect(nodeResultSummary(result({ source_checks: [{ id: "check", title: "源码验证", status: "passed", exit_code: 0, material_status: "changed" }] }), true).issues.join()).toContain("内容已变化");
  });
  it("treats not-yet-produced materials as progress only while running or queued", () => {
    const value = result({ run_status: "running", artifacts: [], source_checks: [{ id: "check", title: "源码验证", status: "not_run", exit_code: null, material_status: "unrecorded" }], issues: [
      { code: "artifacts_not_recorded", message: "尚无产物" }, { code: "source_unrecorded", message: "暂无检查记录" }, { code: "source_check_not_passed", check_id: "check", message: "尚未检查" }
    ] });
    expect(nodeResultSummary(value, true)).toMatchObject({ label: "进行中", issues: [] });
    expect(nodeResultSummary({ ...value, run_status: "queued" }, true).label).toBe("等待执行");
    expect(nodeResultSummary({ ...value, run_status: "review" }, true).label).toBe("需要处理");
    value.source_checks[0].status = "failed";
    expect(nodeResultSummary(value, true).label).toBe("需要处理");
  });
  it("never suppresses actual changed or missing material during execution", () => {
    for (const code of ["source_changed", "source_missing", "artifact_missing", "check_not_passed", "source_proof_not_passed"]) {
      expect(nodeResultSummary(result({ run_status: "running", issues: [{ code, message: "真实问题" }] }), true).label).toBe("需要处理");
    }
  });
  it("rejects malformed payloads, tolerates additive fields, and keeps unknown metrics missing", () => {
    const value = result(); expect(parseEngineeringRunResult({ ...value, additional: "future" }).metrics).toBeNull();
    for (const invalid of [null, {}, { ...value, artifacts: [{}] }, { ...value, kind: "plan" }, { ...value, metrics: {} }]) expect(() => parseEngineeringRunResult(invalid)).toThrow();
    expect(isResultArtifactPath("artifacts/成果.md")).toBe(true);
    for (const path of ["C:/private/a", "../a", "/a", "a/../b", "a\\b", "javascript:alert(1)"]) expect(isResultArtifactPath(path)).toBe(false);
  });
});
