import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { findRepoRoot, loadProject } from "@epm/spec-io";
import { CodexAppServerGateway } from "./jsonrpc.ts";
import { GoalOrchestrator } from "./orchestrator.ts";
import { createProjectCodexTransport } from "./codex-app-server-runtime.ts";
import { validateCodexSmoke } from "./codex-smoke-validation.ts";
import { CODEX_SMOKE_EXPECTED_README, createCodexSmokeFixture } from "./codex-smoke-fixture.ts";
import { createManagedCodexSmokeRun } from "./codex-smoke-paths.ts";
import { codexSmokeId, saveCodexSmokeReceipt } from "./codex-smoke-receipt.ts";

const sourceRoot = findRepoRoot();
const localEnv = join(sourceRoot, ".env.local");
const localConfig = existsSync(localEnv) ? parseEnv(readFileSync(localEnv, "utf8")) : {};
const apiKey = process.env.OPENAI_API_KEY?.trim() || localConfig.OPENAI_API_KEY?.trim();
const enabled = process.env.EPM_ENABLE_CODEX ?? localConfig.EPM_ENABLE_CODEX;
if (enabled !== "1") throw new Error("codex_enable_required: 请先显式设置 EPM_ENABLE_CODEX=1。");
const codexEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
  EPM_CODEX_MODEL: process.env.EPM_CODEX_MODEL ?? localConfig.EPM_CODEX_MODEL
};

const smokeId = codexSmokeId(process.argv[2], randomUUID());
const managedRun = createManagedCodexSmokeRun(sourceRoot, smokeId.slice("codex-smoke-".length));
const repo = managedRun.repo;
const startedAt = new Date().toISOString();
let passed = false;
let orchestrator: GoalOrchestrator | undefined;
let gateway: CodexAppServerGateway | undefined;
let success: Record<string, unknown> | undefined;
let failure: unknown;
let selectedModel: string | null = null;
let startSha: string | undefined, finalMain: string | undefined, checkpoint: string | null = null;
let markerPresent = false, changeVerified = false;

try {
  const fixture = createCodexSmokeFixture(repo, { allowedParent: managedRun.runRoot, exactName: "repo" });
  const { goal, change, mainBranch } = fixture;
  startSha = fixture.startSha;

  const transport = createProjectCodexTransport(repo, codexEnvironment, sourceRoot);
  gateway = new CodexAppServerGateway(transport, repo, false, () => transport.selectedModel());
  const readiness = await transport.verify();
  selectedModel = transport.selectedModel() ?? null;
  if (readiness.status !== "ready") throw new Error("codex_smoke_gateway_not_ready");
  gateway.setReady(true);
  orchestrator = new GoalOrchestrator(repo, gateway);
  const dispatched = orchestrator.dispatch(change.id);
  if (!dispatched.active.includes(goal.id)) throw new Error("smoke_goal_not_dispatched");
  const [run] = await Promise.all([...orchestrator.active.values()]);
  const finalModel = loadProject(repo);
  const finalChange = finalModel.changes.find((item) => item.id === change.id);
  const finalChangeStatus = finalChange?.status;
  finalMain = git(repo, ["rev-parse", mainBranch]);
  markerPresent = `${git(repo, ["show", `${mainBranch}:README.md`]).replace(/\r\n/g, "\n")}\n` === CODEX_SMOKE_EXPECTED_README;
  changeVerified = finalChangeStatus === "verified";
  checkpoint = validateCodexSmoke({ run, finalChangeStatus, startSha, finalMain, markerPresent }, () => gitRef(repo, `refs/heads/codex/checkpoint/${change.id}`));
  passed = true;
  success = { ok: true, gateway: gateway.kind, run: run.status, changeSet: finalChangeStatus, checkpoint: Boolean(checkpoint), mainMerged: true };
} catch (error) {
  failure = error;
} finally {
  orchestrator?.close();
  await gateway?.close();
}
// Keep the tiny repo, reviews and Git history on both outcomes. A successful
// execution is only advertised after its immutable receipt has reached disk.
try {
  let model: ReturnType<typeof loadProject> | undefined;
  try { model = loadProject(repo); }
  catch (error) { if (passed) throw error; }
  const receipt = saveCodexSmokeReceipt(managedRun, {
    smokeId, status: passed ? "passed" : "failed", model: selectedModel,
    startedAt, finishedAt: new Date().toISOString(), runs: model?.runs ?? [], reviews: model?.reviews ?? [],
    startSha, finalMain, checkpoint, markerPresent, changeVerified
  });
  console.log(JSON.stringify({ ...(success ?? { ok: false }), receipt }));
} catch (error) {
  if (passed) throw error;
  console.error("烟测未完成，结构化记录无法生成；原始临时仓库现场保留。");
}
if (failure) throw failure;

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function gitRef(cwd: string, ref: string) {
  try {
    execFileSync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", ref], { encoding: "utf8", windowsHide: true });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
  return git(cwd, ["rev-parse", ref]);
}
