#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { lintGoal, parsePlanCandidates, type ExternalAgentReceipt } from "@epm/domain";
import { allGraphEntities, captureIdea, findRepoRoot, impactReport, loadProject, projectMap, readIndexEntityIds, readYaml, rebuildIndex, RuntimeStore, validateProject, writeChangeProposal } from "@epm/spec-io";
import { GitController } from "./git.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { selectGateway } from "./app.ts";
import { EventBus } from "./events.ts";
import { attachExternalSupervisionOutput } from "./supervision.ts";

const root = findRepoRoot();
const localEnv = join(root, ".env.local");
if (existsSync(localEnv)) loadEnvFile(localEnv);
const cliGateway = () => selectGateway(root, process.env.EPM_AGENT_GATEWAY === "codex-app-server" ? "codex-app-server" : "mock").gateway;
const program = new Command().name("epm").description("版本化规格图与 Goal 编排器");
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

program.command("capture").argument("<text>").description("零摩擦捕获想法").action((text) => output(captureIdea(root, text)));
program.command("attach-output").argument("<detail-id>").argument("<receipt-file>").description("把外部 Codex/Agent 的逐项实现回执回挂到设计条目，不冒充正式 Goal 或 Reviewer").action((detailId: string, receiptFile: string) => {
  const receipt = /\.ya?ml$/i.test(receiptFile) ? readYaml(receiptFile) : JSON.parse(readFileSync(receiptFile, "utf8")) as unknown;
  const runtime = new RuntimeStore(root);
  try {
    const attached = attachExternalSupervisionOutput(root, new EventBus(runtime), detailId, receipt as ExternalAgentReceipt);
    output({ run: attached.run, progress: attached.progress, notice: "已回挂为外部 Agent 证据；仍需人工验收，且不计正式 Goal、Reviewer 或基线完成。" });
  }
  finally { runtime.close(); }
});
program.command("plan-import").argument("[file]").option("--text <text>").description("只读解析 Plan 为候选实体，不建立正式关系").action((file: string | undefined, options: { text?: string }) => {
  const source = options.text ?? (file ? readFileSync(file, "utf8") : undefined);
  if (!source) throw new Error("plan-import requires a file or --text");
  output({ candidates: parsePlanCandidates(source), notice: "候选必须经人工评审后才能写入 YAML 或 trace.yaml。" });
});
program.command("focus").description("显示由证据重新计算的下一最佳行动").action(() => output(projectMap(loadProject(root)).nextBestAction));
program.command("review").description("检查 YAML、图一致性、Goal 合约与 Change Set DAG").action(async () => {
  const model = loadProject(root);
  const projectValidation = validateProject(root);
  const reviewFindings = model.reviews.flatMap((review) => {
    const findings: string[] = [];
    const change = model.changes.find((item) => item.id === review.change_set_id);
    if (!change) findings.push("missing_change_set");
    else if (review.start_sha !== change.start_sha) findings.push("review_start_sha_mismatch");
    for (const runId of review.run_ids) if (!model.runs.some((run) => run.id === runId)) findings.push(`missing_run:${runId}`);
    if (change && review.status === "approved" && change.status !== "verified" && change.start_sha !== "UNBORN") {
      try { new GitController(root).assertMainUnchanged(change.start_sha, model.project.repository.main_branch); }
      catch { findings.push("approved_review_is_stale"); }
    }
    return findings.map((finding) => ({ reviewId: review.id, finding }));
  });
  const goalFindings = model.goals.flatMap((goal) => lintGoal(goal).map((finding) => ({ goalId: goal.id, ...finding })));
  const gateway = cliGateway(); const checker = createOrchestrator(gateway, root, false);
  try {
    const changeSetFindings = model.changes.flatMap((change) => checker.compile(change.id).findings.map((finding) => ({ changeSetId: change.id, ...finding })));
    output({ ...projectValidation, valid: projectValidation.valid && goalFindings.every((finding) => finding.severity !== "error") && changeSetFindings.every((finding) => finding.severity !== "error") && reviewFindings.length === 0, goalFindings, changeSetFindings, reviewFindings });
  } finally { await gateway.close?.(); }
});
program.command("impact").argument("<id>").description("传播变更影响并标记受保护基线风险").action((id) => output(impactReport(loadProject(root), id)));
program.command("compile").argument("<change-set>").description("只读编译 Change Set").action(async (id) => {
  const gateway = cliGateway(); const orchestrator = createOrchestrator(gateway, root, false);
  try { output(orchestrator.compile(id)); } finally { await gateway.close?.(); }
});
program.command("dispatch").argument("<change-set>").description("按 Goal Gateway 合同受控派发 Change Set").action(async (id) => {
  const gateway = cliGateway(); const orchestrator = createOrchestrator(gateway, root);
  try { const dispatch = orchestrator.dispatch(id); const runs = await Promise.all([...orchestrator.active.values()]); output({ dispatch, runs }); }
  finally { orchestrator.close(); await gateway.close?.(); }
});
program.command("status").description("显示基线、前沿与 Agent 状态").action(async () => {
  const model = loadProject(root); const gateway = cliGateway(); const orchestrator = createOrchestrator(gateway, root);
  try { output({ ...projectMap(model).metrics, ...orchestrator.status() }); }
  finally { orchestrator.close(); await gateway.close?.(); }
});
program.command("stop").argument("<run-id>").description("停止并保留可恢复运行").action(async (id) => { const gateway = cliGateway(); const orchestrator = createOrchestrator(gateway, root); try { output(await orchestrator.stop(id)); } finally { orchestrator.close(); await gateway.close?.(); } });
program.command("resume").argument("<run-id>").description("从保存的 thread 与 attempt 恢复运行").action(async (id) => {
  const gateway = cliGateway(); const orchestrator = createOrchestrator(gateway, root);
  try { const resumed = orchestrator.resume(id); const runs = await Promise.all([...orchestrator.active.values()]); output({ resumed, runs }); }
  finally { orchestrator.close(); await gateway.close?.(); }
});
program.command("propose").argument("<goal-id>").argument("<title>").requiredOption("-g, --glob <glob...>").description("记录越界需求为 ChangeProposal").action((goalId, title, options: { glob: string[] }) => {
  const model = loadProject(root); if (!model.goals.some((goal) => goal.id === goalId)) throw new Error(`Unknown goal: ${goalId}`);
  const proposal = { schema_version: 1, id: `proposal-${randomUUID()}`, goal_id: goalId, title, reason: "当前 Goal 写域之外的新需求", requested_globs: options.glob, status: "proposed" as const, created_at: new Date().toISOString() };
  writeChangeProposal(root, proposal); output(proposal);
});
program.command("rebuild-index").description("从 YAML 重建 SQLite 索引").action(() => output(rebuildIndex(root)));
program.command("reconcile").description("重建索引、清理陈旧锁并复核状态").action(() => {
  const model = loadProject(root); const yamlIds = new Set([model.project.id, ...allGraphEntities(model).map((entity) => entity.id)]); const indexedIds = new Set(readIndexEntityIds(root));
  const sqliteOnlyOrphans = [...indexedIds].filter((id) => !yamlIds.has(id)); const yamlMissingFromIndex = [...yamlIds].filter((id) => !indexedIds.has(id));
  const index = rebuildIndex(root); const runtime = new RuntimeStore(root);
  const activeOwners = new Set(model.runs.filter((run) => ["planning", "implementing", "reviewing", "integrating"].includes(run.status)).map((run) => run.id));
  const staleLocks = runtime.releaseStaleLocks(activeOwners); runtime.close();
  output({ index, validation: validateProject(root), beforeRebuild: { sqliteOnlyOrphans, yamlMissingFromIndex }, staleLocksReleased: staleLocks, metrics: projectMap(model).metrics });
});
program.command("clear-halt").description("在外部限制解除后显式恢复新 Goal 派发").action(() => {
  const runtime = new RuntimeStore(root); const previous = runtime.getState("halted_reason") ?? null; runtime.clearState("halted_reason"); runtime.clearState("infrastructure_failure_count"); runtime.close(); output({ cleared: true, previous });
});
await program.parseAsync();
