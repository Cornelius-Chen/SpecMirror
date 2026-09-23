import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, type EngineeringDeliveryContract, type EngineeringNode, type EngineeringRun } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering } from "@epm/spec-io";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { EventBus } from "./events.ts";

const contract = (criterion: string): EngineeringDeliveryContract => ({ included: ["本项成果的形成与交付"], excluded: ["不承担其他成果和真实交易"], outputs: [{ id: "result", title: "可独立核对的成果", criterion_ids: [criterion] }], inputs: [] });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-delivery-")), app = Fastify();
  const service = registerEngineeringRoutes(app, root, new EventBus()); await app.ready();
  const view = () => service.view();
  const update = (id: string, patch: Partial<EngineeringNode>) => {
    const current = view().document, node = { ...current.nodes.find(item => item.id === id)!, ...patch };
    const input = { node, expected_revision: current.revision, reason: "核对成果边界和完成条件" };
    service.preview(id, input); return service.updateNode(id, input);
  };
  const rootContract = () => update("engineering-project", {
    delivery: contract("project-outcome"),
    criteria: [...view().document.nodes.find(node => node.id === "engineering-project")!.criteria.filter(criterion => criterion.id !== "project-integration"), { id: "project-integration", text: "各项成果接通后可以完整使用", kind: "manual", path: "", expected: "" }],
    composition: { summary: "子项分别形成成果，本层接通并核对整体交付", scenario: "从取得输入到使用最终成果，完整走通一次项目", integration_criterion_ids: ["project-integration"] }
  });
  const create = (title: string) => {
    const after = service.createNode({ parent_id: "engineering-project", title, expected_revision: view().document.revision });
    return after.document.nodes.find(node => node.title === title)!;
  };
  const configure = (id: string, patch: Partial<EngineeringNode> = {}) => update(id, {
    objective: "形成可独立交付的实际成果", contributes_to: ["project-outcome"], contribution: { summary: "交出本项成果，供上级接通并核对完整结果" },
    criteria: [{ id: "done", text: "成果符合目标和边界", kind: "manual", path: "", expected: "" }],
    actions: [{ id: "write", title: "生成本项实际成果", type: "write_file", path: `artifacts/${id}.txt`, content: "delivered", criterion_id: "done", capability_id: "" }],
    delivery: contract("done"), ...patch
  });
  const execute = async (id: string) => {
    service.ready(id, view().document.revision); service.dispatch({ node_ids: [id] }); await service.settled();
    return view().document.runs.filter(run => run.node_id === id).at(-1)!;
  };
  const accept = (run: EngineeringRun) => service.review(run.id, { verdict: "accepted", note: "逐项核对本项成果满足约定", checks: run.snapshot.node.criteria.filter(item => item.kind === "manual").map(item => ({ criterion_id: item.id, passed: true, note: "实际成果符合本项条件" })) });
  const close = async () => { await app.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("unsafe cleanup"); rmSync(root, { recursive: true, force: true }); };
  return { root, app, service, view, update, rootContract, create, configure, execute, accept, close };
}

