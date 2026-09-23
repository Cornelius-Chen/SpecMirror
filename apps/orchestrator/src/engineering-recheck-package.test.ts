import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineeringNodeSchema, engineeringContractKey, engineeringLineageVersions, effectiveEngineeringConstraints, type EngineeringDocument, type EngineeringRun } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering } from "@epm/spec-io";
import { EngineeringExecutionService, type EngineeringRecheckPackageRequest, type EngineeringServiceOptions } from "./engineering-service.ts";
import { registerEngineeringRecheckPackageRoutes } from "./engineering-recheck-package-routes.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { freezeEngineeringSourceScope } from "./engineering-source-proof.ts";
import * as sourceProof from "./engineering-source-proof.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import type { CompanionSession } from "./codex-companion.ts";
import { EventBus } from "./events.ts";

const fixtures: Array<{ root: string; service: EngineeringExecutionService; app: FastifyInstance }> = [];
const sourcePath = (root: string, id: string) => join(root, "apps", id === "a" ? "orchestrator" : "web");
function smallDocument(root: string): EngineeringDocument {
  const stamp = new Date().toISOString();
  const criterion = (id: string) => ({ id, text: id + " 成果真实可查", kind: "manual" as const });
  const make = (id: string, parent: string | null, order: number) => EngineeringNodeSchema.parse({
    id, parent_id: parent, kind: parent ? "task" : "project", title: id, objective: "完成 " + id, revision: 1, order,
    owner: parent ? `codex:owner-${id}` : "未分配", status: parent ? "paused" : "draft",
    constraints: { allow: parent ? [`artifacts/${id}/**`] : ["artifacts/**"], deny: [".project/**"], rules: ["保留真实来源"] },
    criteria: parent ? [criterion("result")] : [criterion("a"), criterion("b"), criterion("whole")],
    delivery: { included: [id + " 结果"], excluded: ["其他项目"], inputs: [], outputs: [{ id: "out", title: id + " 结果", criterion_ids: parent ? ["result"] : ["a", "b", "whole"] }] },
    ...(parent ? { contributes_to: [id], contribution: { summary: id + " 的贡献" },
      source_scope: { root: sourcePath(root, id), allow: ["entry.txt"], deny: ["private/**"],
        checks: [{ id: "verify", title: "真实冻结检查", program: "node", timeout_ms: 120000, args: ["../../node_modules/vitest/vitest.mjs", "run", "--root", "../..", "--config", "../../vitest.config.ts", `${id}.test.ts`, "--maxWorkers=1", "--no-file-parallelism"] }] },
      actions: [{ id: "report", title: "提交报告", type: "agent_artifact", path: `artifacts/${id}/report.md`, criterion_id: "result" }]
    } : { composition: { summary: "数据和界面组合", scenario: "打开原节点查收成果", integration_criterion_ids: ["whole"] } }),
    created_at: stamp, updated_at: stamp
  });
  const nodes = [make("root", null, 0), make("a", "root", 0), make("b", "root", 1)];
  nodes[1].interactions = [{ id: "runtime-link", target_node_id: "b", source_output_id: "out", target_input_id: "", purpose: "界面读取结果", scenario: "打开成果" }];
  const doc: EngineeringDocument = { schema_version: 1, id: "isolated-recheck", root_id: "root", revision: 9, nodes, runs: [], events: [], changes: [], capability_uses: [], created_at: stamp, updated_at: stamp };
  doc.runs = nodes.slice(1).map(node => {
    const output = join(root, "old-outputs", node.id); mkdirSync(output, { recursive: true }); writeFileSync(join(output, "report.md"), "Old implementation report; check failed.\n");
    const key = engineeringContractKey(doc, node.id), owner = node.owner;
    return { id: "prior-" + node.id, node_id: node.id, mode: "external", status: "paused", actor: owner, started_at: stamp, finished_at: null,
      current_action: "", completed_action_ids: ["report"], output_dir: output, reason: "服务重启后暂停", review_note: "", reviewed_at: null,
      evidence: [{ id: "failed-check-" + node.id, criterion_id: "result", kind: "check", summary: "旧配置路径失败", passed: false, created_at: stamp }],
      source_scope: freezeEngineeringSourceScope(node.source_scope!, [root]),
      snapshot: { node: structuredClone(node), lineage: engineeringLineageVersions(doc, node.id), effective: effectiveEngineeringConstraints(doc, node.id), contract_key: key, dependencies: [], children: [] },
      handoff: { state: "claimed", owner, source_cwd: root, document_revision: doc.revision, contract_key: key, created_at: stamp, claimed_at: stamp, claimed_by: owner }
    } as EngineeringRun;
  });
  return doc;
}

