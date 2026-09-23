import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";
import { registerEngineeringRestructure, structureProposalPath, structureProposalVersionPath } from "./engineering-restructure.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";

const fixedGrant: HumanApprovalVerifier = async (_request, requirement) => ({
  kind: "authenticated_human_approval", principalId: "isolated-test-owner", approvalId: "single-structure-approval",
  requestDigest: requirement.requestDigest, expiresAt: Date.now() + 60_000
});

async function fixture(verifier?: HumanApprovalVerifier) {
  const root = mkdtempSync(join(tmpdir(), "mirror-structure-")), at = new Date().toISOString();
  const rootNode = EngineeringNodeSchema.parse({ id: "project", parent_id: null, kind: "project", title: "工程", objective: "完整交付", order: 0, revision: 1, status: "draft", constraints: { allow: ["artifacts/**"] }, criteria: [{ id: "result", text: "组合成果可用", kind: "manual" }], created_at: at, updated_at: at });
  const old = EngineeringNodeSchema.parse({ ...rootNode, id: "old", parent_id: "project", title: "旧执行步骤", kind: "task", contributes_to: ["result"] });
  atomicWriteYaml(engineeringDocumentPath(root), { schema_version: 1, id: "doc", revision: 1, root_id: "project", created_at: at, updated_at: at, nodes: [rootNode, old], runs: [], events: [], changes: [], capability_uses: [] });
  const workspaces = new TaskWorkspaces(root, new EventBus(), { source: async(id: string) => ({ id, title: "另一工程", cwd: root, version: "v1", preview: "另一工程目标", updatedAt: 1, pinned: false, received: false, receivedAt: null }) });
  const app = Fastify();
  if (verifier) registerHumanApprovalGuard(app, verifier);
  registerEngineeringRestructure(app, workspaces);
  const contract = { included: ["报告交付"], excluded: ["实际业务执行"], inputs: [], outputs: [{ id: "result", title: "报告", criterion_ids: ["result"] }] };
  const legacy = { schema_version: 1, title: "历史成果结构", reason: "旧方案只保留，不覆盖", expected_revision: 1, root: { ...rootNode, delivery: contract }, nodes: [old] };
  mkdirSync(dirname(structureProposalPath(root)), { recursive: true });
  writeFileSync(structureProposalPath(root), JSON.stringify(legacy));
  const makeProposal = (proposalId = "proposal-current", createdAt = "2026-09-07T08:00:00.000Z", nodeId = "new") => {
    const source = EngineeringNodeSchema.parse({ ...old, id: nodeId, title: "研究报告", status: "draft", owner: "未分配", revision: 1, legacy_ref: undefined, delivery: contract });
    return { schema_version: 1 as const, proposal_id: proposalId, created_at: createdAt, title: "成果结构", reason: "改为可验收成果，保留旧历史", expected_revision: 1, root: { ...rootNode, delivery: contract }, nodes: [source] };
  };
  const writeProposal = (proposal = makeProposal()) => {
    const path = structureProposalVersionPath(root, proposal.proposal_id); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(proposal)); return path;
  };
  const proposal = makeProposal(), proposalPath = writeProposal(proposal);
  return { root, app, workspaces, proposal, proposalPath, makeProposal, writeProposal, async close() { await app.close(); await workspaces.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("unsafe cleanup"); rmSync(root, { recursive: true, force: true }); } };
}

