import { describe, expect, it } from "vitest";
import { deriveEngineeringView, engineeringLineageVersions, type EngineeringRun, type EngineeringView } from "@epm/domain";
import type { EngineeringFeedback } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { projectFeedbackArtifacts } from "./feedback-comparison.ts";
import { projectFeedbackExecution } from "./feedback-execution.ts";
import { selectGraphAttention } from "./attention-selectors.ts";

const adoptedAt = "2026-09-05T00:00:00Z", startedAt = "2026-09-05T00:01:00Z";
function fixture(mode: EngineeringRun["mode"] = "external", status: EngineeringRun["status"] = "running") {
  const doc = inspectorDocument();
  doc.nodes[1].actions = [{ id: "make", type: "agent_artifact", title: "补齐结果核对说明", path: "output/result.md", content: "", criterion_id: "step-manual", capability_id: "" }];
  const run = inspectorRun(doc, "step", status, mode);
  run.actor = mode === "external" ? "codex:fixture-session" : "本机执行器";
  run.started_at = startedAt; run.current_action = "make";
  doc.runs.push(run);
  const item: EngineeringFeedback = { id: "feedback", target: { kind: "node", node_id: "step" }, kind: "defect", note: "请补齐核对说明", status: "working",
    base_document_revision: 1, base_node_revision: 1, base_contract_key: "prior", base_lineage: [], base_run_id: null, target_snapshot: "{}",
    adopted_lineage: engineeringLineageVersions(doc, "step"), resolution_kind: "delivery", created_at: adoptedAt, updated_at: startedAt,
    history: [{ at: adoptedAt, action: "adopt", actor: "监督者", note: "采用本条意见" },
      { at: startedAt, action: "working", actor: "监督者", note: "已关联开工", run_id: run.id }] };
  doc.feedbacks = [item];
  const view = (): EngineeringView => ({ ...deriveEngineeringView(doc), observation: { captured_at: startedAt, source: "local-engineering-service",
    runs: Object.fromEntries(doc.runs.map(record => [record.id, { state: record.mode === "external" ? "current" : "local", last_observed_at: startedAt, message: "隔离观察记录" }])) } });
  return { doc, item, run, view };
}

