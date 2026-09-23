import { effectiveEngineeringConstraints, engineeringContractKey, engineeringLineage, type EngineeringDocument, type EngineeringNode, type EngineeringRun } from "../../packages/domain/src/engineering.ts";

/** A reviewed leaf whose parent still needs its own integration review. */
export function attentionDocument(stage: "parent-review" | "root-review" | "parent-paused" = "parent-review"): EngineeringDocument {
  const at = "2026-09-05T10:30:00.000Z";
  const node = (id: string, parent: string | null, title: string): EngineeringNode => ({ id, parent_id: parent, kind: parent ? "task" : "project", title,
    objective: "逐层核对交付，父级不能自动验收", method: "核对本层冻结条件与子任务证据", architecture: "", owner: "项目负责人", order: 0, revision: 1, status: "draft", dependencies: [], contributes_to: parent ? [`${parent}-criterion`] : [],
    constraints: { allow: ["deliverables/**"], deny: [], rules: [], resources: [] }, criteria: [{ id: `${id}-criterion`, text: `${title}的本层整合通过`, kind: "manual", path: "", expected: "" }], actions: [], capabilities: [], created_at: at, updated_at: at });
  const root = node("project", null, "完整层级验收工程"), parent = node("research", "project", "中层交付整合"), leaf = node("source-check", "research", "核对交付资料"), archived = node("archived", "project", "历史验收已归档");
  archived.status = "archived";
  const doc: EngineeringDocument = { schema_version: 1, id: "attention-fixture", revision: 7, root_id: root.id, nodes: [root, parent, leaf, archived], runs: [], changes: [], events: [], capability_uses: [], created_at: at, updated_at: at };
  const run = (current: EngineeringNode, state: "accepted" | "review"): EngineeringRun => {
    current.status = state;
    const children = doc.nodes.filter((child) => child.parent_id === current.id && child.status !== "archived").map((child) => { const result = doc.runs.find((item) => item.node_id === child.id && item.status === "accepted")!; return { node_id: child.id, run_id: result.id, contract_key: result.snapshot.contract_key }; });
    return { id: `run-${current.id}`, node_id: current.id, mode: children.length ? "integration" : "controlled", status: state, actor: "fixture reviewer", snapshot: { node: structuredClone(current), lineage: engineeringLineage(doc, current.id).map((item) => ({ id: item.id, revision: item.revision })), effective: effectiveEngineeringConstraints(doc, current.id), contract_key: engineeringContractKey(doc, current.id), dependencies: [], children },
      started_at: at, finished_at: at, current_action: "", completed_action_ids: [], evidence: [{ id: `evidence-${current.id}`, criterion_id: `${current.id}-criterion`, kind: "human", summary: "此测试预置的已核对下级交付", passed: true, created_at: at }], output_dir: "", reason: "", review_note: state === "accepted" ? "测试前已明确通过本层验收" : "", reviewed_at: state === "accepted" ? at : null };
  };
  doc.runs.push(run(leaf, "accepted"));
  doc.runs.push(run(parent, stage === "root-review" ? "accepted" : "review"));
  if (stage === "root-review") doc.runs.push(run(root, "review"));
  if (stage === "parent-paused") parent.status = "paused";
  return doc;
}
