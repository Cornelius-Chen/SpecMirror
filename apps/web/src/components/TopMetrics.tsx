import { Activity, AlertTriangle, Bot, CheckCircle2, ShieldCheck } from "lucide-react";
import type { ProjectMap } from "../types.ts";

export function TopMetrics({ data }: { data: ProjectMap }) {
  const items = [
    { label: "稳定基线", value: `${data.metrics.baselineProgress}%`, note: data.project.baselines[0]?.title, icon: ShieldCheck, tone: "safe" },
    { label: "活动前沿", value: `${data.metrics.frontierProgress}%`, note: data.project.frontier.title, icon: Activity, tone: "frontier" },
    { label: "证据覆盖", value: `${data.metrics.evidenceCoverage}%`, note: "高风险 Claim", icon: CheckCircle2, tone: "evidence" },
    { label: "基线风险", value: data.metrics.baselineAtRisk ? "有" : "无", note: data.metrics.baselineAtRisk ? "需要立即复核" : "保护门禁正常", icon: AlertTriangle, tone: data.metrics.baselineAtRisk ? "danger" : "quiet" },
    { label: "Agent 负载", value: `${data.metrics.agentLoad}/${data.metrics.maxWorkers}`, note: "并发 Worker", icon: Bot, tone: "agents" },
    { label: "阻塞 Goal", value: String(data.metrics.blockedGoals), note: "仅暂停自身与下游", icon: AlertTriangle, tone: data.metrics.blockedGoals ? "danger" : "quiet" }
  ];
  return <section className="metric-rail" aria-label="项目健康指标">
    {items.map(({ label, value, note, icon: Icon, tone }) => <div className={`metric metric-${tone}`} key={label}>
      <Icon size={15} strokeWidth={1.6} /><span>{label}</span><strong>{value}</strong><small>{note}</small>
    </div>)}
  </section>;
}
