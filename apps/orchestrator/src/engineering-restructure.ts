import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { EngineeringNodeSchema, deriveEngineeringView, type EngineeringDocument } from "@epm/domain";
import { EngineeringServiceError } from "./engineering-service.ts";
import { requestWorkspaceId, type TaskWorkspaces } from "./task-workspaces.ts";
import { humanApprovalConfigured, registerHumanApprovalGuard } from "./human-approval.ts";

const ProposalCore = z.object({
  schema_version: z.literal(1), title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(12000), expected_revision: z.number().int().positive(),
  root: EngineeringNodeSchema, nodes: z.array(EngineeringNodeSchema).min(1).max(300)
}).strict();
const VersionedProposal = ProposalCore.extend({
  proposal_id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),
  created_at: z.string().datetime({ offset: true })
}).strict();
const ProposalSelection = z.object({ proposal_id: z.string().trim().min(1).max(160) }).strict();

type StructureProposal = z.infer<typeof VersionedProposal>;
interface LoadedProposal { proposal: StructureProposal; hash: string; path: string; legacy: boolean }

export const structureProposalPath = (root: string) => join(root, ".project", "engineering", "recursive", "structure-proposal.json");
export const structureProposalsPath = (root: string) => join(root, ".project", "engineering", "recursive", "proposals");
export const structureProposalVersionPath = (root: string, proposalId: string) => join(structureProposalsPath(root), proposalId + ".json");

function fail(code: string, message: string, status = 409): never { throw new EngineeringServiceError(code, message, status); }

function checkedContent(root: string, path: string) {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel.startsWith("..") || isAbsolute(rel)) fail("engineering_structure_path_invalid", "结构方案必须保存在当前工程中。", 403);
  if (statSync(path).size > 2_000_000) fail("engineering_structure_too_large", "结构方案超过可审查大小。", 400);
  return readFileSync(path, "utf8");
}

/** Versioned proposal files are immutable review inputs. The legacy singleton is
 * read for compatibility and is never moved, rewritten or used as approval. */
function loadProposals(root: string): LoadedProposal[] {
  const loaded: LoadedProposal[] = [];
  const legacyPath = structureProposalPath(root);
  if (existsSync(legacyPath)) {
    const content = checkedContent(root, legacyPath), hash = createHash("sha256").update(content).digest("hex");
    const legacy = ProposalCore.parse(JSON.parse(content));
    loaded.push({ proposal: { ...legacy, proposal_id: "legacy-" + hash.slice(0, 24), created_at: statSync(legacyPath).mtime.toISOString() }, hash, path: legacyPath, legacy: true });
  }
  const directory = structureProposalsPath(root);
  if (existsSync(directory)) {
    const rel = relative(realpathSync(root), realpathSync(directory));
    if (rel.startsWith("..") || isAbsolute(rel)) fail("engineering_structure_path_invalid", "结构方案目录必须位于当前工程中。", 403);
    const entries = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === ".json");
    if (entries.length > 500) fail("engineering_structure_too_many", "待审查结构方案过多，请先整理历史方案。", 400);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), content = checkedContent(root, path);
      const proposal = VersionedProposal.parse(JSON.parse(content));
      if (basename(entry.name, extname(entry.name)) !== proposal.proposal_id) fail("engineering_structure_id_path_mismatch", "结构方案编号必须与不可变文件名一致。", 400);
      loaded.push({ proposal, hash: createHash("sha256").update(content).digest("hex"), path, legacy: false });
    }
  }
  const ids = new Set<string>();
  for (const item of loaded) {
    if (ids.has(item.proposal.proposal_id)) fail("engineering_structure_id_conflict", "结构方案编号重复。", 409);
    ids.add(item.proposal.proposal_id);
  }
  return loaded;
}

function adopted(document: EngineeringDocument, item: LoadedProposal) {
  return item.proposal.nodes.every(candidate => document.nodes.some(node => node.id === candidate.id));
}

function latestPending(document: EngineeringDocument, proposals: LoadedProposal[]) {
  return proposals.filter(item => item.proposal.expected_revision === document.revision && !adopted(document, item)).sort((a, b) => {
    const time = Date.parse(a.proposal.created_at) - Date.parse(b.proposal.created_at);
    return time || a.proposal.proposal_id.localeCompare(b.proposal.proposal_id);
  }).at(-1);
}