async function fixture(guard = true, fullRoutes = false) {
  const root = mkdtempSync(join(tmpdir(), "mirror-recheck-package-"));
  for (const id of ["a", "b"]) { mkdirSync(sourcePath(root, id), { recursive: true }); writeFileSync(join(sourcePath(root, id), "entry.txt"), "already implemented\n"); }
  mkdirSync(join(root, "node_modules", "vitest"), { recursive: true }); writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "// isolated fixture runner; never used for a model run\n");
  writeFileSync(join(root, "vitest.config.ts"), "export default { test: { include: ['a.test.ts', 'b.test.ts'] } };\n");
  atomicWriteYaml(engineeringDocumentPath(root), smallDocument(root));
  const sessions = ["a", "b"].map(id => ({ session_id: "owner-" + id, cwd: root, last_seen_at: new Date().toISOString() } as CompanionSession));
  let allowed = true, count = 0;
  const options: EngineeringServiceOptions = { workspaceId: fullRoutes ? "host" : "isolated-workspace", approvedSourceRoots: () => [root], agentSessions: () => sessions,
    authorizeIdentity: (id, cwd) => allowed && sessions.some(session => session.session_id === id && session.cwd === cwd && cwd === root) ? "current" : false };
  const app = Fastify();
  // Explicit isolated test proof only. This verifier is never installed in production.
  const verifier: HumanApprovalVerifier = async (request, required) => request.headers["x-isolated-human"] === "yes" ? { kind: "authenticated_human_approval",
    principalId: "isolated-owner", approvalId: "test-approval-" + ++count, requestDigest: required.requestDigest, expiresAt: Date.now() + 60_000 } : null;
  if (guard) registerHumanApprovalGuard(app, verifier);
  const service = fullRoutes ? registerEngineeringRoutes(app, root, new EventBus(), undefined, undefined, options) : new EngineeringExecutionService(root, new EventBus(), undefined, options);
  // Freeze the same complete context as an actual dispatched run. The fixture
  // never creates or authenticates a production run.
  const frozen = loadEngineering(root);
  for (const run of frozen.runs) run.snapshot = service["snapshot"](frozen, run.node_id);
  atomicWriteYaml(engineeringDocumentPath(root), frozen);
  if (!fullRoutes) registerEngineeringRecheckPackageRoutes(app, request => {
    if (request.headers["x-mirror-workspace-id"] !== "isolated-workspace") throw new Error("wrong_workspace");
    return service;
  });
  await app.ready(); fixtures.push({ root, app, service });
  const input = (): EngineeringRecheckPackageRequest => {
    const doc = loadEngineering(root);
    return { expected_revision: doc.revision, reason: "修正 Vitest 配置路径，原编码保留在旧运行，本轮仅重新核验。", items: doc.nodes.filter(node => node.parent_id === "root").map(node => ({
      node_id: node.id, prior_run_id: "prior-" + node.id, checks: node.source_scope!.checks.map(check => ({ id: check.id, args: check.args.map((arg, index) => index === check.args.indexOf("--config") + 1 ? "vitest.config.ts" : arg) }))
    })) };
  };
  const call = (action: "preview" | "commit", payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/api/engineering/work-package/recheck/" + action,
    headers: { "x-mirror-workspace-id": fullRoutes ? "host" : "isolated-workspace", ...headers }, payload: payload as object });
  const preview = async (value = input()) => { const result = await call("preview", value); expect(result.statusCode, result.body).toBe(200); return result.json(); };
  const commit = (p: { token: string; request: EngineeringRecheckPackageRequest }, headers: Record<string, string> = { "x-isolated-human": "yes" }) => call("commit", { token: p.token, request: p.request }, headers);
  const bytes = () => readFileSync(engineeringDocumentPath(root), "utf8");
  const edit = (change: (doc: EngineeringDocument) => void) => { const doc = loadEngineering(root); change(doc); atomicWriteYaml(engineeringDocumentPath(root), doc); };
  return { root, service, app, sessions, input, call, preview, commit, bytes, edit, revoke: () => { allowed = false; } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.app.close(); await f.service.close();
    const target = resolve(f.root);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith("mirror-recheck-package-")) throw new Error("unsafe_test_cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("exact authenticated check-config recheck package", () => {
  it("previews without project writes and confirms two new ready contracts atomically, preserving old runs and artifacts", async () => {
    const f = await fixture(), before = f.bytes(), prior = loadEngineering(f.root), dispatch = vi.spyOn(f.service, "dispatch"), ready = vi.spyOn(f.service, "ready");
    const p = await f.preview(); expect(f.bytes()).toBe(before);
    const config = join(f.root, "vitest.config.ts"), hash = createHash("sha256").update(readFileSync(config)).digest("hex");
    for (const node of p.nodes) expect(node.checks[0].configuration).toEqual({ test_root: realpathSync.native(f.root), path: realpathSync.native(config), sha256: hash });
    expect(p.nodes.map((node: { prior_run_id: string }) => node.prior_run_id)).toEqual(["prior-a", "prior-b"]);
    expect(p.creates_runs).toBe(false); expect(p.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    const response = await f.commit(p); expect(response.statusCode, response.body).toBe(200);
    const saved = loadEngineering(f.root); expect(saved.revision).toBe(10); expect(saved.runs).toEqual(prior.runs);
    expect(saved.nodes[0]).toEqual(prior.nodes[0]); expect(saved.changes).toHaveLength(2);
    for (let i = 1; i < saved.nodes.length; i++) {
      const node = saved.nodes[i], old = prior.nodes[i];
      expect(node.status).toBe("ready"); expect(node.revision).toBe(old.revision + 1); expect(node.contract_revision).toBe(2);
      expect({ ...node, revision: old.revision, contract_revision: old.contract_revision, updated_at: old.updated_at, status: old.status, source_scope: old.source_scope })
        .toEqual({ ...old, contract_revision: old.contract_revision });
      expect({ ...node.source_scope, checks: old.source_scope!.checks }).toEqual(old.source_scope);
      expect(node.source_scope!.checks[0]).toEqual({ ...old.source_scope!.checks[0], args: p.request.items[i - 1].checks[0].args });
      const event = saved.events.find(event => event.node_id === node.id && event.readiness_contract_key)!;
      expect(event.readiness_contract_key).toBe(engineeringContractKey(saved, node.id));
      expect(JSON.parse(event.detail!)).toMatchObject({ package_kind: "check_config_recheck", work_package_id: p.token, prior_run_id: "prior-" + node.id,
        prior_status: "paused", actor: "human:isolated-owner", approval_id: "test-approval-1", manifest_digest: p.manifest_digest, pre_revision: 9, post_revision: 10 });
      expect(readFileSync(join(f.root, "old-outputs", node.id, "report.md"), "utf8")).toBe("Old implementation report; check failed.\n");
    }
    expect(dispatch).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled(); expect(f.service.activeSourceCheckIds()).toEqual([]);
    expect(existsSync(join(f.root, ".project/engineering/recursive/outputs"))).toBe(false);
    const repeated = await f.commit(p); expect(repeated.statusCode).toBe(409); expect(repeated.json().code).toBe("engineering_recheck_preview_required");
  });

  it("requires positive exact human proof, rejects either Agent header and stays closed without an installed guard", async () => {
    const f = await fixture(), p = await f.preview(), before = f.bytes();
    for (const headers of [{}, { "x-isolated-human": "yes", "x-engineering-agent-session-id": "owner-a" }, { "x-isolated-human": "yes", "x-engineering-cwd": f.root }]) {
      expect((await f.commit(p, headers as Record<string, string>)).statusCode).toBe(403); expect(f.bytes()).toBe(before);
    }
    expect((await f.commit(p)).statusCode).toBe(200);
    const unguarded = await fixture(false), proposal = await unguarded.preview(), untouched = unguarded.bytes();
    expect((await unguarded.commit(proposal)).statusCode).toBe(403); expect(unguarded.bytes()).toBe(untouched);
  });

  it("allows only the existing single --config value while keeping all tests, runners, options and timeouts fixed", async () => {
    const f = await fixture(), before = f.bytes();
    const changed = (operation: (input: EngineeringRecheckPackageRequest) => void) => { const input = f.input(); operation(input); return input; };
    const payloads: unknown[] = [
      { ...f.input(), owner: "codex:new-owner" },
      changed(input => { (input.items[0] as any).source_scope = { allow: ["**"] }; }),
      changed(input => { (input.items[0].checks[0] as any).timeout_ms = 120001; }),
      changed(input => { input.items[0].checks[0].args[0] = "evil.mjs"; }),
      changed(input => { input.items[0].checks[0].args[6] = "different.test.ts"; }),
      changed(input => { input.items[0].checks[0].args[3] = ".."; }),
      changed(input => { input.items[0].checks[0].args[7] = "--maxWorkers=8"; }),
      changed(input => { input.items[0].checks[0].args.push("--passWithNoTests"); }),
      changed(input => { input.items[0].checks[0].args[5] = "--passWithNoTests"; }),
      changed(input => { input.items[0].checks.push({ ...input.items[0].checks[0], id: "extra" }); }),
      changed(input => { input.items[0].checks[0].id = "renamed"; }),
      changed(input => { input.items.push(input.items[0]); })
    ];
    for (const payload of payloads) { const result = await f.call("preview", payload); expect(result.statusCode, result.body).toBe(400); expect(f.bytes()).toBe(before); }
    const unchanged = f.input(); unchanged.items[0].checks[0].args[5] = "../../vitest.config.ts";
    expect((await f.call("preview", unchanged)).json().code).toBe("engineering_recheck_no_changes");
  });

  it.each(["running", "queued", "review", "accepted", "stale"] as const)("rejects a %s prior run without changing history", async status => {
    const f = await fixture(); f.edit(doc => { doc.runs[0].status = status; }); const before = f.bytes();
    const result = await f.call("preview", f.input()); expect(result.statusCode).toBe(409); expect(f.bytes()).toBe(before);
  });

  it("rejects a different run, old frozen args, changed owner and unsupported dependency chains", async () => {
    const f = await fixture(), initial = loadEngineering(f.root);
    const cases: Array<(doc: EngineeringDocument) => void> = [
      doc => { doc.runs[0].actor = "codex:owner-b"; },
      doc => { doc.runs[0].handoff!.owner = "codex:owner-b"; },
      doc => { doc.runs[0].source_scope!.checks[0].args[6] = "other.test.ts"; },
      doc => { doc.nodes[1].dependencies = ["b"]; },
      doc => { doc.nodes[2].prerequisites = [{ id: "needs-a", node_id: "a", reason: "needs it" }]; }
    ];
    for (const mutate of cases) {
      const doc = structuredClone(initial); mutate(doc); atomicWriteYaml(engineeringDocumentPath(f.root), doc); const before = f.bytes();
      const reply = await f.call("preview", f.input()); expect(reply.statusCode, reply.body).not.toBe(200); expect(f.bytes()).toBe(before);
    }
    atomicWriteYaml(engineeringDocumentPath(f.root), initial);
    const wrong = f.input(); wrong.items[0].prior_run_id = "prior-b";
    expect((await f.call("preview", wrong)).json().code).toBe("engineering_recheck_current_run_required");
  });

  it("does not quietly invalidate an unselected interacting run", async () => {
    const f = await fixture(), input = f.input(), before = f.bytes(); input.items = input.items.slice(0, 1);
    const reply = await f.call("preview", input); expect(reply.statusCode, reply.body).toBe(409); expect(reply.json().code).toBe("engineering_recheck_unselected_impact"); expect(f.bytes()).toBe(before);
  });

  it("rejects same-revision action or criterion changes before preview instead of silently readying a different frozen contract", async () => {
    const f = await fixture(), initial = loadEngineering(f.root);
    for (const mutate of [
      (doc: EngineeringDocument) => { doc.nodes[1].actions[0].path = "artifacts/a/extra.md"; },
      (doc: EngineeringDocument) => { doc.nodes[1].criteria[0].text = "weaker criterion"; },
      (doc: EngineeringDocument) => { doc.nodes[1].constraints.allow.push("artifacts/extra/**"); }
    ]) {
      atomicWriteYaml(engineeringDocumentPath(f.root), initial); f.edit(mutate); const before = f.bytes();
      const response = await f.call("preview", f.input()); expect(response.statusCode).toBe(409); expect(response.json().code).toBe("engineering_recheck_contract_changed"); expect(f.bytes()).toBe(before);
    }
  });

  it("rejects same-revision ancestor contract changes while permitting presentation-only titles", async () => {
    const f = await fixture(), original = loadEngineering(f.root);
    for (const mutate of [
      (doc: EngineeringDocument) => { doc.nodes[0].constraints.rules.push("unapproved new authority"); },
      (doc: EngineeringDocument) => { doc.nodes[0].objective += " altered goal"; },
      (doc: EngineeringDocument) => { doc.nodes[0].composition!.scenario += " changed scenario"; },
      (doc: EngineeringDocument) => { doc.nodes[0].criteria[0].text += " altered criterion"; }
    ]) {
      atomicWriteYaml(engineeringDocumentPath(f.root), original); f.edit(mutate); const before = f.bytes();
      const reply = await f.call("preview", f.input()); expect(reply.statusCode, reply.body).toBe(409); expect(reply.json().code).toBe("engineering_recheck_contract_changed"); expect(f.bytes()).toBe(before);
    }
    atomicWriteYaml(engineeringDocumentPath(f.root), original); f.edit(doc => { doc.nodes[0].title = "Readable project"; doc.nodes[1].title = "Readable leaf"; });
    expect((await f.preview()).nodes[0].title).toBe("Readable leaf");
  });

  it("rejects stale document, root changes, changed history and new execution after preview atomically", async () => {
    const f = await fixture(), initial = loadEngineering(f.root);
    for (const change of [
      (doc: EngineeringDocument) => { doc.revision++; },
      (doc: EngineeringDocument) => { doc.nodes[0].objective += " same revision change"; },
      (doc: EngineeringDocument) => { doc.runs[0].reason += " another update"; },
      (doc: EngineeringDocument) => { doc.runs[0].status = "running"; }
    ]) {
      atomicWriteYaml(engineeringDocumentPath(f.root), initial); const p = await f.preview(); f.edit(change); const before = f.bytes();
      const reply = await f.commit(p); expect(reply.statusCode, reply.body).toBe(409); expect(f.bytes()).toBe(before);
    }
  });

  it("rejects changed requests, expired previews, foreign tokens and lost real owner identity", async () => {
    const f = await fixture(), p = await f.preview(), before = f.bytes(), changed = structuredClone(p); changed.request.reason += " changed";
    expect((await f.commit(changed)).json().code).toBe("engineering_recheck_preview_mismatch"); expect(f.bytes()).toBe(before);
    const other = await fixture(); expect((await other.commit(p)).json().code).toBe("engineering_recheck_preview_required");
    f.revoke(); expect((await f.commit(p)).statusCode).toBe(403); expect(f.bytes()).toBe(before);
    const fresh = await fixture(), expired = await fresh.preview(), untouched = fresh.bytes(), at = Date.now(); vi.spyOn(Date, "now").mockReturnValue(at + 11 * 60_000);
    expect((await fresh.commit(expired)).json().code).toBe("engineering_recheck_preview_required"); expect(fresh.bytes()).toBe(untouched);
  });

  it("keeps first-time work packages closed to history and exposes the new preview through actual route guards", async () => {
    const f = await fixture(true, true);
    const result = await f.preview(); expect(result.nodes).toHaveLength(2);
    expect(() => f.service.previewWorkPackage({ root_id: "root", expected_revision: 9, composition: loadEngineering(f.root).nodes[0].composition!, assignments: [{ node_id: "a", owner: "codex:owner-a" }], reason: "must reject history" })).toThrow();
    expect((await f.commit(result, {})).statusCode).toBe(403);
    expect((await f.commit(result)).statusCode).toBe(200);
  });

  it("links a later normal dispatch to prior execution without copying its evidence or recoding attribution", async () => {
    const f = await fixture(), prior = loadEngineering(f.root).runs, p = await f.preview(); expect((await f.commit(p)).statusCode).toBe(200);
    const saved = loadEngineering(f.root); f.service.dispatch({ node_ids: ["a"], mode: "external", expected_revision: saved.revision }, "codex:owner-a");
    const doc = loadEngineering(f.root), next = doc.runs.at(-1)!;
    expect(doc.runs.slice(0, 2)).toEqual(prior); expect(next.id).not.toBe("prior-a"); expect(next.evidence).toEqual([]);
    const event = doc.events.find(event => event.run_id === next.id && event.detail?.includes("verification_retry_only"));
    expect(JSON.parse(event!.detail!)).toMatchObject({ prior_run_id: "prior-a", new_run_id: next.id, work_package_id: p.token, attribution: "verification_retry_only" });
    expect(next.snapshot.node.source_scope!.checks[0].args[5]).toBe("vitest.config.ts");
  });

  it("accepts the existing pnpm Vitest junction while preserving nested source write boundaries", async () => {
    const f = await fixture(), original = loadEngineering(f.root);
    const installed = join(f.root, "node_modules", ".pnpm", "vitest-isolated", "node_modules", "vitest");
    mkdirSync(join(f.root, "node_modules", ".pnpm", "vitest-isolated", "node_modules"), { recursive: true });
    renameSync(join(f.root, "node_modules", "vitest"), installed);
    symlinkSync(installed, join(f.root, "node_modules", "vitest"), "junction");
    const p = await f.preview(); expect((await f.commit(p)).statusCode).toBe(200);
    const saved = loadEngineering(f.root);
    for (const id of ["a", "b"]) {
      const old = original.nodes.find(node => node.id === id)!.source_scope!, scope = saved.nodes.find(node => node.id === id)!.source_scope!;
      expect(scope.root).toBe(sourcePath(f.root, id)); expect(scope.allow).toEqual(old.allow); expect(scope.deny).toEqual(old.deny);
      expect(scope.checks[0].args[0]).toBe("../../node_modules/vitest/vitest.mjs");
    }
  });

  it("rejects parent/absolute config escapes and a different config basename without project writes", async () => {
    const f = await fixture(), before = f.bytes();
    for (const config of ["../vitest.config.ts", "../../vitest.config.ts", join(tmpdir(), "vitest.config.ts"), "other.config.ts"]) {
      const input = f.input(); input.items[0].checks[0].args[5] = config;
      const response = await f.call("preview", input); expect(response.statusCode, response.body).toBe(400); expect(f.bytes()).toBe(before);
    }
  });

  it("rejects config junction ancestors and hardlinked or nonregular files", async () => {
    const f = await fixture(), before = f.bytes(), config = join(f.root, "vitest.config.ts");
    const actual = join(f.root, "config-files"); mkdirSync(actual); writeFileSync(join(actual, "vitest.config.ts"), "export default {};\n");
    symlinkSync(actual, join(f.root, "linked-config"), "junction");
    const input = f.input(); input.items[0].checks[0].args[5] = "linked-config/vitest.config.ts";
    expect((await f.call("preview", input)).json().code).toBe("engineering_recheck_config_link");
    linkSync(config, join(f.root, "config-copy.ts"));
    expect((await f.call("preview", f.input())).json().code).toBe("engineering_recheck_config_file_invalid");
    renameSync(config, join(f.root, "saved-config.ts")); mkdirSync(config);
    expect((await f.call("preview", f.input())).json().code).toBe("engineering_recheck_config_file_invalid");
    expect(f.bytes()).toBe(before);
  });

  it("binds preview to config bytes and refuses a changed file at commit", async () => {
    const f = await fixture(), p = await f.preview(), before = f.bytes();
    writeFileSync(join(f.root, "vitest.config.ts"), "export default { test: { passWithNoTests: true } };\n");
    const response = await f.commit(p); expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("engineering_recheck_manifest_changed"); expect(f.bytes()).toBe(before);
  });

  it("refuses a changed approved config before dispatch without creating a new run", async () => {
    const f = await fixture(), p = await f.preview(); expect((await f.commit(p)).statusCode).toBe(200); const before = f.bytes();
    writeFileSync(join(f.root, "vitest.config.ts"), "export default {};\n");
    expect(() => f.service.dispatch({ node_ids: ["a"], mode: "external" }, "codex:owner-a")).toThrow(/配置文件在确认后已变化/);
    expect(f.bytes()).toBe(before); expect(loadEngineering(f.root).runs).toHaveLength(2);
  });

  it("blocks queued work when config changes before its actual start", async () => {
    const f = await fixture(), p = await f.preview(); expect((await f.commit(p)).statusCode).toBe(200);
    f.service.dispatch({ node_ids: ["a"], mode: "external" }, "codex:owner-a");
    const prior = loadEngineering(f.root).runs.slice(0, 2), id = loadEngineering(f.root).runs.at(-1)!.id;
    writeFileSync(join(f.root, "vitest.config.ts"), "export default {};\n"); await f.service.settled();
    const doc = loadEngineering(f.root), run = doc.runs.at(-1)!;
    expect(run.id).toBe(id); expect(run.status).toBe("blocked"); expect(doc.runs.slice(0, 2)).toEqual(prior);
    expect(run.source_baseline).toBeUndefined(); expect(existsSync(run.output_dir)).toBe(false);
  });

  it("keeps the confirmed config guard across a queued service restart", async () => {
    const f = await fixture(), p = await f.preview(); expect((await f.commit(p)).statusCode).toBe(200);
    f.service.dispatch({ node_ids: ["a"], mode: "external" }, "codex:owner-a"); await f.service.close();
    writeFileSync(join(f.root, "vitest.config.ts"), "export default {};\n");
    const restored = new EngineeringExecutionService(f.root, new EventBus(), undefined, f.service.options);
    try {
      await restored.settled(); const run = loadEngineering(f.root).runs.at(-1)!;
      expect(run.status).toBe("blocked"); expect(run.reason).toMatch(/配置文件在确认后已变化/); expect(run.source_baseline).toBeUndefined();
    } finally { await restored.close(); }
  });

  it("blocks a running recheck before launching checks if the confirmed config changed", async () => {
    const f = await fixture(), p = await f.preview(); expect((await f.commit(p)).statusCode).toBe(200);
    f.service.dispatch({ node_ids: ["a"], mode: "external" }, "codex:owner-a"); await f.service.settled();
    const run = loadEngineering(f.root).runs.at(-1)!; expect(run.status).toBe("running");
    await f.service.executeAction(run.id, "report", false, { content: "New verification report; implementation belongs to prior-a.\n" }, "codex:owner-a");
    const verify = vi.spyOn(sourceProof, "verifyEngineeringSourceProof");
    writeFileSync(join(f.root, "vitest.config.ts"), "export default {};\n");
    await expect(f.service.finish(run.id, false, "codex:owner-a")).rejects.toThrow(/配置文件在确认后已变化/);
    const saved = loadEngineering(f.root).runs.at(-1)!;
    expect(verify).not.toHaveBeenCalled(); expect(saved.status).toBe("blocked"); expect(saved.current_action).toBe(""); expect(saved.source_proof).toBeUndefined();
  });

  it("does not accept a successful child exit when the confirmed config changes during that actual check", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "node_modules", "vitest", "vitest.mjs"), "import { writeFileSync } from 'node:fs'; import { resolve } from 'node:path'; writeFileSync(resolve(process.cwd(), '../..', 'vitest.config.ts'), 'export default {};'); console.log('isolated child exited successfully');\n");
    const p = await f.preview(); expect((await f.commit(p)).statusCode).toBe(200);
    f.service.dispatch({ node_ids: ["a"], mode: "external" }, "codex:owner-a"); await f.service.settled();
    const run = loadEngineering(f.root).runs.at(-1)!;
    await f.service.executeAction(run.id, "report", false, { content: "Report for isolated real child config mutation test.\n" }, "codex:owner-a");
    await expect(f.service.finish(run.id, false, "codex:owner-a")).rejects.toThrow(/配置文件在确认后已变化/);
    const saved = loadEngineering(f.root).runs.at(-1)!;
    expect(saved.status).toBe("blocked"); expect(saved.current_action).toBe(""); expect(saved.source_proof).toBeUndefined();
    expect(saved.evidence.some(item => item.kind === "check" && item.passed)).toBe(false);
    expect(readFileSync(join(f.root, "vitest.config.ts"), "utf8")).toBe("export default {};");
  });

  it("checks optional execution context before every child and after each exit, skipping later checks on context failure", async () => {
    const f = await fixture(), root = sourcePath(f.root, "a"), source = loadEngineering(f.root).nodes[1].source_scope!;
    const scope = freezeEngineeringSourceScope({ ...source, checks: ["first", "second"].map(id => ({ id, title: id, program: "node" as const,
      args: ["-e", `require('node:fs').writeFileSync('entry.txt', '${id}');`], timeout_ms: 5000 })) }, [f.root]);
    const baseline = sourceProof.captureEngineeringSourceBaseline(scope); let calls = 0;
    const proof = await sourceProof.verifyEngineeringSourceProof(baseline, [f.root], { assertCheckContext: () => { if (++calls === 3) throw new Error("isolated config context changed"); } });
    expect(calls).toBe(3); expect(proof.passed).toBe(false); expect(proof.status).toBe("blocked"); expect(proof.checks[1].status).toBe("not_run");
    expect(readFileSync(join(root, "entry.txt"), "utf8")).toBe("first");
  });
});
