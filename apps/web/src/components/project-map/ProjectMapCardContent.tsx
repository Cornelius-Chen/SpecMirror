import { memo } from "react";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, Circle, Layers3, Target } from "lucide-react";
import type { ProjectMapRunPlanActivity } from "./types.ts";

export interface ProjectMapCardPresentation {
  id: string;
  name: string;
  title: string;
  status: string;
  unknown: boolean;
  purpose: { text: string; fullText: string };
  ownStatus: string;
  summary: string | undefined;
  visibleStatus: string;
  statusTone: string;
  statusDetail: string;
  opinionCount: number;
  runPlanActivity: ProjectMapRunPlanActivity | undefined;
  runPlanDescription: string;
  runPlanLabel: string;
}

// Geometry stays on the outer button. Stable semantic props let React keep its
// text/icon subtree while cards move; a new observation still updates it at once.
export const ProjectMapCardContent = memo(function ProjectMapCardContent({ presentation: p, root, childCount, expanded, selecting, selectedScope, feedbackMark }: {
  presentation: ProjectMapCardPresentation;
  root: boolean;
  childCount: number;
  expanded: boolean;
  selecting: boolean;
  selectedScope: boolean;
  feedbackMark: "origin" | "impact" | undefined;
}) {
  const Icon = p.status === "accepted" ? Check : ["blocked", "needs_revision"].includes(p.status) ? AlertTriangle : root ? Target : childCount ? Layers3 : Circle;
  const activity = p.runPlanActivity;
  return <>
    {feedbackMark && <span className={`psm-feedback-mark ${feedbackMark}`} title={feedbackMark === "origin" ? "当前意见位置" : "本次记录的影响位置"}/>}
    <span className="psm-card-heading"><span className="psm-marker"><Icon size={16}/></span><strong>{p.name}</strong>{activity && <span className={`psm-run-plan-badge is-${activity.phase}`} title={`${p.runPlanDescription}。计划完成不代表工程验收。`}><Bot size={10}/><span>{p.runPlanLabel} {activity.completedSteps}/{activity.totalSteps}</span></span>}{selecting ? <span className="psm-card-disclosure" aria-hidden="true">{selectedScope ? <Check size={14}/> : <Circle size={10}/>}</span> : childCount ? <span className="psm-card-disclosure" aria-hidden="true" title={`${childCount} 项下级 · ${expanded ? "收起" : "展开"}`}><b>{childCount}</b>{expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span> : null}</span>
    <span className="psm-output psm-purpose" data-node-purpose={p.id} title={`作用：${p.purpose.fullText}`}>{p.purpose.text}</span>
    {p.visibleStatus && <span className={`psm-card-status tone-${p.statusTone}`} title={p.statusDetail}>{p.visibleStatus}</span>}
  </>;
});
