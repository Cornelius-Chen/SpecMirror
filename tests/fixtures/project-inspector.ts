import { EngineeringNodeSchema, deriveEngineeringView, effectiveEngineeringConstraints, engineeringContractKey, engineeringLineage, type EngineeringDocument, type EngineeringNode, type EngineeringRun, type EngineeringSourceProof, type FrozenEngineeringSourceScope } from "@epm/domain";

// Isolated render fixtures only. These records are never sent to the host API or a Hook.
export const stamp = "2026-09-05T00:00:00Z";
export function inspectorNode(id: string, parent: string | null, extra: Partial<EngineeringNode> = {}): EngineeringNode {
  return EngineeringNodeSchema.parse({ id, parent_id: parent, title: id === "root" ? "工程交付总目标" : `可完整阅读的任务 ${id}`, kind: parent ? "step" : "project", objective: "交付可直接使用并逐项核对的任务成果。", method: "先梳理需求，再制作可复核的成果。", owner: "未分配", order: 0, revision: 1, status: "draft", constraints: { allow: parent ? [] : ["output/**"], rules: ["未经验收不能代表交付完成。"] }, criteria: [{ id: id + "-manual", text: "成果符合本项要求", kind: "manual" }], created_at: stamp, updated_at: stamp, ...extra });
}
export function inspectorDocument(nodes = [inspectorNode("root", null), inspectorNode("step", "root")]): EngineeringDocument {
  return { schema_version: 1, id: "inspector-ui-fixture", root_id: "root", revision: 1, created_at: stamp, updated_at: stamp, nodes, runs: [], events: [], changes: [], capability_uses: [] };
}
export function inspectorRun(doc: EngineeringDocument, nodeId: string, status: EngineeringRun["status"] = "review", mode: EngineeringRun["mode"] = "controlled"): EngineeringRun {
  const node = doc.nodes.find(item => item.id === nodeId)!;
  const run: EngineeringRun = { id: `fixture-run-${nodeId}-${doc.runs.length}`, node_id: nodeId, mode, status, actor: "isolated-test-fixture", snapshot: { node: structuredClone(node), lineage: engineeringLineage(doc, nodeId).map(item => ({ id: item.id, revision: item.revision })), effective: effectiveEngineeringConstraints(doc, nodeId), contract_key: engineeringContractKey(doc, nodeId), dependencies: [], children: [] }, started_at: stamp, finished_at: ["review", "accepted", "rejected"].includes(status) ? stamp : null, current_action: "", completed_action_ids: [], evidence: [], output_dir: "fixture-output", reason: "", review_note: "", reviewed_at: status === "accepted" ? stamp : null };
  if (mode === "external") run.handoff = { state: status === "queued" ? "awaiting_claim" : "claimed", owner: "codex:fixture-session", source_cwd: "D:/isolated-fixture", document_revision: doc.revision, contract_key: run.snapshot.contract_key, created_at: stamp, ...status === "queued" ? {} : { claimed_at: stamp, claimed_by: "codex:fixture-session" } };
  return run;
}
export const inspectorCheck = (criterion: string, passed = true) => ({ id: `fixture-check-${criterion}`, criterion_id: criterion, kind: "check" as const, summary: "隔离测试中的检查记录", passed, created_at: stamp });
export const inspectorSourceScope: FrozenEngineeringSourceScope = { root: "D:/isolated-fixture", allow: ["src/**"], deny: [], checks: [{ id: "source-check", title: "实际源文件检查", program: "node", args: ["--check", "src/app.js"] }], contract_sha256: "a".repeat(64) };
export function inspectorSourceProof(): EngineeringSourceProof {
  return { schema_version: 1, verification_mode: "post_execution", verified_at: stamp, status: "passed", passed: true, root: inspectorSourceScope.root, contract_sha256: inspectorSourceScope.contract_sha256, baseline_manifest_sha256: "b".repeat(64), final_manifest_sha256: "c".repeat(64), changes: [], checks: [{ ...inspectorSourceScope.checks[0], command_sha256: "d".repeat(64), status: "passed", exit_code: 0, duration_ms: 25, output_sha256: "e".repeat(64), output_bytes: 0, error: null }], preexisting_changes: [], exclusions: [], exclusion_rules: [], source_changed_during_checks: false, error: null };
}
export function inspectorScenario(name: string) {
  const doc = inspectorDocument();
  doc.nodes[1].title = "完成可读的工程结果，并保留可核对的依据";
  if (name === "long") { doc.nodes[1].title = "中文长标题：将原本相互独立的任务功能连接成完整可管理的工程流程，保证每一层均可约束、推进和验收"; doc.nodes[1].constraints.rules = Array.from({ length: 25 }, (_, index) => `详细技术边界 ${index + 1}：需要按授权范围执行，保留证据。`); }
  if (["queued", "claimed", "running", "checking", "review", "rejected", "blocked", "paused", "accepted", "stale", "measured"].includes(name)) {
    doc.nodes[1].owner = "codex:fixture-session";
    doc.nodes[1].actions = [{ id: "make", type: "agent_artifact", title: "制作任务成果", path: "output/result.md", content: "", criterion_id: "step-manual", capability_id: "" }];
    if (name === "checking") { const { contract_sha256: _contract, ...scope } = inspectorSourceScope; doc.nodes[1].source_scope = scope; }
    const run = inspectorRun(doc, "step", name === "claimed" || name === "queued" ? "queued" : name === "checking" ? "running" : name === "stale" || name === "measured" ? "accepted" : name as EngineeringRun["status"], "external");
    if (name === "claimed") { run.handoff!.state = "claimed"; run.reason = "同源任务正在等待人工验收。"; }
    if (name === "running") run.current_action = "make";
    if (name === "checking") { run.current_action = "source-verification"; run.completed_action_ids = ["make"]; run.source_scope = structuredClone(inspectorSourceScope); }
    if (["review", "rejected", "accepted", "stale", "measured"].includes(name)) { run.completed_action_ids = ["make"]; run.evidence = [{ id: "fixture-artifact", criterion_id: "step-manual", kind: "artifact", summary: "隔离测试成果", path: "output/result.md", sha256: "f".repeat(64), passed: true, created_at: stamp }]; }
    if (name === "measured") {
      run.started_at = "2026-09-05T10:00:00.000Z"; run.finished_at = "2026-09-05T10:12:00.000Z"; run.reviewed_at = "2026-09-05T10:15:00.000Z";
      run.metrics = { source: "codex_rollout", attribution: "assigned_task_window", state: "final",
        baseline: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1_100, observed_at: "2026-09-05T10:00:00.000Z" },
        latest: { input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 600, reasoning_output_tokens: 120, total_tokens: 10_600, observed_at: "2026-09-05T10:13:00.000Z" },
        token_usage: { input_tokens: 9_000, cached_input_tokens: 7_500, output_tokens: 500, reasoning_output_tokens: 100, total_tokens: 9_500 } };
    }
    if (name === "rejected") run.review_note = "结果缺少关键判断，需要补充后重新提交。";
    if (name === "blocked") run.reason = "实际检查失败，需核对失败记录。";
    if (name === "paused") run.reason = "当前任务链已明确暂停。";
    doc.runs.push(run); if (name === "stale") doc.nodes[1].revision++;
  }
  if (name === "parent") {
    doc.nodes.push(inspectorNode("branch", "root", { title: "另一个并行分支" }), inspectorNode("nested", "branch", { title: "分支内正在推进的步骤" }));
    doc.runs.push(inspectorRun(doc, "step", "running", "external"));
    doc.runs.push(inspectorRun(doc, "nested", "running", "external"));
  }
  return { view: deriveEngineeringView(doc), nodeId: name === "parent" ? "root" : "step" };
}