describe("feedback execution belongs to one explicit current feedback round", () => {
  it("stops advertising work on the graph when its live connection is unavailable", () => {
    const { item, view } = fixture();
    const displayed = view(), before = JSON.stringify(displayed);
    const attention = (offline: boolean) => selectGraphAttention(displayed, { observationUnavailable: offline }).items.find(record => record.feedbackId === item.id);
    expect(attention(false)?.label).toContain("正在处理");
    expect(attention(true)?.label).toContain("活动待确认");
    expect(JSON.stringify(displayed)).toBe(before);
  });

  it("shows the verified recorded claimant and frozen action, without promoting a working run to submitted files", () => {
    const { doc, item, run, view } = fixture();
    const before = JSON.stringify(doc);
    expect(projectFeedbackExecution(view(), item, { sessionLabels: { [run.actor]: "已有会话标签" } })).toMatchObject({
      state: "running", label: "正在处理", sourceLabel: "外部运行记录", actorIdentity: run.actor, actorLabel: "已有会话标签",
      actionTitle: "补齐结果核对说明", runId: run.id, historical: false, unknown: false
    });
    expect(projectFeedbackArtifacts(view(), item)).toMatchObject({ state: "none", artifacts: [] });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it.each(["blocked", "paused", "rejected"] as const)("shows exact %s reason while preserving the stored working feedback", status => {
    const { item, run, view } = fixture("external", status);
    run.reason = "本条关联的检查未通过";
    const projected = projectFeedbackExecution(view(), item);
    expect(projected).toMatchObject({ state: "stopped", reason: run.reason, runId: run.id, actorIdentity: run.actor });
    expect(projected.label).not.toContain("正在"); expect(item.status).toBe("working");
  });

  it("uses a submitted ID first, and never replaces missing or foreign links with a latest or working run", () => {
    const { doc, item, run, view } = fixture();
    item.submitted_run_id = "missing";
    item.history.push({ at: startedAt, action: "submit", actor: "监督者", note: "关联提交", run_id: "missing" });
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "unknown", unknown: true });
    expect(projectFeedbackExecution(view(), item).runId).toBeUndefined();
    doc.nodes.push(inspectorNode("other", "root")); const other = inspectorRun(doc, "other", "accepted"); doc.runs.push(other);
    item.submitted_run_id = other.id;
    item.history.push({ at: startedAt, action: "submit", actor: "监督者", note: "关联提交", run_id: other.id });
    expect(projectFeedbackExecution(view(), item).runId).toBeUndefined();
    delete item.submitted_run_id; item.history = item.history.filter(entry => entry.action !== "working");
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "unknown" });
    expect(projectFeedbackExecution(view(), item).runId).toBeUndefined();
    expect(run.status).toBe("running");
  });

  it("invalidates old working and even leftover submitted IDs after reopen, and permits only a newly recorded round", () => {
    const { doc, item, run, view } = fixture();
    item.submitted_run_id = run.id;
    item.history.push({ at: startedAt, action: "submit", actor: "监督者", note: "旧轮提交", run_id: run.id });
    item.history.push({ at: "2026-09-05T00:02:00Z", action: "reopen", actor: "监督者", note: "重新核对" });
    item.status = "open";
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "unlinked" });
    expect(projectFeedbackExecution(view(), item).runId).toBeUndefined();
    item.status = "working";
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "unknown" });
    const next = inspectorRun(doc, "step", "running", "external"); next.actor = run.actor; next.started_at = "2026-09-05T00:04:00Z"; doc.runs.push(next);
    item.history.push({ at: "2026-09-05T00:03:00Z", action: "adopt", actor: "监督者", note: "采用新一轮" },
      { at: next.started_at, action: "working", actor: "监督者", note: "新一轮开工", run_id: next.id });
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "running", runId: next.id });
    expect(projectFeedbackExecution(view(), item).runId).not.toBe(item.submitted_run_id);
  });

  it("does not carry an earlier submitted ID across a later adoption or invent an adoption for old records", () => {
    const { item, run, view } = fixture();
    item.submitted_run_id = run.id;
    item.history.push({ at: startedAt, action: "submit", actor: "监督者", note: "原先提交", run_id: run.id },
      { at: "2026-09-05T00:02:00Z", action: "adopt", actor: "监督者", note: "再次采用后的依据" });
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "unknown" });
    expect(projectFeedbackExecution(view(), item).runId).toBeUndefined();
    item.history = [{ at: startedAt, action: "submit", actor: "监督者", note: "旧记录缺少采用依据", run_id: run.id }];
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "unknown", label: "处理依据待核对" });
  });

  it("follows a later explicit working event after review while keeping the old submitted result separate", () => {
    const { doc, item, run, view } = fixture("external", "review");
    item.submitted_run_id = run.id;
    item.history.push({ at: startedAt, action: "submit", actor: "监督者", note: "此前提交", run_id: run.id });
    const next = inspectorRun(doc, "step", "running", "external");
    next.actor = run.actor; next.started_at = "2026-09-05T00:03:00Z"; doc.runs.push(next);
    item.history.push({ at: next.started_at, action: "working", actor: "监督者", note: "继续执行下一次修正", run_id: next.id });
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "running", runId: next.id });
    expect(projectFeedbackArtifacts(view(), item)).toMatchObject({ state: "historical", run: { id: run.id } });
    expect(item.submitted_run_id).toBe(run.id);
  });

  it.each(["contract", "lineage", "superseded", "stale", "base", "before-adopt", "archived"] as const)("keeps %s execution historical", change => {
    const { doc, item, run, view } = fixture();
    if (change === "contract") run.snapshot.contract_key = "old contract";
    if (change === "lineage") item.adopted_lineage![1].revision++;
    if (change === "superseded") doc.runs.push(inspectorRun(doc, "step", "review"));
    if (change === "stale") run.status = "stale";
    if (change === "base") item.base_run_id = run.id;
    if (change === "before-adopt") run.started_at = "2026-09-04T23:59:59Z";
    if (change === "archived") doc.nodes[1].status = "archived";
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "historical", historical: true, runId: run.id });
  });

  it.each(["actor", "owner", "claimant", "contract", "timestamp", "missing"] as const)("does not name a claimant from a mismatched %s", change => {
    const { item, run, view } = fixture();
    if (change === "actor") run.actor = "codex:other";
    if (change === "owner") run.handoff!.owner = "codex:other";
    if (change === "claimant") run.handoff!.claimed_by = "codex:other";
    if (change === "contract") run.handoff!.contract_key = "different";
    if (change === "timestamp") run.handoff!.claimed_at = "invalid";
    if (change === "missing") delete run.handoff;
    const projected = projectFeedbackExecution(view(), item);
    expect(projected).toMatchObject({ state: "unknown", label: "领取记录待核对" });
    expect(projected.actorIdentity).toBeUndefined(); expect(projected.actorLabel).toBeUndefined();
  });

  it.each(["unavailable", "missing", "missing-run", "stale", "unobserved", "local", "timestamp"] as const)("never calls an external run active with %s observation", change => {
    const { item, run, view } = fixture(); const snapshot = view();
    if (change === "missing") delete snapshot.observation;
    if (change === "missing-run") delete snapshot.observation!.runs[run.id];
    if (["stale", "unobserved", "local"].includes(change)) snapshot.observation!.runs[run.id].state = change as "stale" | "unobserved" | "local";
    if (change === "timestamp") snapshot.observation!.runs[run.id].last_observed_at = null;
    expect(projectFeedbackExecution(snapshot, item, { observationUnavailable: change === "unavailable" })).toMatchObject({
      state: "unknown", label: "活动待确认", actorIdentity: run.actor, unknown: true
    });
  });

  it.each(["controlled", "integration"] as const)("identifies %s as a local record and needs a local observation to say active", mode => {
    const { item, view } = fixture(mode); const snapshot = view();
    expect(projectFeedbackExecution(snapshot, item)).toMatchObject({ state: "running", label: "本机正在执行", actorLabel: "本机执行器" });
    expect(projectFeedbackExecution(snapshot, item).sourceLabel).not.toMatch(/Agent|Codex/);
    delete snapshot.observation;
    expect(projectFeedbackExecution(snapshot, item).state).toBe("unknown");
  });

  it("distinguishes execution completion from the feedback's explicit submission", () => {
    const { item, run, view } = fixture("external", "accepted");
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "waiting", label: "等待关联提交" });
    item.submitted_run_id = run.id; item.status = "resolved";
    item.history.push({ at: startedAt, action: "submit", actor: "监督者", note: "关联本轮提交", run_id: run.id });
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "submitted", label: "已关联提交", runId: run.id });
    expect(projectFeedbackExecution(view(), item).label).not.toMatch(/验收|完成/);
  });

  it("does not invent a current frozen action or use the feedback recorder as executor", () => {
    const { item, run, view } = fixture();
    run.current_action = "unknown-action";
    expect(projectFeedbackExecution(view(), item).actionTitle).toBeUndefined();
    expect(projectFeedbackExecution(view(), item).actorIdentity).not.toBe(item.history.at(-1)!.actor);
    run.current_action = "source-verification";
    expect(projectFeedbackExecution(view(), item).actionTitle).toBe("核对源工程变化并执行实际检查");
  });

  it("keeps unknown session names distinguishable using the existing compact identity label", () => {
    const { item, run, view } = fixture();
    run.actor = "codex:12345678-1234-1234-1234-123456789abc";
    run.handoff!.owner = run.actor; run.handoff!.claimed_by = run.actor;
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ actorIdentity: run.actor, actorLabel: "Codex · 12345678…9abc" });
  });

  it("separates an unclaimed handoff from a claimed run waiting for execution conditions", () => {
    const { item, run, view } = fixture("external", "queued");
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "waiting", label: "等待实际领取" });
    expect(projectFeedbackExecution(view(), item).actorIdentity).toBeUndefined();
    run.handoff!.state = "claimed"; run.handoff!.claimed_by = run.actor; run.handoff!.claimed_at = startedAt;
    run.reason = "等待共享执行条件";
    expect(projectFeedbackExecution(view(), item)).toMatchObject({ state: "waiting", label: "已领取，等待执行条件", actorIdentity: run.actor, reason: run.reason });
  });
});
