import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, effectiveEngineeringConstraints, engineeringContractKey, engineeringLineage } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { registerLegacyReadonlyGuard } from "./app.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";
import { registerTaskPresentationRoutes, TaskPresentationStore } from "./task-presentation.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-presentation-")), at = new Date().toISOString();
  const nodes = [
    { id: "root", parent_id: null, kind: "project", title: "真实工程" },
    { id: "phase", parent_id: "root", kind: "task", title: "当前阶段" },
    { id: "step", parent_id: "phase", kind: "step", title: "当前步骤" },
    { id: "old", parent_id: "root", kind: "task", title: "归档阶段", status: "archived" }
  ].map((node, order) => EngineeringNodeSchema.parse({ order, revision: 1, status: "draft", objective: "可核对的结果", constraints: { allow: ["artifacts/**"] }, created_at: at, updated_at: at, ...node }));
  atomicWriteYaml(engineeringDocumentPath(root), { schema_version: 1, id: "doc", revision: 1, root_id: "root", created_at: at, updated_at: at, nodes, runs: [], events: [], changes: [], capability_uses: [] });
  const workspaces = new TaskWorkspaces(root, new EventBus(), { source: async (id: string) => {
    if (!id.startsWith("task-")) throw Error("unknown_task");
    return { id, title: "真实来源任务", cwd: root, preview: "真实来源摘要", version: "v1", updatedAt: 1, pinned: false, received: false, receivedAt: null };
  } });
  const app = Fastify(); registerLegacyReadonlyGuard(app, true); const store = registerTaskPresentationRoutes(app, workspaces);
  const post = (revision: number, operation: unknown, workspace?: string) => app.inject({ method: "POST", url: "/api/task-presentation" + (workspace ? "?workspace=" + workspace : ""), payload: { expected_revision: revision, operation } });
  return { app, root, workspaces, store, post, close: async () => { await app.close(); await workspaces.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("unsafe_cleanup"); rmSync(root, { recursive: true, force: true }); } };
}

