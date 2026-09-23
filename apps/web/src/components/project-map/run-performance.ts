import type { EngineeringRun, EngineeringView } from "@epm/domain";

export interface ProjectRunPerformance {
  runCount: number; runningCount: number; measuredTokenRuns: number;
  agentMs: number; wallMs: number; overlapMs: number; peakParallel: number;
  totalTokens: number; tokenState: "none" | "observed" | "final";
}

const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const currentRun = (view: EngineeringView, run: EngineeringRun) => view.derived[run.node_id]?.latest_run_id === run.id && run.status !== "stale";

/** Summarizes only actual, claimed external runs in the selected subtree. */
export function projectRunPerformance(view: EngineeringView, nodeId: string, observedAt = Date.now()): ProjectRunPerformance {
  const children = new Map<string, string[]>();
  for (const node of view.document.nodes) if (node.parent_id && node.status !== "archived") children.set(node.parent_id, [...children.get(node.parent_id) ?? [], node.id]);
  const scope = new Set([nodeId]), queue = [...children.get(nodeId) ?? []];
  for (let index = 0; index < queue.length; index++) { const id = queue[index]; if (scope.has(id)) continue; scope.add(id); queue.push(...children.get(id) ?? []); }
  const runs = view.document.runs.filter(run => scope.has(run.node_id) && currentRun(view, run) && run.mode === "external" && run.handoff?.state === "claimed");
  const intervals = runs.flatMap(run => {
    const start = timestamp(run.started_at), end = timestamp(run.finished_at);
    return start !== null && end !== null && end >= start ? [{ start, end }] : [];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const agentMs = intervals.reduce((sum, item) => sum + item.end - item.start, 0);
  let unionMs = 0, unionStart = 0, unionEnd = 0;
  for (const interval of intervals) {
    if (!unionEnd || interval.start > unionEnd) { if (unionEnd) unionMs += unionEnd - unionStart; unionStart = interval.start; unionEnd = interval.end; }
    else unionEnd = Math.max(unionEnd, interval.end);
  }
  if (unionEnd) unionMs += unionEnd - unionStart;
  const events = intervals.flatMap(item => [{ at: item.start, change: 1 }, { at: item.end, change: -1 }]).sort((a, b) => a.at - b.at || a.change - b.change);
  let parallel = 0, peakParallel = 0;
  for (const event of events) { parallel += event.change; peakParallel = Math.max(peakParallel, parallel); }
  const measured = runs.filter(run => run.metrics && run.metrics.state !== "measuring");
  const tokenState = measured.length ? measured.every(run => run.metrics?.state === "final") ? "final" : "observed" : "none";
  return {
    runCount: intervals.length, runningCount: runs.filter(run => run.status === "running" && timestamp(run.started_at) !== null && observedAt >= timestamp(run.started_at)!).length, measuredTokenRuns: measured.length,
    agentMs, wallMs: intervals.length ? Math.max(...intervals.map(item => item.end)) - Math.min(...intervals.map(item => item.start)) : 0,
    overlapMs: Math.max(0, agentMs - unionMs), peakParallel,
    totalTokens: measured.reduce((sum, run) => sum + (run.metrics?.token_usage.total_tokens ?? 0), 0), tokenState
  };
}

export function durationLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

export function tokenLabel(tokens: number) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}
