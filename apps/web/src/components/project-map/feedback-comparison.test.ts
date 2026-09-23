import { describe, expect, it } from "vitest";
import { deriveEngineeringView } from "@epm/domain";
import type { EngineeringFeedback } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { inspectorDocument, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { projectFeedbackArtifacts, projectFeedbackComparison } from "./feedback-comparison.ts";

const feedback = (extra: Partial<EngineeringFeedback> = {}): EngineeringFeedback => ({
  id: "feedback", target: { kind: "node", node_id: "step" }, kind: "defect", note: "成果不清楚", status: "review",
  base_document_revision: 1, base_node_revision: 1, base_contract_key: "old", base_lineage: [], base_run_id: null,
  target_snapshot: "{}", created_at: "2026-09-06T12:00:00Z", updated_at: "2026-09-06T12:00:00Z", history: [], ...extra
});

describe("feedback change and result projection", () => {
  it("uses only the recorded impact and shows readable outcome differences", () => {
    const doc = inspectorDocument(), before = structuredClone(doc.nodes[1]);
    const after = { ...structuredClone(before), revision: before.revision + 1, objective: "交付一份可以直接复核的因子报告" };
    doc.nodes[1] = structuredClone(after); doc.changes.push({ id: "change", at: doc.updated_at, node_id: "step", reason: "补齐结果说明", before, after, affected_ids: ["step", "root"] });
    const result = projectFeedbackComparison(deriveEngineeringView(doc), feedback({ adopted_change_id: "change" }));
    expect(result).toMatchObject({ state: "recorded", currentAfter: true, affected: [{ id: "step" }, { id: "root" }] });
    expect(result.fields).toEqual([{ id: "objective", label: "目标", before: before.objective, after: after.objective }]);
  });
  it("does not accept missing, wrong-node, or superseded changes as current", () => {
    const doc = inspectorDocument(), item = feedback({ adopted_change_id: "change" });
    expect(projectFeedbackComparison(deriveEngineeringView(doc), item).state).toBe("missing");
    doc.changes.push({ id: "change", at: doc.updated_at, node_id: "root", reason: "wrong", before: doc.nodes[0], after: doc.nodes[0], affected_ids: ["root"] });
    expect(projectFeedbackComparison(deriveEngineeringView(doc), item).state).toBe("missing");
    doc.changes[0] = { ...doc.changes[0], node_id: "step", before: structuredClone(doc.nodes[1]), after: structuredClone(doc.nodes[1]), affected_ids: ["step"] };
    doc.nodes[1].revision++;
    expect(projectFeedbackComparison(deriveEngineeringView(doc), item)).toMatchObject({ state: "historical", currentAfter: false });
  });
  it("opens only hashed artifacts from the explicitly linked same-node run", () => {
    const doc = inspectorDocument(), run = inspectorRun(doc, "step", "review");
    run.evidence = [
      { id: "good", criterion_id: "step-manual", kind: "artifact", summary: "因子质量报告", path: "reports/factor.html", sha256: "a".repeat(64), passed: null, created_at: doc.updated_at },
      { id: "no-hash", criterion_id: "step-manual", kind: "artifact", summary: "没有校验值", path: "unsafe.html", passed: null, created_at: doc.updated_at },
      { id: "check", criterion_id: "step-manual", kind: "check", summary: "检查", path: "check.txt", sha256: "b".repeat(64), passed: true, created_at: doc.updated_at }
    ]; doc.runs.push(run); doc.nodes[1].status = "review";
    let result = projectFeedbackArtifacts(deriveEngineeringView(doc), feedback({ submitted_run_id: run.id }));
    expect(result).toMatchObject({ state: "current", label: "已修改，等待你查看" }); expect(result.artifacts.map(item => item.id)).toEqual(["good"]);
    result = projectFeedbackArtifacts(deriveEngineeringView(doc), feedback({ target: { kind: "node", node_id: "root" }, submitted_run_id: run.id }));
    expect(result).toMatchObject({ state: "missing", artifacts: [] });
  });
});
