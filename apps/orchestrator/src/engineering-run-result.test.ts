import { createHash, randomUUID } from "node:crypto";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineeringNodeSchema, effectiveEngineeringConstraints, engineeringContractKey, type EngineeringDocument, type EngineeringEvidence, type EngineeringRun, type EngineeringRunMetrics, type EngineeringSourceProof } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { buildEngineeringRunResult } from "./engineering-run-result.ts";
import { captureEngineeringSourceBaseline, freezeEngineeringSourceScope } from "./engineering-source-proof.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";

// Spy wrappers call the real implementations; they only record whether export tries to run a process.
vi.mock("node:child_process", { spy: true });
vi.mock("node:fs", { spy: true });

const at = "2026-09-01T10:00:00.000Z", finished = "2026-09-01T10:01:00.000Z";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fixtures: Array<{ root: string; app: FastifyInstance }> = [];

function document(): EngineeringDocument {
  const node = EngineeringNodeSchema.parse({ id: "result-node", parent_id: null, kind: "task", title: "导出隔离运行结果", objective: "可核对的结果", owner: "未分配", order: 0, revision: 1, status: "review", created_at: at, updated_at: at,
    constraints: { allow: ["artifacts/**"], deny: ["artifacts/private/**"], rules: [], resources: [] } });
  return { schema_version: 1, id: "isolated-result-document", revision: 1, root_id: node.id, created_at: at, updated_at: at, nodes: [node], runs: [], events: [], changes: [], capability_uses: [] };
}

function runFor(root: string, doc: EngineeringDocument, overrides: Partial<EngineeringRun> = {}): EngineeringRun {
  const id = overrides.id ?? "engineering-run-" + randomUUID(), node = doc.nodes[0];
  return { id, node_id: node.id, mode: "external", status: "review", actor: "codex:isolated-not-a-real-session", started_at: at, finished_at: finished, current_action: "", completed_action_ids: [], evidence: [],
    output_dir: join(root, ".project", "engineering", "recursive", "outputs", id), reason: "", review_note: "", reviewed_at: null,
    snapshot: { node: structuredClone(node), lineage: [{ id: node.id, revision: node.revision }], effective: effectiveEngineeringConstraints(doc, node.id), contract_key: engineeringContractKey(doc, node.id), dependencies: [], children: [] }, ...overrides };
}

function evidence(id: string, path: string, hash?: string): EngineeringEvidence {
  return { id, criterion_id: "delivery", kind: "artifact", summary: "隔离测试材料", path, ...(hash === undefined ? {} : { sha256: hash }), passed: true, created_at: finished };
}

function file(path: string, contents: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); }

// Every fixture, registry and stored run exists only beneath this test's owned temporary root.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-run-result-")), app = Fastify(), events = new EventBus();
  fixtures.push({ root, app });
  const usageObserver = vi.fn(() => undefined);
  const workspaces = new TaskWorkspaces(root, events, { source: async id => ({ id, title: "结果导出隔离工作区", cwd: join(root, "source-" + id), version: "fixture-v1", preview: "仅用于测试", updatedAt: 1, pinned: false, received: false, receivedAt: null }) }, { usageObserver: { snapshot: usageObserver } });
  registerEngineeringRoutes(app, root, events, undefined, workspaces);
  await app.ready();
  const connect = async (id: string) => {
    mkdirSync(join(root, "source-" + id), { recursive: true });
    const record = await workspaces.connect({ thread_id: id, source_version: "fixture-v1", mode: "create" });
    const context = workspaces.resolve(record.id);
    await workspaces.settled();
    const doc = document();
    atomicWriteYaml(engineeringDocumentPath(context.root), doc);
    return { id: record.id, root: context.root, sourceRoot: context.record.source_cwd, doc, service: context.service };
  };
  const save = (scope: { root: string; doc: EngineeringDocument }) => atomicWriteYaml(engineeringDocumentPath(scope.root), scope.doc);
  const get = (workspace: string, runId: string, suffix = "") => app.inject({ method: "GET", url: `/api/engineering/runs/${encodeURIComponent(runId)}/result?workspace=${encodeURIComponent(workspace)}${suffix}` });
  return { root, app, events, workspaces, usageObserver, connect, save, get };
}

