import { describe, expect, it } from "vitest";
import { deriveEngineeringView } from "@epm/domain";
import type { EngineeringFeedback, EngineeringFeedbackTarget } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { inspectorDocument, inspectorNode, inspectorScenario } from "../../../../../tests/fixtures/project-inspector.ts";
import { graphFeedbackContext, graphFeedbackRecords, graphFeedbackRecordStatus } from "./GraphFeedbackCard.tsx";

function feedback(id: string, target: EngineeringFeedbackTarget, extra: Partial<EngineeringFeedback> = {}): EngineeringFeedback {
  return { id, target, kind: "defect", note: "这处结果还需要核对", status: "open", base_document_revision: 1, base_node_revision: 1,
    base_contract_key: "test", base_lineage: [], base_run_id: null, target_snapshot: "{}", created_at: "2026-09-06T12:00:00Z", updated_at: "2026-09-06T12:00:00Z", history: [], ...extra };
}

describe("graph feedback context and original location", () => {
  it("does not confuse same-named relation IDs owned by different nodes", () => {
    const doc = inspectorDocument();
    doc.nodes.push(inspectorNode("other", "root"));
    const target = { kind: "relation" as const, node_id: "step", id: "input:shared" };
    doc.feedbacks = [feedback("here", target), feedback("elsewhere", { ...target, node_id: "other" })];
    expect(graphFeedbackRecords(deriveEngineeringView(doc), target).map(item => item.id)).toEqual(["here"]);
  });

  it("shows one range opinion at each included node while keeping per-node processing under the group", () => {
    const doc = inspectorDocument(); doc.nodes.push(inspectorNode("other", "root"));
    const group = feedback("group", { kind: "node", node_id: "root" }, { scope_node_ids: ["step", "other"], scope_feedback_ids: ["one", "two"] });
    doc.feedbacks = [group, feedback("one", { kind: "node", node_id: "step" }, { scope_group_id: "group" }), feedback("two", { kind: "node", node_id: "other" }, { scope_group_id: "group" })];
    const view = deriveEngineeringView(doc);
    expect(graphFeedbackRecords(view, { kind: "node", node_id: "step" }).map(item => item.id)).toEqual(["group"]);
    expect(graphFeedbackRecords(view, { kind: "node", node_id: "other" }).map(item => item.id)).toEqual(["group"]);
    expect(graphFeedbackRecords(view, group.target, ["other", "step"]).map(item => item.id)).toEqual(["group"]);
    expect(graphFeedbackRecords(view, group.target, ["root", "step"]).map(item => item.id)).toEqual([]);
  });

  it("keeps a stale or removed feedback target readable without allowing a new submission there", () => {
    const doc = inspectorDocument();
    const view = deriveEngineeringView(doc);
    expect(graphFeedbackContext(view, { kind: "relation", node_id: "step", id: "input:removed" })).toMatchObject({ title: "原联系已变化", exists: false });
    expect(graphFeedbackContext(view, { kind: "node", node_id: "removed" })).toMatchObject({ title: "原位置已不存在", exists: false });
    doc.nodes[1].status = "archived";
    expect(graphFeedbackContext(deriveEngineeringView(doc), { kind: "node", node_id: "root" }, undefined, ["root", "step"]).exists).toBe(false);
  });

  it("does not present a lost execution connection as live activity in the card", () => {
    const { view, nodeId } = inspectorScenario("running");
    const before = JSON.stringify(view);
    expect(graphFeedbackContext(view, { kind: "node", node_id: nodeId }, undefined, [], true).fact).toBe("执行状态待更新，暂不判断正在运行。");
    expect(JSON.stringify(view)).toBe(before);
  });

  it("does not keep a historical resolved label when its closure no longer matches the current result", () => {
    const doc = inspectorDocument();
    const child = feedback("old-closure", { kind: "node", node_id: "step" }, { status: "resolved", resolution_kind: "delivery" });
    doc.feedbacks = [child];
    expect(graphFeedbackRecordStatus(deriveEngineeringView(doc), child)).toMatchObject({ label: "需复核" });
  });
});