describe("closed-loop delivery contracts through the real service", () => {
  it("saves a new project without composition as a draft but refuses execution until integration is explicit", async () => {
    const f = await fixture(); try {
      f.update("engineering-project", { delivery: contract("project-outcome") });
      const child = f.create("需要整体接通的成果"); f.configure(child.id);
      expect(f.view().document.nodes[0].composition).toBeUndefined();
      expect(f.view().derived[child.id].can_run).toBe(false);
      expect(() => f.service.ready(child.id, f.view().document.revision)).toThrow(/子成果怎样组成整体结果/);
      f.update("engineering-project", { composition: { summary: "接通子项成果", scenario: "完整使用一次", integration_criterion_ids: [] } });
      expect(() => f.service.ready(child.id, f.view().document.revision)).toThrow(/本层整合负责/);
      expect(f.view().document.runs).toEqual([]);
      f.rootContract();
      expect(() => f.service.ready(child.id, f.view().document.revision)).not.toThrow();
    } finally { await f.close(); }
  });

  it("saves an isolated child's draft but refuses ready until it contributes to a real parent condition", async () => {
    const f = await fixture(); try {
      f.rootContract(); const covered = f.create("已负责上级条件的成果"), orphan = f.create("尚未说明上级用途的成果");
      f.configure(covered.id); f.configure(orphan.id, { contributes_to: [] });
      expect(f.view().derived["engineering-project"].uncovered_criteria).toEqual([]);
      expect(() => f.service.ready(orphan.id, f.view().document.revision)).toThrow(/至少关联一条上级/);
      expect(f.view().document.nodes.find(node => node.id === orphan.id)?.status).toBe("draft");
      expect(f.view().document.runs).toEqual([]);
      f.update(orphan.id, { contributes_to: ["project-outcome"] });
      expect(() => f.service.ready(orphan.id, f.view().document.revision)).not.toThrow();
    } finally { await f.close(); }
  });

  it("creates an empty delivery draft and blocks readiness until every enabled ancestor and leaf has a contract", async () => {
    const f = await fixture(); try {
      expect(f.view().document.nodes[0].delivery).toEqual({ included: [], excluded: [], outputs: [], inputs: [] });
      const child = f.create("独立成果"); f.configure(child.id);
      expect(() => f.service.ready(child.id, f.view().document.revision)).toThrow(/负责的范围/);
      f.rootContract(); f.update(child.id, { delivery: { included: [], excluded: [], outputs: [], inputs: [] } });
      expect(() => f.service.ready(child.id, f.view().document.revision)).toThrow(/交付成果/);
      f.configure(child.id); expect(() => f.service.ready(child.id, f.view().document.revision)).not.toThrow();
      expect(f.view().document.runs).toEqual([]);
    } finally { await f.close(); }
  });

  it("preserves the contract across old client payloads and rejects dangling edits before writing", async () => {
    const f = await fixture(); try {
      f.rootContract(); const source = f.create("上游成果"), consumer = f.create("下游成果");
      f.configure(source.id); f.configure(consumer.id, { dependencies: [source.id], delivery: { ...contract("done"), inputs: [{ id: "in", title: "上游成果", source_node_id: source.id, source_output_id: "result", external_source: "" }] } });
      const oldPayload = structuredClone(f.view().document.nodes.find(node => node.id === source.id)!); delete oldPayload.delivery; oldPayload.method = "只修改内部做法";
      const input = { node: oldPayload, expected_revision: f.view().document.revision, reason: "兼容旧编辑器" };
      f.service.preview(source.id, input); f.service.updateNode(source.id, input);
      expect(f.view().document.nodes.find(node => node.id === source.id)?.delivery).toEqual(contract("done"));
      const before = readFileSync(engineeringDocumentPath(f.root), "utf8");
      expect(() => f.update(source.id, { delivery: { ...contract("done"), outputs: [] } })).toThrow(/悬空关系/);
      expect(readFileSync(engineeringDocumentPath(f.root), "utf8")).toBe(before);
      const decoupled = f.update(consumer.id, { dependencies: [] });
      expect(decoupled.document.nodes.find(node => node.id === consumer.id)?.dependencies).toEqual([]);
      expect(decoupled.derived[consumer.id].blockers.some(reason => reason.includes(source.title))).toBe(true);
    } finally { await f.close(); }
  });

  it("executes input/output dependencies and separately accepts the integrated parent, then invalidates downstream on a changed output", async () => {
    const f = await fixture(); try {
      f.rootContract(); const source = f.create("数据成果"), consumer = f.create("研究成果");
      f.configure(source.id); f.configure(consumer.id, { dependencies: [source.id], delivery: { ...contract("done"), inputs: [{ id: "data", title: "数据成果", source_node_id: source.id, source_output_id: "result", external_source: "" }] } });
      f.service.ready(consumer.id, f.view().document.revision); f.service.dispatch({ node_ids: [consumer.id] }); await f.service.settled();
      expect(f.view().document.runs.at(-1)?.status).toBe("queued");
      const sourceRun = await f.execute(source.id); expect(sourceRun.snapshot.node.delivery).toEqual(contract("done"));
      expect(sourceRun.snapshot.delivery_lineage?.map(item => item.node_id)).toEqual(["engineering-project", source.id]); f.accept(sourceRun); await f.service.settled();
      const consumerRun = f.view().document.runs.filter(run => run.node_id === consumer.id).at(-1)!; expect(consumerRun.status).toBe("review");
      expect(consumerRun.snapshot.dependencies[0].run_id).toBe(sourceRun.id); f.accept(consumerRun);
      expect(f.view().derived["engineering-project"].status).not.toBe("accepted");
      const integrated = await f.execute("engineering-project"); expect(integrated.mode).toBe("integration"); expect(integrated.status).toBe("review");
      f.accept(integrated); expect(f.view().derived["engineering-project"].status).toBe("accepted");
      const updated = contract("done"); updated.outputs[0].title = "修订后的数据成果"; f.update(source.id, { delivery: updated });
      expect(f.view().derived[source.id].status).toBe("needs_revision"); expect(f.view().derived[consumer.id].status).toBe("needs_revision"); expect(f.view().derived["engineering-project"].status).toBe("needs_revision");
      expect(f.view().document.runs.find(run => run.id === sourceRun.id)?.snapshot.node.delivery).toEqual(contract("done"));
    } finally { await f.close(); }
  });

  it("rechecks a queued persisted plan before starting instead of trusting a ready label", async () => {
    const f = await fixture(); try {
      f.rootContract(); const source = f.create("上游"), child = f.create("下游"); f.configure(source.id); f.configure(child.id, { dependencies: [source.id], delivery: { ...contract("done"), inputs: [{ id: "in", title: "上游结果", source_node_id: source.id, source_output_id: "result", external_source: "" }] } });
      f.service.ready(child.id, f.view().document.revision); f.service.dispatch({ node_ids: [child.id] }); await f.service.settled();
      const persisted = loadEngineering(f.root); persisted.nodes.find(node => node.id === child.id)!.delivery!.outputs = [];
      atomicWriteYaml(engineeringDocumentPath(f.root), persisted); f.service.schedule(); await f.service.settled();
      const run = f.view().document.runs.at(-1)!; expect(run.status).toBe("blocked"); expect(run.reason).toContain("交付成果"); expect(run.completed_action_ids).toEqual([]);
    } finally { await f.close(); }
  });

  it("previews and replaces the whole draft structure atomically while retaining historical identities and frozen evidence", async () => {
    const f = await fixture(); try {
      f.rootContract(); const old = f.create("旧实施批次"); f.configure(old.id); const run = await f.execute(old.id);
      const before = f.view().document, beforeBytes = readFileSync(engineeringDocumentPath(f.root), "utf8"), rootPatch = structuredClone(before.nodes[0]);
      const fresh = EngineeringNodeSchema.parse({ ...before.nodes.find(node => node.id === old.id)!, id: "new-result", title: "独立产品成果", revision: 1, contract_revision: 1, status: "draft", owner: "未分配" });
      const preview = f.service.previewDraftStructure(before.root_id, [fresh], rootPatch, before.revision);
      expect(readFileSync(engineeringDocumentPath(f.root), "utf8")).toBe(beforeBytes); expect(preview.invalidated_run_ids).toContain(run.id);
      const after = f.service.replaceDraftStructure(before.root_id, [fresh], rootPatch, before.revision, "按可独立交付的成果重组").document;
      expect(after.revision).toBe(before.revision + 1); expect(after.nodes.find(node => node.id === old.id)?.status).toBe("archived");
      expect(after.nodes.find(node => node.id === fresh.id)).toMatchObject({ status: "draft", owner: "未分配", revision: 1 });
      expect(after.runs.find(item => item.id === run.id)).toMatchObject({ status: "stale", snapshot: run.snapshot, evidence: run.evidence });
      expect(after.nodes[0].revision).toBe(rootPatch.revision + 1); expect(after.changes.filter(change => change.reason === "按可独立交付的成果重组")).toHaveLength(2);
      expect(() => f.service.replaceDraftStructure(before.root_id, [fresh], rootPatch, before.revision, "重复应用")).toThrow(/更新/);
    } finally { await f.close(); }
  });

  it("refuses replacement that widens root constraints, removes historical goal mappings or races an active run", async () => {
    const f = await fixture(); try {
      f.rootContract(); const old = f.create("旧成果"); f.configure(old.id); const doc = f.view().document;
      const fresh = EngineeringNodeSchema.parse({ ...doc.nodes.find(node => node.id === old.id)!, id: "new", revision: 1, status: "draft", owner: "未分配" });
      expect(() => f.service.previewDraftStructure(doc.root_id, [fresh], { ...doc.nodes[0], constraints: { ...doc.nodes[0].constraints, allow: ["**"] } }, doc.revision)).toThrow(/原有/);
      expect(() => f.service.previewDraftStructure(doc.root_id, [fresh], { ...doc.nodes[0], criteria: [], delivery: { ...contract("project-outcome"), outputs: [] } }, doc.revision)).toThrow(/保留根节点原有验收/);
      f.service.ready(old.id, f.view().document.revision); f.service.dispatch({ node_ids: [old.id] });
      expect(() => f.service.previewDraftStructure(doc.root_id, [fresh], f.view().document.nodes[0], f.view().document.revision)).toThrow(/排队、执行/);
      await f.service.settled();
    } finally { await f.close(); }
  });
});