function treeContents(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) { result[path + "/"] = "directory"; walk(join(directory, entry.name), path + "/"); }
      else if (entry.isFile()) result[path] = sha(readFileSync(join(directory, entry.name)));
      else result[path] = "link-or-special-file";
    }
  };
  walk(root, ""); return result;
}

afterEach(async () => {
  for (const item of fixtures.splice(0).reverse()) {
    await item.app.close();
    const full = resolve(item.root), temporary = resolve(tmpdir()) + sep;
    if (!full.startsWith(temporary) || !full.slice(temporary.length).startsWith("mirror-run-result-")) throw new Error("unsafe_run_result_fixture_cleanup");
    rmSync(full, { recursive: true, force: true });
  }
});

describe("read-only engineering run result route", () => {
  it("exports the exact workspace run, frozen version and recorded review with download headers", async () => {
    const f = await fixture(), a = await f.connect("a"), b = await f.connect("b");
    const run = runFor(a.root, a.doc, { status: "accepted", reviewed_at: finished, review_note: "已核对实际文件" });
    run.evidence = [evidence("result", "artifacts/result.txt", sha("actual result"))];
    file(join(run.output_dir, "artifacts/result.txt"), "actual result"); a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="engineering-run-result.json"');
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({ schema_version: 1, kind: "engineering-run-result", workspace_id: a.id, node_id: run.node_id, run_id: run.id, node_revision: 1, contract_key: run.snapshot.contract_key,
      run_status: "accepted", started_at: at, finished_at: finished, current_contract: true, review: { reviewed_at: finished, review_note: "已核对实际文件" }, metrics: null,
      artifacts: [{ evidence_id: "result", path: "artifacts/result.txt", status: "verified", recorded_sha256: sha("actual result"), actual_sha256: sha("actual result") }] });
    expect(Number.isFinite(Date.parse(response.json().observed_at))).toBe(true);
    for (const [workspace, id] of [[b.id, run.id], [a.id, "engineering-run-00000000-0000-0000-0000-000000000000"], ["workspace-00000000-0000-0000-0000-000000000000", run.id]]) {
      expect((await f.get(workspace, id)).statusCode).toBe(404);
    }
    expect((await f.get("host", run.id)).statusCode).toBe(404);
  });

  it("keeps historical runs readable and uses both contract equality and current run identity", async () => {
    const f = await fixture(), a = await f.connect("history");
    const old = runFor(a.root, a.doc, { status: "accepted", reviewed_at: finished, review_note: "旧运行验收记录" }), latest = runFor(a.root, a.doc);
    a.doc.runs.push(old, latest); f.save(a);
    expect((await f.get(a.id, old.id)).json()).toMatchObject({ run_status: "accepted", current_contract: false, review: { review_note: "旧运行验收记录" } });
    expect((await f.get(a.id, latest.id)).json()).toMatchObject({ run_status: "review", current_contract: true, review: null });
    a.doc.nodes[0].revision += 1; a.doc.nodes[0].contract_revision = 2; a.doc.nodes[0].objective = "新的完成条件"; f.save(a);
    const history = await f.get(a.id, latest.id);
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ current_contract: false, node_revision: 1, contract_key: latest.snapshot.contract_key });
  });

  it("distinguishes verified, missing, changed, unrecorded and unreadable artifacts without returning bodies", async () => {
    const f = await fixture(), a = await f.connect("hashes"), run = runFor(a.root, a.doc);
    run.evidence = [evidence("verified", "artifacts/verified.txt", sha("original")), evidence("missing", "artifacts/missing.txt", sha("removed")), evidence("changed", "artifacts/changed.txt", sha("old")), evidence("unrecorded", "artifacts/unrecorded.txt"), evidence("unreadable", "artifacts/directory", sha("directory-is-not-a-file"))];
    file(join(run.output_dir, "artifacts/verified.txt"), "original"); file(join(run.output_dir, "artifacts/changed.txt"), "replacement body must not be returned"); file(join(run.output_dir, "artifacts/unrecorded.txt"), "unrecorded body"); mkdirSync(join(run.output_dir, "artifacts/directory"));
    a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id), result = response.json();
    expect(response.statusCode, response.body).toBe(200);
    expect(Object.fromEntries(result.artifacts.map((item: { evidence_id: string; status: string }) => [item.evidence_id, item.status]))).toEqual({ verified: "verified", missing: "missing", changed: "changed", unrecorded: "unrecorded", unreadable: "unreadable" });
    expect(result.artifacts.find((item: { evidence_id: string }) => item.evidence_id === "changed")).toMatchObject({ recorded_sha256: sha("old"), actual_sha256: sha("replacement body must not be returned") });
    expect(result.artifacts.find((item: { evidence_id: string }) => item.evidence_id === "unrecorded").recorded_sha256).toBeNull();
    expect(result.issues.map((issue: { evidence_id?: string }) => issue.evidence_id)).toEqual(expect.arrayContaining(["missing", "changed", "unrecorded", "unreadable"]));
    expect(response.body).not.toContain("replacement body"); expect(response.body).not.toContain("unrecorded body");
  });

  it("leaves YAML, SQLite, events, metrics and missing output directories untouched across repeated GETs", async () => {
    const f = await fixture(), a = await f.connect("readonly"), run = runFor(a.root, a.doc, { status: "running", finished_at: null });
    const baseline = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 140, observed_at: at };
    const latest = { input_tokens: 109, cached_input_tokens: 22, output_tokens: 43, reasoning_output_tokens: 11, total_tokens: 152, observed_at: finished };
    const metrics: EngineeringRunMetrics = { source: "codex_rollout", attribution: "assigned_task_window", state: "observed", baseline, latest, token_usage: { input_tokens: 9, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 12 } };
    run.metrics = metrics; run.evidence = [evidence("absent", "artifacts/not-created.txt", sha("absent"))]; a.doc.runs.push(run); f.save(a);
    f.usageObserver.mockClear();
    const before = treeContents(f.root), events = structuredClone(f.events.history), saved = loadEngineering(a.root);
    for (let count = 0; count < 3; count++) {
      const response = await f.get(a.id, run.id);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ run_status: "running", finished_at: null, metrics, artifacts: [{ status: "missing" }] });
    }
    expect(existsSync(run.output_dir)).toBe(false);
    expect(f.usageObserver).not.toHaveBeenCalled(); expect(f.events.history).toEqual(events);
    expect(loadEngineering(a.root)).toEqual(saved); expect(treeContents(f.root)).toEqual(before);
  });

  it("keeps physical failure visible when its recorded hash is also absent", async () => {
    const f = await fixture(), a = await f.connect("no-hash"), run = runFor(a.root, a.doc);
    run.evidence = [evidence("readable", "artifacts/readable.txt"), evidence("missing", "artifacts/absent.txt"), evidence("unsafe", "../outside.txt")];
    file(join(run.output_dir, "artifacts/readable.txt"), "has no original hash"); a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id), result = response.json();
    expect(response.statusCode, response.body).toBe(200);
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_id: "readable", status: "unrecorded", recorded_sha256: null }),
      expect.objectContaining({ evidence_id: "missing", status: "missing", recorded_sha256: null, actual_sha256: null }),
      expect.objectContaining({ evidence_id: "unsafe", status: "unreadable", recorded_sha256: null, actual_sha256: null })
    ]));
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "artifact_unrecorded", evidence_id: "missing" }), expect.objectContaining({ code: "artifact_unrecorded", evidence_id: "unsafe" })]));
  });

  it("represents an unexecuted queued record without inventing checks, finish time, review or usage", async () => {
    const f = await fixture(), a = await f.connect("not-executed"), run = runFor(a.root, a.doc, { status: "queued", started_at: "", finished_at: null });
    a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ run_status: "queued", started_at: "", finished_at: null, artifacts: [], source_checks: [], metrics: null, review: null });
    expect(existsSync(run.output_dir)).toBe(false);
  });

  it("refuses caller-supplied paths and retains the preexisting work-package routes", async () => {
    const f = await fixture(), a = await f.connect("paths"), run = runFor(a.root, a.doc); a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id, "&path=artifacts%2Fanything.txt");
    expect(response.statusCode, response.body).toBe(400);
    expect(f.app.hasRoute({ method: "POST", url: "/api/engineering/work-package/preview" })).toBe(true);
    expect(f.app.hasRoute({ method: "POST", url: "/api/engineering/work-package/commit" })).toBe(true);
  });

  it("rejects traversal, absolute, denied and private material paths without disclosing them", async () => {
    const f = await fixture(), a = await f.connect("unsafe"), run = runFor(a.root, a.doc);
    const outside = join(f.root, "private-outside.txt"); file(outside, "outside material");
    run.evidence = [evidence("traversal", "../private-outside.txt", sha("outside material")), evidence("absolute", outside, sha("outside material")), evidence("denied", "artifacts/private/key.txt", sha("denied body")), evidence("private", ".private-capabilities/private.txt", sha("private body"))];
    file(join(run.output_dir, "artifacts/private/key.txt"), "denied body"); file(join(run.output_dir, ".private-capabilities/private.txt"), "private body");
    a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().artifacts).toHaveLength(4);
    expect(response.json().artifacts.every((item: { status: string; actual_sha256: string | null }) => item.status === "unreadable" && item.actual_sha256 === null)).toBe(true);
    expect(response.body).not.toContain(outside); expect(response.body).not.toContain(f.root.replaceAll("\\", "\\\\"));
    expect(response.body).not.toContain("outside material"); expect(response.body).not.toContain("denied body");
  });

  it("refuses junctions and hard links even when their bytes match the recorded hash", async () => {
    const f = await fixture(), a = await f.connect("links"), run = runFor(a.root, a.doc);
    const outsideDir = join(f.root, "outside"), outside = join(outsideDir, "secret.txt"); file(outside, "linked private bytes");
    mkdirSync(join(run.output_dir, "artifacts"), { recursive: true });
    symlinkSync(outsideDir, join(run.output_dir, "artifacts", "linked"), process.platform === "win32" ? "junction" : "dir");
    linkSync(outside, join(run.output_dir, "artifacts", "hard.txt"));
    run.evidence = [evidence("junction", "artifacts/linked/secret.txt", sha("linked private bytes")), evidence("hardlink", "artifacts/hard.txt", sha("linked private bytes"))];
    a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ evidence_id: "junction", status: "unreadable", actual_sha256: null }), expect.objectContaining({ evidence_id: "hardlink", status: "unreadable", actual_sha256: null })]));
    expect(response.body).not.toContain("linked private bytes"); expect(response.body).not.toContain(outsideDir.replaceAll("\\", "\\\\"));
  });

  it("does not trust an output directory stored outside the selected workspace", async () => {
    const f = await fixture(), a = await f.connect("wrong-output"), run = runFor(a.root, a.doc, { output_dir: join(f.root, "outside-output") });
    run.evidence = [evidence("wrong-root", "artifacts/result.txt", sha("foreign bytes"))]; file(join(run.output_dir, "artifacts/result.txt"), "foreign bytes"); a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().artifacts[0]).toMatchObject({ status: "unreadable", actual_sha256: null });
    expect(response.body).not.toContain("foreign bytes");
  });

  it("exports only public evidence facts and redacts sensitive saved review text", async () => {
    const f = await fixture(), a = await f.connect("privacy"), run = runFor(a.root, a.doc, { actor: "codex:raw-session-never-export", reason: "raw runtime reason never export", reviewed_at: finished, review_note: "token=review-secret-value" });
    run.evidence = [evidence("public-result", "artifacts/report.txt", sha("raw artifact never export"))]; run.evidence[0].summary = "token=summary-secret-value";
    file(join(run.output_dir, "artifacts/report.txt"), "raw artifact never export");
    a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    for (const value of ["raw-session-never-export", "raw runtime reason never export", "review-secret-value", "summary-secret-value", "raw artifact never export", a.root.replaceAll("\\", "\\\\")]) expect(response.body).not.toContain(value);
    expect(response.json().review.reviewed_at).toBe(finished);
  });

  it("does not manufacture a review for a stored accepted status without review evidence", async () => {
    const f = await fixture(), a = await f.connect("no-review"), run = runFor(a.root, a.doc, { status: "accepted", reviewed_at: null, review_note: "备注不能代替验收时间" });
    a.doc.runs.push(run); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ run_status: "accepted", review: null });
    expect(response.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "review_not_recorded" })]));
  });
});