/** A proposal is local review material, never an automatically adopted plan. */
export function registerEngineeringRestructure(app: FastifyInstance, workspaces: TaskWorkspaces) {
  registerHumanApprovalGuard(app);
  const previews = new Map<string, { workspace: string; proposalId: string; revision: number; hash: string; expires: number }>();
  const read = (request: FastifyRequest, requestedId?: string) => {
    const context = workspaces.resolve(requestWorkspaceId(request));
    const document = context.service.view().document, proposals = loadProposals(context.root);
    const selected = latestPending(document, proposals);
    if (requestedId) {
      const requested = proposals.find(item => item.proposal.proposal_id === requestedId);
      if (!requested) fail("engineering_structure_not_found", "没有找到这份成果结构。", 404);
      if (requested.proposal.expected_revision !== document.revision) fail("engineering_revision_conflict", "工程已更新，请基于当前版本重新准备结构方案。", 409);
      if (adopted(document, requested)) fail("engineering_structure_already_applied", "这份成果结构已经应用并保留在历史中。", 409);
      if (selected?.proposal.proposal_id !== requestedId) fail("engineering_structure_proposal_mismatch", "已有更新的待审查结构，请重新查看当前方案。", 409);
    }
    return { context, document, proposals, selected };
  };
  const respond = async (reply: any, operation: () => unknown) => {
    try { return reply.send(operation()); }
    catch (error) {
      const known = error instanceof EngineeringServiceError;
      const code = known ? error.code : error instanceof Error && error.message === "engineering_revision_conflict" ? "engineering_revision_conflict" : "engineering_structure_invalid";
      return reply.code(known ? error.status : code === "engineering_revision_conflict" ? 409 : 400).send({ code, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const human = (request: FastifyRequest) => {
    if (request.headers["x-engineering-agent-session-id"] !== undefined || request.headers["x-engineering-cwd"] !== undefined) fail("engineering_human_action_required", "工程重组需由监督者查看影响后应用。", 403);
  };
  app.get("/api/engineering/structure-proposal", (request, reply) => respond(reply, () => {
    const { document, proposals, selected } = read(request);
    const approval_configured = humanApprovalConfigured(app);
    if (!selected) return { available: false, approval_configured, adopted: proposals.some(item => adopted(document, item)) };
    const proposal = selected.proposal;
    return { available: true, approval_configured, proposal_id: proposal.proposal_id, created_at: proposal.created_at,
      title: proposal.title, reason: proposal.reason, expected_revision: proposal.expected_revision,
      current_revision: document.revision, current: true, node_count: proposal.nodes.length + 1 };
  }));
  app.post<{ Body: { proposal_id: string } }>("/api/engineering/structure-proposal/preview", (request, reply) => respond(reply, () => {
    const selection = ProposalSelection.parse(request.body ?? {});
    const { context, selected } = read(request, selection.proposal_id);
    if (!selected) fail("engineering_structure_not_found", "当前工程还没有待审查的成果结构。", 404);
    const proposal = selected.proposal;
    const prepared = context.service.previewDraftStructure(proposal.root.id, proposal.nodes, proposal.root, proposal.expected_revision);
    const token = randomUUID();
    for (const [key, saved] of previews) if (saved.expires < Date.now()) previews.delete(key);
    if (previews.size >= 100) previews.delete(previews.keys().next().value!);
    previews.set(token, { workspace: context.record.id, proposalId: proposal.proposal_id, revision: proposal.expected_revision, hash: selected.hash, expires: Date.now() + 30 * 60_000 });
    return { token, proposal_id: proposal.proposal_id, created_at: proposal.created_at, approval_configured: humanApprovalConfigured(app),
      title: proposal.title, reason: proposal.reason, expected_revision: proposal.expected_revision,
      affected_ids: prepared.affected_ids, invalidated_run_ids: prepared.invalidated_run_ids,
      view: deriveEngineeringView(prepared.document), node_count: proposal.nodes.length + 1 };
  }));
  app.post<{ Body: { proposal_id: string; token: string; expected_revision: number } }>("/api/engineering/structure-proposal/commit", (request, reply) => respond(reply, () => {
    human(request);
    const selection = ProposalSelection.parse({ proposal_id: request.body?.proposal_id });
    const { context, selected } = read(request, selection.proposal_id);
    if (!selected) fail("engineering_structure_not_found", "当前工程还没有待审查的成果结构。", 404);
    const proposal = selected.proposal, saved = previews.get(request.body?.token);
    if (!saved || saved.expires < Date.now() || saved.workspace !== context.record.id || saved.proposalId !== proposal.proposal_id
      || saved.hash !== selected.hash || saved.revision !== request.body?.expected_revision || saved.revision !== proposal.expected_revision) {
      fail("engineering_structure_preview_required", "结构或预览已变化，请重新查看完整方案及影响。");
    }
    const result = context.service.replaceDraftStructure(proposal.root.id, proposal.nodes, proposal.root, saved.revision, proposal.reason);
    previews.delete(request.body.token);
    return result;
  }));
}
