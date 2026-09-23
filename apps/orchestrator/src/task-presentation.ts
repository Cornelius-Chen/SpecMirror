import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { atomicWriteYaml, loadEngineering, readYaml } from "@epm/spec-io";
import { EngineeringServiceError } from "./engineering-service.ts";
import type { TaskWorkspaces } from "./task-workspaces.ts";

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const title = z.string().trim().min(1).max(60);
const labels = z.array(z.string().trim().min(1).max(24)).max(12);
const nodeName = z.string().regex(/^[^\r\n\u0085\u2028\u2029]*$/).trim().min(1).max(24);
const workspaceSchema = z.object({ current_phase_id: key.nullable(), node_labels: z.record(key, labels), node_names: z.record(key, nodeName).optional() }).strict();
const schema = z.object({
  schema_version: z.literal(1), revision: z.number().int().min(1),
  collections: z.array(z.object({ id: key, title }).strict()).max(100),
  task_collection_ids: z.record(key, z.array(key).max(12)),
  workspaces: z.record(key, workspaceSchema)
}).strict();
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_collection"), title }).strict(),
  z.object({ type: z.literal("rename_collection"), id: key, title }).strict(),
  z.object({ type: z.literal("delete_collection"), id: key }).strict(),
  z.object({ type: z.literal("set_task_collections"), task_id: key, collection_ids: z.array(key).max(12) }).strict(),
  z.object({ type: z.literal("set_current_phase"), phase_id: key.nullable() }).strict(),
  z.object({ type: z.literal("set_node_labels"), node_id: key, labels }).strict(),
  z.object({ type: z.literal("set_node_names"), names: z.record(key, nodeName.nullable()).refine(names => Object.keys(names).length > 0 && Object.keys(names).length <= 2000), expected_engineering_revision: z.number().int().positive().optional() }).strict()
]);
const inputSchema = z.object({ expected_revision: z.number().int().min(1), operation: operationSchema }).strict();
type PresentationDocument = z.infer<typeof schema>;
const emptyWorkspace = (): z.infer<typeof workspaceSchema> => ({ current_phase_id: null, node_labels: {} });
const failure = (code: string, message: string, status = 400): never => { throw new EngineeringServiceError(code, message, status); };
const normalized = (value: string) => value.normalize("NFC").toLocaleLowerCase();

/** Single-host, synchronous compare-and-replace. No engineering contract is written here. */
export class TaskPresentationStore {
  readonly path: string;
  constructor(readonly workspaces: TaskWorkspaces) { this.path = join(workspaces.root, ".project", "task-workspaces", "presentation.yaml"); }

  private assertPath() {
    // Reject a redirected directory or file even when the final file has not been created yet.
    const suffix: string[] = []; let ancestor = resolve(this.path);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    const actual = resolve(realpathSync.native(ancestor), ...suffix);
    const root = realpathSync.native(this.workspaces.root);
    const expected = resolve(root, relative(resolve(this.workspaces.root), resolve(this.path)));
    if (relative(expected, actual) !== "") failure("presentation_path_invalid", "分类文件不能指向其他目录。", 403);
  }

  private read(): PresentationDocument {
    this.assertPath();
    if (!existsSync(this.path)) return { schema_version: 1, revision: 1, collections: [], task_collection_ids: {}, workspaces: {} };
    const parsed = schema.safeParse(readYaml(this.path));
    if (!parsed.success) return failure("presentation_document_invalid", "分类文件格式异常，请检查保存记录。", 500);
    const document = parsed.data, ids = new Set(document.collections.map(item => item.id));
    if (ids.size !== document.collections.length || new Set(document.collections.map(item => normalized(item.title))).size !== document.collections.length
      || Object.values(document.task_collection_ids).some(items => items.some(id => !ids.has(id)) || new Set(items).size !== items.length)) {
      return failure("presentation_document_invalid", "分类记录重复或引用丢失，请检查保存记录。", 500);
    }
    return document;
  }

  private scopedDocument(workspaceId?: string) {
    if (!workspaceId) return undefined;
    if (!key.safeParse(workspaceId).success) return failure("presentation_scope_invalid", "工程标识无效。", 400);
    const context = this.workspaces.resolve(workspaceId);
    return loadEngineering(context.root);
  }

  view(workspaceId?: string) {
    const document = this.read(), engineering = this.scopedDocument(workspaceId);
    const workspace = structuredClone(workspaceId ? document.workspaces[workspaceId] ?? emptyWorkspace() : emptyWorkspace());
    if (engineering) {
      const active = new Map(engineering.nodes.filter(node => node.status !== "archived").map(node => [node.id, node]));
      if (workspace.current_phase_id && active.get(workspace.current_phase_id)?.parent_id !== engineering.root_id) workspace.current_phase_id = null;
      workspace.node_labels = Object.fromEntries(Object.entries(workspace.node_labels).filter(([id]) => active.has(id)));
      if (workspace.node_names) {
        workspace.node_names = Object.fromEntries(Object.entries(workspace.node_names).filter(([id]) => active.has(id)));
        if (!Object.keys(workspace.node_names).length) delete workspace.node_names;
      }
    }
    return { schema_version: document.schema_version, revision: document.revision, collections: document.collections,
      task_collection_ids: document.task_collection_ids, workspace_id: workspaceId ?? null, workspace };
  }