describe("reviewed whole-project outcome restructuring", () => {
  it("lets anonymous and identified Agents preview the latest pending proposal without changing authoritative bytes", async () => {
    const f = await fixture(); try {
      const before = readFileSync(engineeringDocumentPath(f.root)), legacyBefore = readFileSync(structureProposalPath(f.root)), proposalBefore = readFileSync(f.proposalPath);
      const metadata = await f.app.inject({ method: "GET", url: "/api/engineering/structure-proposal" });
      expect(metadata.json()).toMatchObject({ available: true, approval_configured: false, proposal_id: f.proposal.proposal_id, current: true });
      for (const headers of [{}, { "x-engineering-agent-session-id": "identified-agent", "x-engineering-cwd": encodeURIComponent(f.root) }]) {
        const response = await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", headers, payload: { proposal_id: f.proposal.proposal_id } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ proposal_id: f.proposal.proposal_id, approval_configured: false, expected_revision: 1, node_count: 2 });
      }
      expect(readFileSync(engineeringDocumentPath(f.root))).toEqual(before);
      expect(readFileSync(structureProposalPath(f.root))).toEqual(legacyBefore);
      expect(readFileSync(f.proposalPath)).toEqual(proposalBefore);
    } finally { await f.close(); }
  });

  it("rejects anonymous and Agent commits without authentication and without project writes", async () => {
    const f = await fixture(); try {
      const before = readFileSync(engineeringDocumentPath(f.root));
      const preview = (await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", payload: { proposal_id: f.proposal.proposal_id } })).json();
      const payload = { proposal_id: f.proposal.proposal_id, token: preview.token, expected_revision: 1 };
      for (const headers of [{}, { "x-engineering-agent-session-id": "agent", "x-engineering-cwd": encodeURIComponent(f.root) }]) {
        const response = await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/commit", headers, payload });
        expect(response.statusCode).toBe(403); expect(response.json().code).toBe("human_approval_required");
      }
      expect(readFileSync(engineeringDocumentPath(f.root))).toEqual(before);
    } finally { await f.close(); }
  });

  it("uses one trusted isolated approval once while preserving legacy, proposal and revision history", async () => {
    const f = await fixture(fixedGrant); try {
      const before = readFileSync(engineeringDocumentPath(f.root), "utf8"), legacyBefore = readFileSync(structureProposalPath(f.root)), proposalBefore = readFileSync(f.proposalPath);
      expect((await f.app.inject({ method: "GET", url: "/api/engineering/structure-proposal" })).json().approval_configured).toBe(true);
      const preview = (await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", payload: { proposal_id: f.proposal.proposal_id } })).json();
      const payload = { proposal_id: f.proposal.proposal_id, token: preview.token, expected_revision: 1 };
      const committed = await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/commit", payload });
      expect(committed.statusCode, committed.body).toBe(200);
      expect(committed.json().document).toMatchObject({ revision: 2 });
      expect(committed.json().document.nodes.find((node: any) => node.id === "old").status).toBe("archived");
      expect(committed.json().document.nodes.find((node: any) => node.id === "new")).toMatchObject({ status: "draft", owner: "未分配", revision: 1 });
      expect(readFileSync(join(dirname(engineeringDocumentPath(f.root)), "history", "revision-1.yaml"), "utf8")).toBe(before);
      expect(readFileSync(structureProposalPath(f.root))).toEqual(legacyBefore);
      expect(readFileSync(f.proposalPath)).toEqual(proposalBefore);
      const replay = await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/commit", payload });
      expect(replay.statusCode).toBe(403); expect(replay.json().code).toBe("human_approval_required");
    } finally { await f.close(); }
  });

  it("selects the newest current proposal and rejects a different proposal id", async () => {
    const f = await fixture(); try {
      const latest = f.makeProposal("proposal-latest", "2026-09-07T09:00:00.000Z", "new-latest"); f.writeProposal(latest);
      const metadata = (await f.app.inject({ method: "GET", url: "/api/engineering/structure-proposal" })).json();
      expect(metadata.proposal_id).toBe(latest.proposal_id);
      const old = await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", payload: { proposal_id: f.proposal.proposal_id } });
      expect(old.statusCode).toBe(409); expect(old.json().code).toBe("engineering_structure_proposal_mismatch");
      expect((await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", payload: { proposal_id: latest.proposal_id } })).statusCode).toBe(200);
    } finally { await f.close(); }
  });

  it("rejects hash, workspace and revision changes after preview", async () => {
    let approval = 0;
    const grant: HumanApprovalVerifier = async (_request, requirement) => ({ kind: "authenticated_human_approval", principalId: "isolated-test-owner", approvalId: "binding-" + ++approval, requestDigest: requirement.requestDigest, expiresAt: Date.now() + 60_000 });
    const f = await fixture(grant); try {
      const preview = (await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", payload: { proposal_id: f.proposal.proposal_id } })).json();
      const payload = { proposal_id: f.proposal.proposal_id, token: preview.token, expected_revision: 1 };
      const wrongId = await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/commit", payload: { ...payload, proposal_id: "proposal-missing" } });
      expect(wrongId.statusCode).toBe(404); expect(wrongId.json().code).toBe("engineering_structure_not_found");
      const changed = { ...f.proposal, reason: "预览后被替换" }; writeFileSync(f.proposalPath, JSON.stringify(changed));
      expect((await f.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/commit", payload })).statusCode).toBe(409);
    } finally { await f.close(); }

    const workspaceFixture = await fixture(grant); try {
      const preview = (await workspaceFixture.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", payload: { proposal_id: workspaceFixture.proposal.proposal_id } })).json();
      const other = await workspaceFixture.workspaces.connect({ thread_id: "other-thread", source_version: "v1", mode: "create" });
      const otherRoot = workspaceFixture.workspaces.resolve(other.id).root;
      const otherProposalPath = structureProposalVersionPath(otherRoot, workspaceFixture.proposal.proposal_id); mkdirSync(dirname(otherProposalPath), { recursive: true }); writeFileSync(otherProposalPath, JSON.stringify(workspaceFixture.proposal));
      const response = await workspaceFixture.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/commit", headers: { "x-mirror-workspace-id": other.id }, payload: { proposal_id: workspaceFixture.proposal.proposal_id, token: preview.token, expected_revision: 1 } });
      expect(response.statusCode).toBe(409); expect(response.json().code).toBe("engineering_structure_preview_required");
    } finally { await workspaceFixture.close(); }

    const revisionFixture = await fixture(grant); try {
      const preview = (await revisionFixture.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/preview", payload: { proposal_id: revisionFixture.proposal.proposal_id } })).json();
      revisionFixture.workspaces.resolve().service.createNode({ parent_id: "project", title: "预览后新增的成果", expected_revision: 1 });
      const response = await revisionFixture.app.inject({ method: "POST", url: "/api/engineering/structure-proposal/commit", payload: { proposal_id: revisionFixture.proposal.proposal_id, token: preview.token, expected_revision: 1 } });
      expect(response.statusCode).toBe(409); expect(response.json().code).toBe("engineering_revision_conflict");
    } finally { await revisionFixture.close(); }
  });
});
