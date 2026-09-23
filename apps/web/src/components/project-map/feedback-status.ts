import type { EngineeringView } from "@epm/domain";
import { engineeringFeedbackClosureCurrent, engineeringFeedbackGroupStatus, type EngineeringFeedback } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { projectFeedbackExecution } from "./feedback-execution.ts";

export const graphFeedbackStatus: Record<EngineeringFeedback["status"], { label: string; detail: string }> = {
  open: { label: "已记录", detail: "意见已保存，尚未派发给 Agent。" },
  adopted: { label: "已采用", detail: "改法已采用，尚无本条意见的实际开工记录。" },
  working: { label: "处理中", detail: "已关联实际执行记录，等待提交结果。" },
  review: { label: "已修改待查看", detail: "已有修订或新交付，仍需核对，尚未关闭。" },
  resolved: { label: "已关闭", detail: "已有复核依据；可打开记录查看。" },
  dismissed: { label: "未采用", detail: "已记录不采用的理由，保留原意见。" }
};

/** One current interpretation for the graph and its card; historical records stay untouched. */
export function graphFeedbackRecordStatus(view: EngineeringView, item: EngineeringFeedback, options: { observationUnavailable?: boolean } = {}) {
  const staleClosure = item.scope_feedback_ids
    ? item.scope_feedback_ids.some(id => {
      const child = view.document.feedbacks?.find(entry => entry.id === id && entry.scope_group_id === item.id);
      return child?.status === "resolved" && !engineeringFeedbackClosureCurrent(view.document, child);
    })
    : item.status === "resolved" && !engineeringFeedbackClosureCurrent(view.document, item);
  if (staleClosure) return { label: "需复核", detail: "原结果已变化，历史处理结论保留，当前内容需重新核对。", tone: "review" as const, closed: false };
  if (!item.scope_feedback_ids && item.status === "working") {
    const execution = projectFeedbackExecution(view, item, options);
    return { label: execution.label, detail: execution.detail, tone: execution.state === "running" ? "working" as const : "review" as const, closed: false };
  }
  const state = item.scope_feedback_ids ? engineeringFeedbackGroupStatus(view.document, item) : item.status;
  return {
    ...graphFeedbackStatus[state], tone: state, closed: state === "resolved" || state === "dismissed",
    ...(item.scope_feedback_ids ? { detail: state === "resolved" ? "所选范围内各项已有独立处理结论。" : "这条意见覆盖多个部分，处理进展分别保留在下方。" } : {})
  };
}
