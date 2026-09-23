import { existsSync } from "node:fs";
import { join } from "node:path";
import { EngineeringNodeSchema, EngineeringFeedbackSchema, EngineeringRunMetricsSchema, type EngineeringDocument, type EngineeringNode } from "@epm/domain";
import { atomicWriteYaml, loadSupervision, readYaml } from "./index.ts";

export const engineeringDocumentPath = (root: string) => join(root, ".project", "engineering", "recursive", "document.yaml");

export function loadEngineering(root: string): EngineeringDocument {
  const path = engineeringDocumentPath(root);
  if (!existsSync(path)) return projectLegacyEngineering(root);
  const value = readYaml<EngineeringDocument>(path);
  if (value.schema_version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.runs)) throw new Error("invalid_engineering_document");
  return { ...value, nodes: value.nodes.map((item) => EngineeringNodeSchema.parse(item)), runs: value.runs.map(run => run.metrics ? { ...run, metrics: EngineeringRunMetricsSchema.parse(run.metrics) } : run), events: value.events ?? [], changes: value.changes ?? [], capability_uses: value.capability_uses ?? [], ...(value.feedbacks ? { feedbacks: value.feedbacks.map(item => EngineeringFeedbackSchema.parse(item)) } : {}) };
}

export function saveEngineering(root: string, document: EngineeringDocument, expectedRevision: number): EngineeringDocument {
  const current = loadEngineering(root);
  if (current.revision !== expectedRevision) throw new Error("engineering_revision_conflict");
  const now = new Date().toISOString();
  const next: EngineeringDocument = { ...document, revision: current.revision + 1, updated_at: now };
  next.nodes = next.nodes.map((item) => EngineeringNodeSchema.parse(item));
  next.runs = next.runs.map(run => run.metrics ? { ...run, metrics: EngineeringRunMetricsSchema.parse(run.metrics) } : run);
  if (next.feedbacks) next.feedbacks = next.feedbacks.map(item => EngineeringFeedbackSchema.parse(item));
  const history = join(root, ".project", "engineering", "recursive", "history", "revision-" + current.revision + ".yaml");
  if (!existsSync(history)) atomicWriteYaml(history, current);
  atomicWriteYaml(engineeringDocumentPath(root), next);
  return next;
}

function projectLegacyEngineering(root: string): EngineeringDocument {
  let source: ReturnType<typeof loadSupervision> | undefined;
  if (existsSync(join(root, ".project", "supervision", "specmirror-m1.yaml"))) source = loadSupervision(root);
  const now = source?.updated_at ?? "2026-01-01T00:00:00.000Z";
  const make = (input: Partial<EngineeringNode> & Pick<EngineeringNode, "id" | "title" | "parent_id" | "kind">) => EngineeringNodeSchema.parse({
    objective: "", method: "", architecture: "", owner: "未分配", order: 0, revision: 1, status: "draft",
    dependencies: [], contributes_to: [], constraints: { allow: [], deny: [], rules: [], resources: [] },
    criteria: [], capabilities: [], actions: [], created_at: now, updated_at: now, ...input
  });
  const rootNode = make({
    id: "engineering-project", parent_id: null, kind: "project", title: "映构全层级工程管理",
    objective: "将工程项目、任务和步骤逐层展开、约束、分配与验收；用真实执行证据发现偏移，组织边界明确的多 Agent 并行，并把学习能力落实到具体工程。",
    constraints: { allow: ["artifacts/**"], deny: [], rules: [], resources: [] },
    criteria: [{ id: "project-outcome", text: "完整工程目标及组合结果通过整体验收", kind: "manual", path: "", expected: "" }],
    ...(!source ? { delivery: { included: [], excluded: [], outputs: [], inputs: [] } } : {})
  });
  const nodes: EngineeringNode[] = [rootNode];
  if (source) {
    rootNode.legacy_ref = ".project/supervision/specmirror-m1.yaml";
    const archiveId = "engineering-legacy-archive";
    nodes.push(make({ id: archiveId, parent_id: rootNode.id, kind: "task", title: "历史任务与旧版证据", objective: "保留旧监督结构、来源和历史，供按需查阅。", status: "archived", legacy_ref: ".project/supervision/specmirror-m1.yaml" }));
    for (const [order, task] of source.tasks.entries()) {
      const details = source.details.filter((item) => item.task_id === task.id);
      const taskId = "legacy:" + task.id;
      const criteria = details.slice(0, 100).map((detail, index) => ({ id: "result-" + index, text: "完成“" + detail.title + "”并验证与任务目标一致", kind: "manual" as const, path: "", expected: "" }));
      nodes.push(make({ id: taskId, parent_id: archiveId, kind: "task", title: task.title, objective: task.objective, order, status: "archived", criteria, dependencies: task.dependencies.map((id) => "legacy:" + id), legacy_ref: ".project/supervision/specmirror-m1.yaml#" + task.id }));
      for (const [index, detail] of details.entries()) nodes.push(make({
        id: "legacy:" + detail.id, parent_id: taskId, kind: "step", title: detail.title, objective: detail.intent,
        method: detail.prompt.local, order: index, status: "archived", contributes_to: ["result-" + index],
        criteria: detail.acceptance.slice(0, 100).map((text, criterionIndex) => ({ id: "criterion-" + criterionIndex, text, kind: "manual", path: "", expected: "" })),
        constraints: { allow: [], deny: [], rules: detail.prompt.forbidden_changes, resources: [] },
        legacy_ref: ".project/supervision/specmirror-m1.yaml#" + detail.id
      }));
    }
  }
  return { schema_version: 1, id: "engineering-document", revision: 1, root_id: rootNode.id, created_at: now, updated_at: now, nodes, runs: [], events: [], changes: [], capability_uses: [] };
}