describe("readability metadata stays separate from engineering execution", () => {
  it("loads without creating a file; classifies an unconnected real task, survives reload, and leaves engineering bytes unchanged", async () => {
    const f = await fixture(); try {
      const before = readFileSync(engineeringDocumentPath(f.root));
      expect((await f.app.inject("/api/task-presentation")).json()).toMatchObject({ revision: 1, workspace_id: null, collections: [] });
      expect(existsSync(f.store.path)).toBe(false);
      const created = await f.post(1, { type: "create_collection", title: " 产品建设 " });
      expect(created.statusCode).toBe(200); const data = created.json(), id = data.collections[0].id;
      const assigned = await f.post(data.revision, { type: "set_task_collections", task_id: "task-real", collection_ids: [id] });
      expect(assigned.statusCode).toBe(200);
      expect(new TaskPresentationStore(f.workspaces).view().task_collection_ids["task-real"]).toEqual([id]);
      expect(f.workspaces.forThread("task-real")).toBeUndefined();
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(before)).toBe(true);
    } finally { await f.close(); }
  });
  it("keeps stage and labels scoped, with no formal revision or status change", async () => {
    const f = await fixture(); try {
      const other = await f.workspaces.connect({ thread_id: "task-other", source_version: "v1", mode: "create" });
      const before = readFileSync(engineeringDocumentPath(f.root));
      const selected = await f.post(1, { type: "set_current_phase", phase_id: "phase" }, "host"); expect(selected.statusCode).toBe(200);
      const tagged = await f.post(2, { type: "set_node_labels", node_id: "step", labels: ["设计", "设计", "交互"] }, "host"); expect(tagged.json().workspace).toEqual({ current_phase_id: "phase", node_labels: { step: ["设计", "交互"] } });
      expect(f.store.view(other.id).workspace).toEqual({ current_phase_id: null, node_labels: {} });
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(before)).toBe(true);
      expect((await f.post(3, { type: "set_node_labels", node_id: "step", labels: ["错误"] }, other.id)).statusCode).toBe(400);
      expect(f.store.view("host").revision).toBe(3);
    } finally { await f.close(); }
  });
  it("rejects stale concurrent edits instead of silently overwriting another classification", async () => {
    const f = await fixture(); try {
      const created = (await f.post(1, { type: "create_collection", title: "工程" })).json();
      const operations = await Promise.all([
        f.post(2, { type: "set_task_collections", task_id: "task-one", collection_ids: [created.collections[0].id] }),
        f.post(2, { type: "set_task_collections", task_id: "task-two", collection_ids: [created.collections[0].id] })
      ]);
      expect(operations.map(result => result.statusCode).sort()).toEqual([200, 409]);
      expect(Object.keys(f.store.view().task_collection_ids)).toHaveLength(1);
      expect(operations.find(result => result.statusCode === 409)!.json().code).toBe("presentation_revision_conflict");
    } finally { await f.close(); }
  });
  it("rename preserves memberships; deleting a collection only removes its memberships", async () => {
    const f = await fixture(); try {
      const created = (await f.post(1, { type: "create_collection", title: "工程" })).json(), id = created.collections[0].id;
      await f.post(2, { type: "set_task_collections", task_id: "task-one", collection_ids: [id] });
      const renamed = (await f.post(3, { type: "rename_collection", id, title: "产品与工程" })).json();
      expect(renamed.collections[0].id).toBe(id); expect(renamed.task_collection_ids["task-one"]).toEqual([id]);
      const before = readFileSync(engineeringDocumentPath(f.root));
      const removed = (await f.post(4, { type: "delete_collection", id })).json();
      expect(removed.collections).toEqual([]); expect(removed.task_collection_ids).toEqual({});
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(before)).toBe(true);
    } finally { await f.close(); }
  });
  it("rejects unknown or archived stages, unsafe keys, invalid scopes and nonexistent task sources", async () => {
    const f = await fixture(); try {
      for (const phase_id of ["missing", "old", "step", "root"]) expect((await f.post(1, { type: "set_current_phase", phase_id }, "host")).statusCode).toBe(400);
      expect((await f.post(1, { type: "set_node_labels", node_id: "step", labels: ["交互"] })).statusCode).toBe(400);
      expect((await f.post(1, { type: "set_node_labels", node_id: "constructor", labels: ["交互"] }, "host")).statusCode).toBe(400);
      expect((await f.post(1, { type: "set_task_collections", task_id: "missing", collection_ids: [] })).statusCode).toBe(503);
      expect((await f.app.inject("/api/task-presentation?workspace=missing")).statusCode).toBe(404);
      expect((await f.app.inject({ url: "/api/task-presentation?workspace=host", headers: { "x-mirror-workspace-id": "wrong" } })).statusCode).toBe(400);
      expect(existsSync(f.store.path)).toBe(false);
    } finally { await f.close(); }
  });
  it("validates names and references; clearing a phase or label is an explicit metadata operation", async () => {
    const f = await fixture(); try {
      await f.post(1, { type: "create_collection", title: "UI" });
      expect((await f.post(2, { type: "create_collection", title: "ui" })).json().code).toBe("presentation_title_duplicate");
      expect((await f.post(2, { type: "create_collection", title: " " })).statusCode).toBe(400);
      expect((await f.post(2, { type: "set_task_collections", task_id: "task-real", collection_ids: ["missing"] })).statusCode).toBe(404);
      await f.post(2, { type: "set_current_phase", phase_id: "phase" }, "host");
      await f.post(3, { type: "set_node_labels", node_id: "step", labels: ["交互"] }, "host");
      await f.post(4, { type: "set_node_labels", node_id: "step", labels: [] }, "host");
      await f.post(5, { type: "set_current_phase", phase_id: null }, "host");
      expect(f.store.view("host").workspace).toEqual({ current_phase_id: null, node_labels: {} });
    } finally { await f.close(); }
  });
  it("persists batch display names independently of formal titles, versions and frozen run evidence, and clears them explicitly", async () => {
    const f = await fixture(); try {
      const doc = loadEngineering(f.root), target = doc.nodes.find(node => node.id === "step")!;
      doc.runs.push({ id: "fixture-frozen-review", node_id: "step", status: "review", mode: "controlled", actor: "isolated-fixture", snapshot: {
        node: structuredClone(target), lineage: engineeringLineage(doc, target.id).map(node => ({ id: node.id, revision: node.revision })),
        effective: effectiveEngineeringConstraints(doc, target.id), contract_key: engineeringContractKey(doc, target.id), dependencies: [], children: []
      }, started_at: doc.created_at, finished_at: doc.created_at, current_action: "", completed_action_ids: [],
        evidence: [{ id: "fixture-proof", criterion_id: "", kind: "artifact", summary: "隔离测试历史证据", path: "artifacts/result.md", sha256: "a".repeat(64), passed: true, created_at: doc.created_at }],
        output_dir: "artifacts/fixture", reason: "", review_note: "", reviewed_at: null });
      atomicWriteYaml(engineeringDocumentPath(f.root), doc);
      const before = readFileSync(engineeringDocumentPath(f.root));
      expect((await f.app.inject("/api/task-presentation?workspace=host")).json().workspace).toEqual({ current_phase_id: null, node_labels: {} });
      await f.post(1, { type: "set_current_phase", phase_id: "phase" }, "host");
      await f.post(2, { type: "set_node_labels", node_id: "step", labels: ["交付"] }, "host");
      const named = await f.post(3, { type: "set_node_names", names: { root: "工程总览", step: " 结果核对 " }, expected_engineering_revision: doc.revision }, "host");
      expect(named.statusCode).toBe(200);
      expect(named.json()).toMatchObject({ revision: 4, workspace: { current_phase_id: "phase", node_labels: { step: ["交付"] }, node_names: { root: "工程总览", step: "结果核对" } } });
      expect(new TaskPresentationStore(f.workspaces).view("host").workspace.node_names).toEqual({ root: "工程总览", step: "结果核对" });
      expect((await f.post(4, { type: "set_node_names", names: { root: null, step: "交付验收" } }, "host")).json().workspace.node_names).toEqual({ step: "交付验收" });
      const cleared = await f.post(5, { type: "set_node_names", names: { step: null } }, "host");
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().workspace).toEqual({ current_phase_id: "phase", node_labels: { step: ["交付"] } });
      expect(new TaskPresentationStore(f.workspaces).view("host").workspace).not.toHaveProperty("node_names");
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(before)).toBe(true);
    } finally { await f.close(); }
  });
  it("isolates display names by workspace and rejects a mixed valid/foreign batch atomically", async () => {
    const f = await fixture(); try {
      const other = await f.workspaces.connect({ thread_id: "task-other-names", source_version: "v1", mode: "create" });
      const otherRoot = f.workspaces.resolve(other.id).root, otherId = loadEngineering(otherRoot).root_id;
      const hostBefore = readFileSync(engineeringDocumentPath(f.root)), otherBefore = readFileSync(engineeringDocumentPath(otherRoot));
      expect((await f.post(1, { type: "set_node_names", names: { step: "宿主成果" } }, "host")).statusCode).toBe(200);
      const metadataBefore = readFileSync(f.store.path);
      const mixed = await f.post(2, { type: "set_node_names", names: { step: "不该保存", [otherId]: "越界短名" } }, "host");
      expect(mixed.statusCode).toBe(400); expect(mixed.json().code).toBe("presentation_node_invalid");
      expect((await f.post(2, { type: "set_node_names", names: { step: "错误来源" } }, other.id)).statusCode).toBe(400);
      expect(readFileSync(f.store.path).equals(metadataBefore)).toBe(true);
      expect(f.store.view(other.id).workspace).not.toHaveProperty("node_names");
      expect((await f.post(2, { type: "set_node_names", names: { [otherId]: "独立工程" } }, other.id)).statusCode).toBe(200);
      expect(f.store.view("host").workspace.node_names).toEqual({ step: "宿主成果" });
      expect(f.store.view(other.id).workspace.node_names).toEqual({ [otherId]: "独立工程" });
      expect(f.store.view().workspace).not.toHaveProperty("node_names");
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(hostBefore)).toBe(true);
      expect(readFileSync(engineeringDocumentPath(otherRoot)).equals(otherBefore)).toBe(true);
    } finally { await f.close(); }
  });
  it("rejects invalid, multiline, archived and unscoped display names without a partial update or revision change", async () => {
    const f = await fixture(); try {
      expect((await f.post(1, { type: "set_node_names", names: { step: "短名" } })).json().code).toBe("presentation_scope_required");
      expect(existsSync(f.store.path)).toBe(false);
      expect((await f.post(1, { type: "set_node_names", names: { step: "保留原短名" } }, "host")).statusCode).toBe(200);
      const before = readFileSync(f.store.path);
      for (const name of ["", " ", "字".repeat(25), "第一行\n第二行", "短名\n", "\r短名", "短\u2028名", 42]) {
        const response = await f.post(2, { type: "set_node_names", names: { step: "不该保存", phase: name } }, "host");
        expect(response.statusCode).toBe(400); expect(response.json().code).toBe("presentation_input_invalid");
      }
      for (const names of [{ step: "不该保存", old: "已归档" }, { step: "不该保存", missing: null }, { constructor: "不安全键" }, {}]) expect((await f.post(2, { type: "set_node_names", names }, "host")).statusCode).toBe(400);
      expect(readFileSync(f.store.path).equals(before)).toBe(true);
      expect(f.store.view("host")).toMatchObject({ revision: 2, workspace: { node_names: { step: "保留原短名" } } });
      expect((await f.post(2, { type: "set_node_names", names: { step: "字".repeat(24) } }, "host")).statusCode).toBe(200);
    } finally { await f.close(); }
  });
  it("uses the same revision guard for concurrent short-name batches and filters archived names only from the read view", async () => {
    const f = await fixture(); try {
      const responses = await Promise.all([
        f.post(1, { type: "set_node_names", names: { root: "第一份", step: "第一项" }, expected_engineering_revision: 1 }, "host"),
        f.post(1, { type: "set_node_names", names: { root: "第二份", step: "第二项" }, expected_engineering_revision: 1 }, "host")
      ]);
      expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
      const winner = responses.find(response => response.statusCode === 200)!.json();
      expect(responses.find(response => response.statusCode === 409)!.json().code).toBe("presentation_revision_conflict");
      expect(f.store.view("host").workspace.node_names).toEqual(winner.workspace.node_names);
      const metadataBefore = readFileSync(f.store.path), doc = loadEngineering(f.root);
      doc.nodes.find(node => node.id === "step")!.status = "archived";
      atomicWriteYaml(engineeringDocumentPath(f.root), doc);
      expect(f.store.view("host").workspace.node_names).toEqual({ root: winner.workspace.node_names.root });
      expect(readFileSync(f.store.path).equals(metadataBefore)).toBe(true);
    } finally { await f.close(); }
  });
  it("rejects generated names after the engineering purpose changes and accepts a freshly reviewed version without touching the contract", async () => {
    const f = await fixture(); try {
      const initial = loadEngineering(f.root);
      expect((await f.post(1, { type: "set_node_names", names: { step: "原先用途" }, expected_engineering_revision: initial.revision }, "host")).statusCode).toBe(200);
      const metadataBefore = readFileSync(f.store.path), service = f.workspaces.resolve("host").service;
      const proposed = { ...initial.nodes.find(node => node.id === "step")!, objective: "核对调整后的交付物" };
      service.preview("step", { node: proposed, expected_revision: initial.revision });
      const updated = service.updateNode("step", { node: proposed, expected_revision: initial.revision, reason: "隔离测试：生成名称期间修改用途" });
      expect(updated.document.revision).toBeGreaterThan(initial.revision);
      const engineeringBefore = readFileSync(engineeringDocumentPath(f.root));
      const stale = await f.post(2, { type: "set_node_names", names: { root: "旧批次工程", step: "旧用途候选" }, expected_engineering_revision: initial.revision }, "host");
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("presentation_engineering_revision_conflict");
      expect(readFileSync(f.store.path).equals(metadataBefore)).toBe(true);
      expect(f.store.view("host").workspace.node_names).toEqual({ step: "原先用途" });
      const fresh = await f.post(2, { type: "set_node_names", names: { step: "核对交付物" }, expected_engineering_revision: updated.document.revision }, "host");
      expect(fresh.statusCode).toBe(200);
      expect(new TaskPresentationStore(f.workspaces).view("host")).toMatchObject({ revision: 3, workspace: { node_names: { step: "核对交付物" } } });
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(engineeringBefore)).toBe(true);
    } finally { await f.close(); }
  });
  it("checks the selected workspace engineering revision rather than the host revision", async () => {
    const f = await fixture(); try {
      const other = await f.workspaces.connect({ thread_id: "task-scoped-names", source_version: "v1", mode: "create" });
      const otherRoot = f.workspaces.resolve(other.id).root, otherDoc = loadEngineering(otherRoot);
      const host = f.workspaces.resolve("host").service.createNode({ parent_id: "phase", title: "宿主新增步骤", expected_revision: 1 });
      expect(host.document.revision).not.toBe(otherDoc.revision);
      const hostBefore = readFileSync(engineeringDocumentPath(f.root)), otherBefore = readFileSync(engineeringDocumentPath(otherRoot));
      const stale = await f.post(1, { type: "set_node_names", names: { [otherDoc.root_id]: "跨版本候选" }, expected_engineering_revision: host.document.revision }, other.id);
      expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("presentation_engineering_revision_conflict");
      expect(existsSync(f.store.path)).toBe(false);
      expect((await f.post(1, { type: "set_node_names", names: { [otherDoc.root_id]: "来源工程" }, expected_engineering_revision: otherDoc.revision }, other.id)).statusCode).toBe(200);
      expect(f.store.view("host").workspace).not.toHaveProperty("node_names");
      expect(f.store.view(other.id).workspace.node_names).toEqual({ [otherDoc.root_id]: "来源工程" });
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(hostBefore)).toBe(true);
      expect(readFileSync(engineeringDocumentPath(otherRoot)).equals(otherBefore)).toBe(true);
    } finally { await f.close(); }
  });
  it("rejects invalid engineering version guards and missing or inconsistent scopes without writing metadata", async () => {
    const f = await fixture(); try {
      const before = readFileSync(engineeringDocumentPath(f.root));
      for (const expected_engineering_revision of [0, -1, 1.5, "1", null]) {
        const response = await f.post(1, { type: "set_node_names", names: { step: "名称候选" }, expected_engineering_revision }, "host");
        expect(response.statusCode).toBe(400); expect(response.json().code).toBe("presentation_input_invalid");
      }
      const operation = { type: "set_node_names", names: { step: "名称候选" }, expected_engineering_revision: 1 };
      expect((await f.post(1, operation)).json().code).toBe("presentation_scope_required");
      expect((await f.post(1, operation, "missing")).statusCode).toBe(404);
      expect((await f.app.inject({ method: "POST", url: "/api/task-presentation?workspace=host", headers: { "x-mirror-workspace-id": "other" }, payload: { expected_revision: 1, operation } })).statusCode).toBe(400);
      expect((await f.post(1, { type: "set_node_labels", node_id: "step", labels: ["交付"], expected_engineering_revision: 1 }, "host")).statusCode).toBe(400);
      expect(existsSync(f.store.path)).toBe(false);
      expect(readFileSync(engineeringDocumentPath(f.root)).equals(before)).toBe(true);
    } finally { await f.close(); }
  });
});
