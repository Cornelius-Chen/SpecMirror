import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, RuntimeStore } from "@epm/spec-io";
import type { AgentRun } from "@epm/domain";
import { MockAgentGateway } from "./gateway.ts";
import { GoalOrchestrator } from "./orchestrator.ts";
import { GitController } from "./git.ts";
import { EventBus } from "./events.ts";
import { registerCodexReadinessRoutes } from "./app.ts";
import { CodexReadinessManager } from "./codex-readiness.ts";
import { createCodexSmokeFixture } from "./codex-smoke-fixture.ts";
import { createManagedCodexSmokeRun } from "./codex-smoke-paths.ts";
import { readCodexSmokeReceipt, saveCodexSmokeReceipt } from "./codex-smoke-receipt.ts";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "epm-smoke-receipt-")); roots.push(path); return path; }
afterEach(() => {
  for (const path of roots.splice(0)) {
    const absolute = realpathSync(path);
    if (dirname(absolute) !== realpathSync(tmpdir()) || !basename(absolute).startsWith("epm-smoke-receipt-")) throw new Error("unsafe_test_cleanup");
    rmSync(absolute, { recursive: true, force: false });
  }
});

describe("retained Codex smoke evidence (isolated test gateway, not live completion)", () => {
  it("keeps Git and reviews, verifies file hashes, and serves the same receipt after SQLite reopen", async () => {
    const source = root(), managed = createManagedCodexSmokeRun(source);
    const fixture = createCodexSmokeFixture(managed.repo, { allowedParent: managed.runRoot, exactName: "repo" });
    class FixtureGateway extends MockAgentGateway {
      override readonly kind = "codex-app-server" as const;
      override async implement(...args: Parameters<MockAgentGateway["implement"]>) {
        appendFileSync(join(args[2]!.cwd, "README.md"), "SMOKE_OK\n");
        return { changedFiles: ["README.md"], evidence: ["isolated test fixture only"] };
      }
    }
    const orchestrator = new GoalOrchestrator(managed.repo, new FixtureGateway());
    try {
      orchestrator.dispatch(fixture.change.id);
      await Promise.all([...orchestrator.active.values()]);
    } finally { orchestrator.close(); }
    const model = loadProject(managed.repo), git = new GitController(managed.repo);
    const input = {
      status: "passed" as const, startedAt: "2026-09-11T00:00:00.000Z", finishedAt: "2026-09-11T00:00:12.000Z",
      runs: model.runs, reviews: model.reviews, startSha: fixture.startSha, finalMain: git.head(),
      checkpoint: git.head(`codex/checkpoint/${fixture.change.id}`), markerPresent: true,
      changeVerified: model.changes[0].status === "verified"
    };
    let runtime = new RuntimeStore(source);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null });
    const options = { root: source, gatewaySelected: true, runtimeReady: true, credentialStatus: "configured" as const, env: { EPM_ENABLE_CODEX: "1" } };
    const manager = new CodexReadinessManager({ ...options, runtime, events: new EventBus(runtime), spawnProcess: (() => child) as unknown as typeof spawn });
    const started = manager.start();
    const reference = saveCodexSmokeReceipt(managed, { ...input, smokeId: started.id! });
    child.stdout.write(`${JSON.stringify({ ok: true, gateway: "codex-app-server", run: "verified", changeSet: "verified", checkpoint: true, mainMerged: true, receipt: reference })}\n`);
    child.exitCode = 0; child.emit("close", 0);
    expect(manager.readiness().smoke).toMatchObject({ status: "passed", receipt: reference, evidence_status: "verified" });
    const receipt = manager.receipt();
    expect(receipt).toMatchObject({ scope: "isolated-single-goal", duration_ms: 12000, token_usage: null });
    expect(receipt.reviews.some(item => item.reviewer === "integrator" && item.status === "approved")).toBe(true);
    expect(receipt.files.some(item => item.path.startsWith(".project/reviews/"))).toBe(true);
    expect(existsSync(join(managed.repo, ".git"))).toBe(true);
    expect(() => saveCodexSmokeReceipt(managed, { ...input, smokeId: started.id! })).toThrow();
    runtime.close();
    runtime = new RuntimeStore(source);
    const restarted = new CodexReadinessManager({ ...options, runtime, events: new EventBus(runtime) });
    const app = Fastify();
    registerCodexReadinessRoutes(app, { selection: { gateway: new MockAgentGateway(), health: {} }, requestedGateway: "mock", readonlyLegacy: true, codexReadiness: restarted });
    try {
      const response = await app.inject({ method: "GET", url: "/api/codex/smoke/receipt" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(receipt);
      expect(response.headers["content-disposition"]).toContain("attachment");
      expect(() => readCodexSmokeReceipt(source, "codex-smoke-00000000-0000-4000-8000-000000000000", reference)).toThrow("identity_mismatch");
      expect(() => readCodexSmokeReceipt(source, started.id!, { ...reference, ref: "../../.env.local" })).toThrow("reference_invalid");
      appendFileSync(join(managed.repo, "README.md"), "tampered");
      expect(() => restarted.receipt()).toThrow("evidence_changed");
      expect(restarted.readiness().smoke).toMatchObject({ status: "passed", evidence_status: "invalid" });
      expect((await app.inject({ method: "GET", url: "/api/codex/smoke/receipt" })).statusCode).toBe(404);
    } finally { await app.close(); runtime.close(); }
  }, 20_000);

  it("records failure without turning missing checks or unavailable token usage into success", () => {
    const source = root(), managed = createManagedCodexSmokeRun(source);
    createCodexSmokeFixture(managed.repo, { allowedParent: managed.runRoot, exactName: "repo" });
    const input = { smokeId: `codex-smoke-${managed.token}`, startedAt: "2026-09-11T00:00:00.000Z", finishedAt: "2026-09-11T00:00:01.000Z", runs: [], reviews: [] };
    expect(() => saveCodexSmokeReceipt(managed, { ...input, status: "passed" })).toThrow("success_not_verified");
    const reference = saveCodexSmokeReceipt(managed, { ...input, status: "failed" });
    expect(readCodexSmokeReceipt(source, input.smokeId, reference)).toMatchObject({ status: "failed", checks: { run_verified: false }, token_usage: null });
    const path = resolve(source, reference.ref);
    writeFileSync(path, readFileSync(path, "utf8").replace('"failed"', '"passed"'));
    expect(() => readCodexSmokeReceipt(source, input.smokeId, reference)).toThrow("hash_mismatch");
  });

  it("serves no fabricated receipt for an older passed summary", async () => {
    const source = root(), runtime = new RuntimeStore(source);
    runtime.setState("codex_smoke_state", JSON.stringify({ id: "codex-smoke-00000000-0000-4000-8000-000000000000", status: "passed", started_at: "2026-09-11T00:00:00.000Z", finished_at: "2026-09-11T00:00:01.000Z", message: "legacy" }));
    const manager = new CodexReadinessManager({ root: source, runtime, events: new EventBus(runtime), gatewaySelected: false, runtimeReady: false, env: {} });
    try {
      expect(manager.readiness().smoke).toMatchObject({ status: "passed", evidence_status: "unavailable" });
      expect(() => manager.receipt()).toThrow("unavailable");
    } finally { runtime.close(); }
  });

  it("retains a minimal failed receipt even before project initialization or after malformed YAML", () => {
    const source = root(), token = "00000000-0000-4000-8000-000000000001";
    const managed = createManagedCodexSmokeRun(source, token);
    expect(managed.runRoot.endsWith(`run-${token}`)).toBe(true);
    expect(() => createManagedCodexSmokeRun(source, token)).toThrow();
    const input = { smokeId: `codex-smoke-${token}`, status: "failed" as const, startedAt: "2026-09-11T00:00:00.000Z", finishedAt: "2026-09-11T00:00:01.000Z", runs: [], reviews: [] };
    const reference = saveCodexSmokeReceipt(managed, input);
    expect(readCodexSmokeReceipt(source, input.smokeId, reference)).toMatchObject({ status: "failed", files: [] });
    const other = createManagedCodexSmokeRun(source);
    mkdirSync(join(other.repo, ".project"));
    writeFileSync(join(other.repo, ".project/project.yaml"), "invalid: [yaml");
    const failedReference = saveCodexSmokeReceipt(other, { ...input, smokeId: `codex-smoke-${other.token}` });
    expect(readCodexSmokeReceipt(source, `codex-smoke-${other.token}`, failedReference).files).toEqual([expect.objectContaining({ path: ".project/project.yaml" })]);
    expect(existsSync(join(managed.repo, ".project/smoke-receipt.json"))).toBe(true);
  });

  it("attributes numeric usage to verified isolated sessions and does not add reasoning twice", () => {
    const source = root(), managed = createManagedCodexSmokeRun(source);
    const session = "01a092f4-0e32-75f3-a315-c202b8bede6c";
    const directory = join(managed.repo, ".project/.runtime/codex-home/sessions/2026/09/12");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `rollout-2026-09-12T00-00-00-${session}.jsonl`), [
      { type: "session_meta", payload: { id: session } },
      { type: "event_msg", timestamp: "2026-09-12T00:00:02.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 60 } } } }
    ].map(item => JSON.stringify(item)).join("\n") + "\n");
    const worker: AgentRun = { schema_version: 1, id: "run-fixture", goal_id: "goal-fixture", gateway: "codex-app-server", status: "blocked", thread_id: session, attempt: 1, started_at: "2026-09-12T00:00:00.000Z", events: [], capability_contract_ids: [], agent_evidence: [], agent_checks: [] };
    const id = `codex-smoke-${managed.token}`;
    const reference = saveCodexSmokeReceipt(managed, { smokeId: id, status: "failed", startedAt: worker.started_at, finishedAt: "2026-09-12T00:00:03.000Z", runs: [worker], reviews: [] });
    const receipt = readCodexSmokeReceipt(source, id, reference);
    expect(receipt).toMatchObject({ token_usage_note: "isolated_rollouts_complete", token_usage: { input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 60 } });
    expect(receipt.token_sessions).toHaveLength(1);
    expect(receipt.files.some(file => file.path.endsWith(`${session}.jsonl`))).toBe(true);
  });
});