  async mutate(input: unknown, workspaceId?: string) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return failure("presentation_input_invalid", "请填写有效的展示信息，并保留当前版本。分类名称最多 60 字，标签最多 12 个且每个不超过 24 字；显示短名为 1–24 字且不能换行。");
    const { expected_revision, operation } = parsed.data;
    // Validate the task against the real Codex source; reading the catalog never connects a workspace.
    if (operation.type === "set_task_collections") {
      try { const source = await this.workspaces.catalog.source(operation.task_id); if (source.id !== operation.task_id) throw new Error("source_mismatch"); }
      catch { return failure("presentation_task_unavailable", "暂时无法核对该 Codex 任务，请刷新任务列表后重试。", 503); }
    }
    // No awaits after this point: the revision check and atomic replacement serialize requests on this host.
    const document = this.read(), engineering = this.scopedDocument(workspaceId);
    if (document.revision !== expected_revision) return failure("presentation_revision_conflict", "分类信息已被另一处更新。你的输入仍保留，请读取最新信息后重试。", 409);
    if (operation.type === "create_collection" || operation.type === "rename_collection") {
      if (document.collections.some(item => (operation.type === "create_collection" || item.id !== operation.id) && normalized(item.title) === normalized(operation.title))) return failure("presentation_title_duplicate", "已有同名分类，请换一个名称。", 409);
      if (operation.type === "create_collection") {
        if (document.collections.length >= 100) return failure("presentation_collection_limit", "最多保留 100 个分类，请先整理已有分类。", 409);
        document.collections.push({ id: "collection-" + randomUUID(), title: operation.title });
      } else {
        const item = document.collections.find(item => item.id === operation.id);
        if (!item) return failure("presentation_collection_missing", "这个分类已不存在，请刷新分类列表。", 404);
        item.title = operation.title;
      }
    } else if (operation.type === "delete_collection") {
      if (!document.collections.some(item => item.id === operation.id)) return failure("presentation_collection_missing", "这个分类已不存在，请刷新分类列表。", 404);
      document.collections = document.collections.filter(item => item.id !== operation.id);
      for (const [taskId, ids] of Object.entries(document.task_collection_ids)) {
        const next = ids.filter(id => id !== operation.id);
        if (next.length) document.task_collection_ids[taskId] = next; else delete document.task_collection_ids[taskId];
      }
    } else if (operation.type === "set_task_collections") {
      const ids = [...new Set(operation.collection_ids)];
      if (ids.some(id => !document.collections.some(collection => collection.id === id))) return failure("presentation_collection_missing", "选择的分类已不存在，请刷新分类列表。", 404);
      if (ids.length) document.task_collection_ids[operation.task_id] = ids; else delete document.task_collection_ids[operation.task_id];
    } else {
      if (!workspaceId || !engineering) return failure("presentation_scope_required", "请先选择所属工程，再整理阶段、步骤标签或显示短名。");
      const workspace = document.workspaces[workspaceId] ?? emptyWorkspace();
      if (operation.type === "set_current_phase") {
        if (operation.phase_id !== null && !engineering.nodes.some(node => node.id === operation.phase_id && node.parent_id === engineering.root_id && node.status !== "archived")) return failure("presentation_phase_invalid", "请选择当前工程中未归档的阶段。");
        workspace.current_phase_id = operation.phase_id;
      } else if (operation.type === "set_node_names") {
        // Generated names must still describe the same engineering version at commit time.
        if (operation.expected_engineering_revision !== undefined && engineering.revision !== operation.expected_engineering_revision) return failure("presentation_engineering_revision_conflict", "工程内容已更新，这批名称依据的版本已过期。请重新读取工程并核对名称后再保存。", 409);
        const active = new Set(engineering.nodes.filter(node => node.status !== "archived").map(node => node.id));
        const entries = Object.entries(operation.names);
        // Validate the whole batch before changing metadata; names never change the engineering contract.
        if (entries.some(([id]) => !active.has(id))) return failure("presentation_node_invalid", "批量短名包含不属于当前工程或已经归档的任务，整批未保存。");
        const next = { ...workspace.node_names };
        for (const [id, name] of entries) { if (name === null) delete next[id]; else next[id] = name; }
        if (Object.keys(next).length) workspace.node_names = next; else delete workspace.node_names;
      } else {
        if (!engineering.nodes.some(node => node.id === operation.node_id && node.status !== "archived")) return failure("presentation_node_invalid", "这个步骤不属于当前工程，或已经归档。");
        const next = [...new Map(operation.labels.map(label => [normalized(label), label])).values()];
        if (next.length) workspace.node_labels[operation.node_id] = next; else delete workspace.node_labels[operation.node_id];
      }
      document.workspaces[workspaceId] = workspace;
    }
    document.revision += 1;
    this.assertPath();
    atomicWriteYaml(this.path, document);
    return this.view(workspaceId);
  }
}

function requestedScope(request: FastifyRequest): string | undefined {
  const query = (request.query as { workspace?: unknown }).workspace;
  const header = request.headers["x-mirror-workspace-id"];
  if ((query !== undefined && (typeof query !== "string" || !query)) || (header !== undefined && (typeof header !== "string" || !header)) || (query && header && query !== header)) return failure("presentation_scope_invalid", "工程标识不一致。");
  return (header ?? query) as string | undefined;
}

export function registerTaskPresentationRoutes(app: FastifyInstance, workspaces: TaskWorkspaces) {
  const store = new TaskPresentationStore(workspaces);
  const respond = async (reply: { code(status: number): any }, operation: () => unknown | Promise<unknown>) => {
    try { return reply.code(200).send(await operation()); }
    catch (error) { const known = error instanceof EngineeringServiceError; return reply.code(known ? error.status : 500).send({ code: known ? error.code : "presentation_failed", error: known ? error.message : "分类信息暂时无法处理，请稍后重试。" }); }
  };
  app.get("/api/task-presentation", (request, reply) => respond(reply, () => store.view(requestedScope(request))));
  app.post("/api/task-presentation", (request, reply) => respond(reply, () => store.mutate(request.body, requestedScope(request))));
  return store;
}