describe("stored source-check facts and observed material", () => {
  async function sourceFixture(allow = ["src/**"], checkTitle = "核对源码语法") {
    const f = await fixture(), a = await f.connect("source-checks"), root = join(a.sourceRoot, "checked-source");
    file(join(root, "src/value.js"), "export const value = 1;\n");
    const frozen = freezeEngineeringSourceScope({ root, allow, deny: [], checks: [{ id: "syntax", title: checkTitle, program: "node", args: ["-e", "require('node:fs').writeFileSync('must-not-run.txt','executed')"] }] }, [a.sourceRoot]);
    const baseline = captureEngineeringSourceBaseline(frozen), run = runFor(a.root, a.doc, { source_scope: frozen, source_baseline: baseline });
    const commandHash = sha(JSON.stringify({ program: frozen.checks[0].program, args: frozen.checks[0].args }));
    a.doc.runs.push(run);
    const proof = (status: "passed" | "failed" = "passed"): EngineeringSourceProof => ({ schema_version: 1, verification_mode: "post_execution", verified_at: finished, status, passed: status === "passed", root, contract_sha256: frozen.contract_sha256, baseline_manifest_sha256: baseline.manifest_sha256, final_manifest_sha256: baseline.manifest_sha256,
      changes: [], checks: [{ id: "syntax", title: checkTitle, program: "node", args: frozen.checks[0].args, command_sha256: commandHash, status, exit_code: status === "passed" ? 0 : 7, duration_ms: 25, output_sha256: sha("check output"), output_bytes: 12, error: status === "passed" ? null : "token=source-error-secret" }],
      preexisting_changes: [], exclusions: baseline.exclusions, exclusion_rules: baseline.exclusion_rules, source_changed_during_checks: false, error: null });
    return { f, a, root, run, baseline, proof, commandHash };
  }

  it.each([
    { delivery: "source", status: "review", missing: false },
    { delivery: "integration", status: "accepted", missing: false },
    { delivery: "files", status: "review", missing: true },
    { delivery: "files", status: "accepted", missing: true },
    { delivery: "files", status: "blocked", missing: true },
    { delivery: "files", status: "queued", missing: false },
    { delivery: "files", status: "running", missing: false },
    { delivery: "files", status: "paused", missing: false }
  ] as const)("reports missing declared files only when due: $delivery / $status", async ({ delivery, status, missing }) => {
    const { f, a, run, proof } = await sourceFixture();
    run.status = status; run.source_proof = proof();
    if (status === "accepted") { run.reviewed_at = finished; run.review_note = "已查收隔离测试源码"; }
    if (["queued", "running", "paused"].includes(status)) run.finished_at = null;
    if (delivery === "integration") {
      run.mode = "integration";
      run.source_integration_scopes = [run.source_scope!];
      run.source_integration_baselines = [run.source_baseline!];
      run.source_integration_proofs = [run.source_proof];
      delete run.source_scope; delete run.source_baseline; delete run.source_proof;
    }
    const paths = ["artifacts/agent-result.txt", "artifacts/generated.txt", "artifacts/checked.txt"];
    if (delivery === "files") {
      a.doc.nodes[0].actions = [
        { id: "submit", title: "提交文件", type: "agent_artifact", path: paths[0], content: "", criterion_id: "", capability_id: "" },
        { id: "write", title: "生成文件", type: "write_file", path: paths[1], content: "expected content", criterion_id: "", capability_id: "" }
      ];
      a.doc.nodes[0].criteria = [{ id: "file", text: "应有约定文件", kind: "file_exists", path: paths[2], expected: "" }];
      run.snapshot.node = structuredClone(a.doc.nodes[0]);
    }
    f.save(a);
    const response = await f.get(a.id, run.id), result = response.json();
    expect(response.statusCode, response.body).toBe(200);
    expect(result.artifacts).toEqual([]);
    expect(result.source_checks[0]).toMatchObject({ status: "passed", material_status: "verified" });
    const absent = result.issues.filter((issue: { code: string }) => issue.code === "artifacts_not_recorded");
    expect(absent).toEqual(missing ? paths.map(path => expect.objectContaining({ code: "artifacts_not_recorded", path })) : []);
    expect(existsSync(run.output_dir)).toBe(false);
  });

  it("preserves a historical failed exit code while separately recognizing unchanged source material", async () => {
    const { f, a, root, run, baseline, proof, commandHash } = await sourceFixture(); run.source_proof = proof("failed"); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().source_checks).toEqual([expect.objectContaining({ id: "syntax", title: "核对源码语法", status: "failed", exit_code: 7, scope_index: 0, verified_at: finished, command_sha256: commandHash, baseline_manifest_sha256: baseline.manifest_sha256, final_manifest_sha256: baseline.manifest_sha256, actual_manifest_sha256: baseline.manifest_sha256, material_status: "verified" })]);
    expect(response.json().issues.some((issue: { check_id?: string }) => issue.check_id === "syntax")).toBe(true);
    expect(existsSync(join(root, "must-not-run.txt"))).toBe(false);
    expect(response.body).not.toContain("source-error-secret"); expect(response.body).not.toContain("writeFileSync"); expect(response.body).not.toContain(root.replaceAll("\\", "\\\\"));
  });

  it("retains a recorded pass but reports source replacement as changed without rerunning its command", async () => {
    const { f, a, root, run, proof } = await sourceFixture(); run.source_proof = proof(); f.save(a);
    file(join(root, "src/value.js"), "export const value = 2;\n");
    const response = await f.get(a.id, run.id), check = response.json().source_checks[0];
    expect(response.statusCode, response.body).toBe(200);
    expect(check).toMatchObject({ status: "passed", exit_code: 0, material_status: "changed" });
    expect(check.actual_manifest_sha256).not.toBe(check.final_manifest_sha256);
    expect(response.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source_changed", path: "src/value.js" })]));
    expect(existsSync(join(root, "must-not-run.txt"))).toBe(false);
  });

  it("reports a frozen check without proof as not_run rather than inventing success", async () => {
    const { f, a, root, run } = await sourceFixture(); f.save(a);
    const before = structuredClone(a.doc);
    const result = buildEngineeringRunResult({ root: a.root, workspace_id: a.id, document: a.doc, run_id: run.id, approved_source_roots: [a.sourceRoot] });
    expect(result.source_checks[0]).toMatchObject({ id: "syntax", status: "not_run", exit_code: null, verified_at: null, final_manifest_sha256: null, material_status: "unrecorded" });
    expect(result.issues.some(issue => issue.check_id === "syntax")).toBe(true);
    expect(existsSync(join(root, "must-not-run.txt"))).toBe(false);
    expect(a.doc).toEqual(before);
  });

  it("marks a broken recorded source baseline unrecorded while preserving saved check facts", async () => {
    const { f, a, root, run, proof } = await sourceFixture(); run.source_proof = proof();
    run.source_baseline!.manifest[0].sha256 = sha("tampered baseline"); f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().source_checks[0]).toMatchObject({ status: "passed", exit_code: 0, material_status: "unrecorded", actual_manifest_sha256: null });
    expect(existsSync(join(root, "must-not-run.txt"))).toBe(false);
  });

  it("rejects a source root outside workspace authorization before filesystem inspection", async () => {
    const { f, a, run, baseline, proof } = await sourceFixture();
    // A shared lexical prefix is not authorization for this sibling directory.
    const outside = a.sourceRoot + "-unapproved";
    const { contract_sha256: _oldContract, ...frozenFields } = run.source_scope!;
    const outsideFields = { ...frozenFields, root: outside };
    const outsideScope = { ...outsideFields, contract_sha256: sha(JSON.stringify(outsideFields)) };
    run.source_scope = outsideScope;
    run.source_baseline = { ...baseline, scope: outsideScope };
    run.source_proof = { ...proof(), root: outside, contract_sha256: outsideScope.contract_sha256 };
    const lstat = vi.mocked(fs.lstatSync), readdir = vi.mocked(fs.readdirSync);
    lstat.mockClear(); readdir.mockClear();
    const result = buildEngineeringRunResult({ root: a.root, workspace_id: a.id, document: a.doc, run_id: run.id, approved_source_roots: [a.sourceRoot] });
    expect(lstat).not.toHaveBeenCalled(); expect(readdir).not.toHaveBeenCalled();
    expect(result.source_checks).toEqual([expect.objectContaining({ id: "syntax", material_status: "unreadable", actual_manifest_sha256: null })]);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source_unreadable" })]));
    expect(JSON.stringify(result)).not.toContain(outside.replaceAll("\\", "\\\\"));
    f.save(a);
    const response = await f.get(a.id, run.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().source_checks[0]).toMatchObject({ material_status: "unreadable", actual_manifest_sha256: null });
  });

  it.each(["missing", "duplicate", "extra", "wrong-id", "wrong-command", "wrong-version"] as const)("does not hide or trust a proof with %s frozen checks", async mismatch => {
    const { f, a, root, run, proof } = await sourceFixture(); run.source_proof = proof();
    const saved = run.source_proof.checks[0];
    if (mismatch === "missing") run.source_proof.checks = [];
    else if (mismatch === "duplicate") run.source_proof.checks.push(structuredClone(saved));
    else if (mismatch === "extra") run.source_proof.checks.push({ ...structuredClone(saved), id: "not-frozen" });
    else if (mismatch === "wrong-id") saved.id = "not-frozen";
    else if (mismatch === "wrong-command") saved.command_sha256 = sha("different command");
    else run.source_proof.contract_sha256 = sha("different frozen source contract");
    f.save(a);
    const response = await f.get(a.id, run.id), result = response.json();
    expect(response.statusCode, response.body).toBe(200);
    expect(result.source_checks.map((check: { id: string }) => check.id)).toEqual(["syntax"]);
    expect(result.source_checks[0].material_status).toBe("unrecorded");
    expect(result.issues.some((issue: { code: string }) => issue.code.endsWith("unrecorded"))).toBe(true);
    expect(result.source_checks[0]).toMatchObject({ status: "not_run", exit_code: null });
    expect(existsSync(join(root, "must-not-run.txt"))).toBe(false);
  });

  it.each(["D:\\private\\source\\report.md", "D:\\private source\\audit report.md"])("redacts an entire absolute path beside Chinese text, including spaces: %s", async privatePath => {
    const { f, a, run, proof } = await sourceFixture(["src/**"], "检查依据" + privatePath);
    run.source_proof = proof(); run.reviewed_at = finished;
    run.source_proof.checks[0].title = "检查依据" + privatePath;
    for (const reviewNote of ["核对依据：" + privatePath, "请看" + privatePath]) {
      run.review_note = reviewNote; f.save(a);
      const response = await f.get(a.id, run.id), result = response.json();
      expect(response.statusCode, response.body).toBe(200);
      expect(result.review.reviewed_at).toBe(finished);
      expect(result.review.review_note).not.toContain(privatePath);
      expect(result.source_checks[0].title).not.toContain(privatePath);
      expect(response.body).not.toContain("private"); expect(response.body).not.toContain("report.md"); expect(response.body).not.toContain("audit report");
    }
  });

  it("reports files outside the saved inventory as unrecorded without executing Git or a check", async () => {
    const { f, a, root, run, proof } = await sourceFixture(); run.source_proof = proof(); f.save(a);
    file(join(root, "debug.log"), "added after the saved check\n");
    const spawnSync = vi.mocked(childProcess.spawnSync), spawn = vi.mocked(childProcess.spawn);
    spawnSync.mockClear(); spawn.mockClear();
    const response = await f.get(a.id, run.id), result = response.json();
    expect(response.statusCode, response.body).toBe(200);
    expect(result.source_checks[0]).toMatchObject({ status: "passed", exit_code: 0, material_status: "unrecorded" });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source_inventory_unrecorded", path: "debug.log" })]));
    expect(result.issues.some((issue: { code: string }) => issue.code === "source_changed")).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, "must-not-run.txt"))).toBe(false);
  });

  it("uses final proof exclusions when a formerly excluded file legitimately enters its final manifest", async () => {
    const { f, a, root, run, baseline, proof } = await sourceFixture(["src/**", "temp/**"]);
    // The saved baseline excluded temp/. Its final proof deliberately records the admitted addition.
    baseline.exclusions.push({ path: "temp/", reason: "git_ignored" });
    const contents = "export const admitted = true;\n", path = "temp/a.ts";
    file(join(root, path), contents);
    run.source_proof = proof(); run.source_proof.exclusions = [];
    run.source_proof.changes = [{ path, kind: "added", before_sha256: null, after_sha256: sha(contents), allowed: true, reason: "allowed" }];
    const finalManifest = [...baseline.manifest, { path, sha256: sha(contents), bytes: Buffer.byteLength(contents) }].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    run.source_proof.final_manifest_sha256 = sha(JSON.stringify(finalManifest)); f.save(a);
    const response = await f.get(a.id, run.id), result = response.json();
    expect(response.statusCode, response.body).toBe(200);
    expect(result.source_checks[0]).toMatchObject({ status: "passed", material_status: "verified", final_manifest_sha256: run.source_proof.final_manifest_sha256, actual_manifest_sha256: run.source_proof.final_manifest_sha256 });
    expect(result.issues.some((issue: { code: string }) => ["source_missing", "source_changed", "source_unrecorded", "source_inventory_unrecorded"].includes(issue.code))).toBe(false);
    expect(existsSync(join(root, "must-not-run.txt"))).toBe(false);
  });
});
