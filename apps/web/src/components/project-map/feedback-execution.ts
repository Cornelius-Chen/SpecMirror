import { currentEngineeringRun, engineeringContractKey, engineeringLineageVersions, type EngineeringRun, type EngineeringView } from "@epm/domain";
import type { EngineeringFeedback } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { runStatusLabel } from "../engineering/shared.ts";
import { runPlanSessionLabel } from "../run-plan-presentation.ts";

export type FeedbackExecutionState = "unlinked" | "running" | "waiting" | "stopped" | "submitted" | "historical" | "unknown";
export interface FeedbackExecution {
  state: FeedbackExecutionState;
  label: string;
  detail: string;
  sourceLabel: string;
  actorLabel?: string;
  actorIdentity?: string;
  actionTitle?: string;
  reason?: string;
  runId?: string;
  historical: boolean;
  unknown: boolean;
}
export interface FeedbackExecutionOptions {
  observationUnavailable?: boolean;
  /** Existing observed session labels, keyed by the exact recorded codex:<id>. */
  sessionLabels?: Readonly<Record<string, string>>;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const timestamp = (value?: string | null) => value ? Date.parse(value) : Number.NaN;

function recordedActor(run: EngineeringRun, options: FeedbackExecutionOptions) {
  if (run.mode !== "external") return run.actor.trim() ? { actorIdentity: run.actor, actorLabel: run.actor } : {};
  const handoff = run.handoff;
  if (handoff?.state !== "claimed" || !run.actor.startsWith("codex:") || run.actor === "codex:"
    || handoff.owner !== run.actor || handoff.claimed_by !== run.actor
    || handoff.contract_key !== run.snapshot.contract_key || !Number.isFinite(timestamp(handoff.claimed_at))) return {};
  return { actorIdentity: run.actor, actorLabel: options.sessionLabels?.[run.actor]?.trim() || `Codex · ${runPlanSessionLabel(run.actor.slice("codex:".length))}` };
}

/**
 * Display an explicit feedback execution link, never infer one from a node's latest run.
 * Reuses the service's current-run/contract rules and the existing observation projection.
 * Callers pass expireEngineeringObservations' view; this selector adds no clock or live source.
 * Submitted files remain exclusively owned by projectFeedbackArtifacts + result observation.
 */
export function projectFeedbackExecution(view: EngineeringView, feedback: EngineeringFeedback, options: FeedbackExecutionOptions = {}): FeedbackExecution {
  let metadata: Pick<FeedbackExecution, "sourceLabel" | "actorLabel" | "actorIdentity" | "actionTitle" | "runId"> = { sourceLabel: "本条意见的处理记录" };
  const result = (state: FeedbackExecutionState, label: string, detail: string, reason?: string): FeedbackExecution => ({
    ...metadata, state, label, detail, ...(reason ? { reason } : {}), historical: state === "historical", unknown: state === "unknown"
  });
  if (feedback.scope_feedback_ids) return result("unlinked", "分别处理", "范围内各项保留独立处理记录，请查看对应子意见。");
  if (feedback.status === "open" || feedback.status === "dismissed") return result("unlinked", "尚无本轮执行", "当前轮次没有关联开工记录，旧记录仍保留在历史中。");
  if (feedback.resolution_kind === "plan") return result("unlinked", "按保存修订复核", "本条处理关联已保存的显示修订，不登记新的执行。");

  // Reopening invalidates all old links. A later adoption also starts a new
  // basis; neither an old working entry nor a leftover submitted ID can cross it.
  const lastReopen = feedback.history.findLastIndex(entry => entry.action === "reopen");
  const lastAdopt = feedback.history.findLastIndex(entry => entry.action === "adopt");
  const cycleStart = Math.max(lastReopen, lastAdopt);
  const cycle = feedback.history.slice(cycleStart + 1);
  const workingIndex = cycle.findLastIndex(entry => entry.action === "working" && entry.run_id);
  const submitted = feedback.submitted_run_id;
  const submittedIndex = submitted ? cycle.findLastIndex(entry => entry.action === "submit" && entry.run_id === submitted) : -1;
  if (submitted && submittedIndex < 0 && lastReopen < 0) {
    return result("unknown", "提交关联待核对", "提交编号缺少本轮对应记录，暂不能确认当前处理。");
  }
  // The service allows review -> working and retains the older submitted ID.
  // Follow the later explicit processing event; result ownership still uses only submitted_run_id.
  const linkKind = submittedIndex >= 0 && submittedIndex > workingIndex ? "submitted" : "working";
  const linkedId = linkKind === "submitted" ? submitted : cycle[workingIndex]?.run_id;
  if (!linkedId) return result(feedback.status === "working" ? "unknown" : "unlinked",
    feedback.status === "working" ? "开工记录待核对" : "尚未关联执行",
    "本轮没有可定位的执行记录，不能以本项其他运行代替。");

  const run = view.document.runs.find(item => item.id === linkedId);
  if (!run || run.node_id !== feedback.target.node_id || run.snapshot.node.id !== feedback.target.node_id) {
    return result("unknown", "关联执行待核对", "原运行缺失或不属于这处意见，不能以其他运行代替。");
  }
  const actionTitle = run.current_action === "source-verification" ? "核对源工程变化并执行实际检查"
    : run.snapshot.node.actions.find(action => action.id === run.current_action && !run.completed_action_ids.includes(action.id))?.title;
  metadata = { sourceLabel: run.mode === "external" ? "外部运行记录" : run.mode === "integration" ? "本机整合检查" : "本机受控运行",
    runId: run.id, ...recordedActor(run, options), ...(actionTitle ? { actionTitle } : {}) };
  const historical = (reason: string) => result("historical", "历史处理记录", "本条保留原执行记录，不代表当前仍在处理。", reason);
  const node = view.document.nodes.find(item => item.id === feedback.target.node_id);
  if (!node || node.status === "archived") return historical("原位置已不存在或已归档。");
  if (run.id === feedback.base_run_id) return historical("关联仍指向提出意见前的原交付，不能算本轮处理。");
  const adopted = lastAdopt > lastReopen ? feedback.history[lastAdopt] : undefined;
  if (!adopted || !feedback.adopted_lineage || !Number.isFinite(timestamp(adopted.at)) || !Number.isFinite(timestamp(run.started_at))) {
    return result("unknown", "处理依据待核对", "缺少本轮采用或执行时间依据，暂不能确认当前处理。");
  }
  if (timestamp(run.started_at) < timestamp(adopted.at)) return historical("该次运行早于本轮采用记录。");
  if (!same(run.snapshot.lineage, feedback.adopted_lineage)) return historical("关联运行不属于本轮采用后的约定版本。");
  if (!same(feedback.adopted_lineage, engineeringLineageVersions(view.document, node.id))
    || run.snapshot.contract_key !== engineeringContractKey(view.document, node.id)) return historical("当前约定已有变化，需要重新核对原处理依据。");
  if (run.status === "stale" || currentEngineeringRun(view.document, node.id)?.id !== run.id) return historical(run.reason || "本轮关联运行已失效或被后续运行替代。");

  if (["blocked", "paused", "rejected"].includes(run.status)) {
    const reason = run.reason || run.review_note || "运行已停止，尚未记录具体原因。";
    return result("stopped", runStatusLabel(run), "关联执行已停止；原意见与处理记录仍保留。", reason);
  }
  if (run.status === "review" || run.status === "accepted") return linkKind === "submitted"
    ? result("submitted", "已关联提交", "本轮处理结果已提交；成果是否有效以下方核对为准。")
    : result("waiting", "等待关联提交", "已关联的执行已有结果，但尚未提交为这条意见的处理成果。");
  if (run.mode === "external" && !metadata.actorIdentity) {
    return run.handoff?.state === "awaiting_claim"
      ? result("waiting", "等待实际领取", "交接记录尚无实际领取人，暂不判断正在执行。", run.reason)
      : result("unknown", "领取记录待核对", "领取人、执行身份或冻结交接不一致，暂不判断正在执行。");
  }
  if (run.status === "queued") return result("waiting", runStatusLabel(run), "运行已登记，仍在等待执行条件。", run.reason);
  const observation = view.observation?.runs[run.id];
  const observationMatches = run.mode === "external" ? observation?.state === "current" : observation?.state === "local";
  if (options.observationUnavailable || !observationMatches || !Number.isFinite(timestamp(observation?.last_observed_at))) {
    return result("unknown", "活动待确认", "处理记录仍保留，暂不判断正在执行。", options.observationUnavailable
      ? "当前执行观察不可用，请刷新后核对。" : observation?.message || "尚无对应的当前执行观察。");
  }
  return result("running", run.mode === "external" ? "正在处理" : "本机正在执行", actionTitle
    ? `当前记录动作：${actionTitle}。尚未提交为本条意见的处理成果。`
    : "关联运行正在执行，尚未记录具体当前动作。");
}
