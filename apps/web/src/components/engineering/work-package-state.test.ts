import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveEngineeringView, engineeringContractKey, EngineeringNodeSchema, type EngineeringDocument } from "@epm/domain";
import { createEngineeringApi, type WorkPackagePreview, type WorkPackageRequest } from "../../engineering-api.ts";
import { humanApprovalHeaders } from "../../human-approval-client.ts";
import { initialWorkPackageDraft, prepareWorkPackageRequest, workPackageCandidates, workPackageCommitReceipt, workPackagePreviewCurrent, type WorkPackageDraft } from "./work-package-state.ts";

vi.mock("../../human-approval-client.ts", () => ({ humanApprovalHeaders: vi.fn(async () => ({ "x-mirror-human-approval-attempt": "isolated-test-attempt", "x-mirror-human-approval-assertion": "isolated-test-assertion" })) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function fixture() {
  const root = EngineeringNodeSchema.parse({ id: "root", parent_id: null, kind: "project", title: "节点成果", order: 0, revision: 1, status: "draft", constraints: {}, criteria: [{ id: "whole", text: "可以在原节点下载正确记录", kind: "manual" }], created_at: "before", updated_at: "before" });
  const child = (id: string, order: number) => EngineeringNodeSchema.parse({ ...root, id, parent_id: root.id, kind: "step", title: id, order, source_scope: { root: "D:/project", allow: [`src/${id}.ts`], deny: [".env"], checks: [{ id: "check", title: "运行核对", program: "node", args: ["check.mjs"], timeout_ms: 30000 }] } });
  const document: EngineeringDocument = { schema_version: 1, id: "project", root_id: root.id, revision: 3, created_at: "before", updated_at: "before", nodes: [root, child("backend", 0), child("frontend", 1)], runs: [], changes: [], events: [], capability_uses: [] };
  const owners = [{ id: "codex:backend", label: "A", available: true }, { id: "codex:frontend", label: "B", available: true }, { id: "codex:expired", label: "旧连接", available: false }];
  const draft: WorkPackageDraft = { composition: { summary: "后端导出，前端显示", scenario: "打开节点，下载记录", integration_criterion_ids: ["whole"] }, assignments: { backend: owners[0].id, frontend: owners[1].id }, reason: "并行完成节点成果查收" };
  return { view: deriveEngineeringView(document), root, owners, draft };
}

function preview(request: WorkPackageRequest): WorkPackagePreview {
  return { token: "exact-plan-preview", manifest_digest: "d".repeat(64), request: structuredClone(request), root_id: request.root_id, expected_revision: request.expected_revision,
    nodes: request.assignments.map(item => ({ id: item.node_id, title: item.node_id, owner: item.owner, source_scope: undefined })),
    affected_ids: [request.root_id, ...request.assignments.map(item => item.node_id)], expires_at: "2026-09-12T20:10:00.000Z" };
}
const now = Date.parse("2026-09-12T20:00:00.000Z");

describe("work package form and exact preview binding", () => {
  it("starts without silently assigning any node or owner", () => {
    const { root } = fixture(), draft = initialWorkPackageDraft(root);
    expect(draft.assignments).toEqual({});
    expect(draft.composition).toEqual({ summary: "", scenario: "", integration_criterion_ids: [] });
    root.composition = { summary: "existing", scenario: "existing scene", integration_criterion_ids: ["whole"] };
    const retained = initialWorkPackageDraft(root); retained.composition.integration_criterion_ids.length = 0;
    expect(root.composition.integration_criterion_ids).toEqual(["whole"]);
  });

  it("submits only composition and explicit owners, permitting one owner to take several areas", () => {
    const { view, root, owners, draft } = fixture();
    draft.assignments.frontend = owners[0].id;
    const request = prepareWorkPackageRequest(view, root.id, draft, owners);
    expect(request.assignments).toEqual([{ node_id: "backend", owner: "codex:backend" }, { node_id: "frontend", owner: "codex:backend" }]);
    expect(Object.keys(request).sort()).toEqual(["assignments", "composition", "expected_revision", "reason", "root_id"]);
    expect(request.expected_revision).toBe(3);
    expect(view.document.nodes.every(node => node.owner === "未分配" && node.status === "draft")).toBe(true);
  });

  it("rejects missing, expired, invented or non-Codex owners", () => {
    const { view, root, owners, draft } = fixture();
    for (const owner of ["", "codex:expired", "codex:invented", "human"]) {
      draft.assignments.frontend = owner;
      expect(() => prepareWorkPackageRequest(view, root.id, draft, [...owners, { id: "human", label: "human", available: true }])).toThrow("真实负责人");
    }
  });

  it("allows only existing direct draft leaves with source scope and no historical runs", () => {
    const { view, root, owners, draft } = fixture();
    const backend = view.document.nodes[1];
    view.document.runs.push({ node_id: backend.id, status: "accepted" } as EngineeringDocument["runs"][number]);
    expect(workPackageCandidates(view, root.id).find(item => item.node.id === backend.id)?.unavailable).toBe("已有运行历史");
    expect(() => prepareWorkPackageRequest(view, root.id, draft, owners)).toThrow("已有运行历史");
    view.document.runs = []; backend.status = "ready";
    expect(() => prepareWorkPackageRequest(view, root.id, draft, owners)).toThrow("已进入执行流程");
    backend.status = "draft"; view.document.nodes.push({ ...backend, id: "nested", parent_id: backend.id });
    expect(() => prepareWorkPackageRequest(view, root.id, draft, owners)).toThrow("末级任务");
    view.document.nodes.pop(); delete backend.source_scope;
    expect(() => prepareWorkPackageRequest(view, root.id, draft, owners)).toThrow("源码范围");
    delete draft.assignments.backend; draft.assignments.missing = owners[0].id;
    expect(() => prepareWorkPackageRequest(view, root.id, draft, owners)).toThrow("重新选择");
  });

  it("requires explicit composition, current integration criteria, reason and a bounded selection", () => {
    const { view, root, owners, draft } = fixture();
    const check = (patch: Partial<WorkPackageDraft>) => prepareWorkPackageRequest(view, root.id, { ...draft, ...patch }, owners);
    expect(() => check({ reason: " " })).toThrow("目的");
    expect(() => check({ assignments: {} })).toThrow("1–20");
    expect(() => check({ assignments: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [String(index), "codex:backend"])) })).toThrow("1–20");
    expect(() => check({ composition: { ...draft.composition, scenario: " " } })).toThrow("使用场景");
    expect(() => check({ composition: { ...draft.composition, integration_criterion_ids: ["removed"] } })).toThrow("已变化");
    expect(() => prepareWorkPackageRequest(view, "frontend", draft, owners)).toThrow("总项");
    view.document.runs.push({ node_id: root.id } as EngineeringDocument["runs"][number]);
    expect(() => check({})).toThrow("总项已有运行历史");
  });

  it("invalidates preview after any reviewed input, workspace or revision changes", () => {
    const { view, root, owners, draft } = fixture(), request = prepareWorkPackageRequest(view, root.id, draft, owners), prepared = preview(request);
    expect(workPackagePreviewCurrent(prepared, request, "workspace-a", "workspace-a", now)).toBe(true);
    const edits: WorkPackageRequest[] = [
      { ...request, root_id: "other" }, { ...request, expected_revision: 4 }, { ...request, reason: "changed" },
      { ...request, assignments: [{ node_id: "backend", owner: "codex:frontend" }, request.assignments[1]] },
      { ...request, composition: { ...request.composition, summary: "changed" } },
      { ...request, composition: { ...request.composition, scenario: "changed" } },
      { ...request, composition: { ...request.composition, integration_criterion_ids: [] } }
    ];
    for (const edited of edits) expect(workPackagePreviewCurrent(prepared, edited, "workspace-a", "workspace-a", now)).toBe(false);
    expect(workPackagePreviewCurrent(prepared, request, "workspace-a", "workspace-b", now)).toBe(false);
    expect(workPackagePreviewCurrent(prepared, request, "workspace-a", "workspace-a", Date.parse(prepared.expires_at))).toBe(false);
    expect(workPackagePreviewCurrent({ ...prepared, expires_at: "invalid" }, request, "a", "a", now)).toBe(false);
  });

  it("rejects preview responses with extra, missing, duplicate or mismatched task owners", () => {
    const { view, root, owners, draft } = fixture(), request = prepareWorkPackageRequest(view, root.id, draft, owners), prepared = preview(request);
    const nodes = prepared.nodes;
    for (const changed of [nodes.slice(0, 1), [...nodes, { ...nodes[0], id: "extra" }], [nodes[0], nodes[0]], [{ ...nodes[0], owner: "codex:other" }, nodes[1]]]) {
      expect(workPackagePreviewCurrent({ ...prepared, nodes: changed }, request, "a", "a", now)).toBe(false);
    }
  });

  it("recovers only the exact persisted package receipt after an uncertain commit", () => {
    const { view, root, owners, draft } = fixture(), request = prepareWorkPackageRequest(view, root.id, draft, owners), prepared = preview(request);
    const detail = { work_package_id: prepared.token, manifest_digest: prepared.manifest_digest, pre_revision: 3, post_revision: 4 };
    view.document.revision = 4; root.composition = structuredClone(request.composition);
    for (const assignment of request.assignments) Object.assign(view.document.nodes.find(node => node.id === assignment.node_id)!, { owner: assignment.owner, status: "ready" });
    view.document.events = [root.id, ...request.assignments.map(item => item.node_id)].map(node_id => ({ id: `saved-${node_id}`, node_id, at: "saved", kind: "plan", message: "saved", detail: JSON.stringify(detail), ...(node_id !== root.id ? { readiness_contract_key: engineeringContractKey(view.document, node_id) } : {}) }));
    expect(workPackageCommitReceipt(view, prepared)).toBe("ready");
    expect(workPackageCommitReceipt(view, { ...prepared, token: "another-token" })).toBeUndefined();
    expect(workPackageCommitReceipt(view, { ...prepared, manifest_digest: "e".repeat(64) })).toBeUndefined();
    expect(workPackageCommitReceipt(view, { ...prepared, expected_revision: 2 })).toBeUndefined();
    view.document.events[0].detail = JSON.stringify({ ...detail, post_revision: 5 });
    expect(workPackageCommitReceipt(view, prepared)).toBeUndefined();
    view.document.events[0].detail = JSON.stringify(detail);
    view.document.nodes[1].owner = "codex:other";
    expect(workPackageCommitReceipt(view, prepared)).toBe("changed");
    view.document.nodes[1].owner = request.assignments[0].owner;
    view.document.nodes[1].constraints.deny.push("new-protected/**");
    view.document.nodes[1].revision++;
    expect(workPackageCommitReceipt(view, prepared)).toBe("changed");
    view.document.nodes[1].constraints.deny.pop();
    view.document.nodes[1].revision--;
    view.document.nodes[1].status = "running";
    expect(workPackageCommitReceipt(view, prepared)).toBe("changed");
    view.document.events[0].detail = "bad json";
    expect(workPackageCommitReceipt(view, prepared)).toBeUndefined();
  });
});

describe("work package client authentication boundary", () => {
  it("previews without authentication and signs the complete one-shot commit request", async () => {
    const { view, root, owners, draft } = fixture(), input = prepareWorkPackageRequest(view, root.id, draft, owners);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 2) return { ok: false, status: 403, json: async () => ({ code: "human_approval_required" }) } as Response;
      return { ok: true, status: 200, json: async () => calls.length === 1 ? preview(input) : view } as Response;
    }));
    const api = createEngineeringApi("workspace-a");
    await api.previewWorkPackage(input);
    expect(humanApprovalHeaders).not.toHaveBeenCalled();
    await api.commitWorkPackage("exact-plan-preview", input);
    expect(humanApprovalHeaders).toHaveBeenCalledTimes(1);
    expect(humanApprovalHeaders).toHaveBeenCalledWith({ method: "POST", url: "/api/engineering/work-package/commit", workspace: "workspace-a", body: { token: "exact-plan-preview", request: input } });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("/api/engineering/work-package/preview");
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({ token: "exact-plan-preview", request: input });
    expect(calls[2].init?.headers).toMatchObject({ "x-mirror-workspace-id": "workspace-a", "x-mirror-human-approval-assertion": "isolated-test-assertion" });
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers["x-engineering-agent-session-id"]).toBeUndefined();
      expect(headers["x-human-approved"]).toBeUndefined();
    }
  });

  it("does not restart approval or automatically replay a failed authenticated commit", async () => {
    const { view, root, owners, draft } = fixture(), input = prepareWorkPackageRequest(view, root.id, draft, owners);
    const fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ code: "human_approval_required" }) } as Response));
    vi.stubGlobal("fetch", fetch);
    await expect(createEngineeringApi("workspace-a").commitWorkPackage("exact-plan-preview", input)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(humanApprovalHeaders).toHaveBeenCalledTimes(1);
  });
});
