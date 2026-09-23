import type { EngineeringView } from "@epm/domain";

export interface ProjectResultHeadline {
  state: "review" | "blocked" | "running" | "ready" | "forming" | "accepted";
  label: string;
  total: number;
  accepted: number;
}

/** Describes the nearest result-producing state instead of treating silence as completion. */
export function projectResultHeadline(view: EngineeringView, rootId: string): ProjectResultHeadline {
  const scope = view.document.nodes.filter(node => node.status !== "archived" && (node.id === rootId || view.derived[node.id]?.path.includes(rootId)));
  const latestRuns = new Map(scope.flatMap(node => {
    const id = view.derived[node.id]?.latest_run_id;
    const run = id ? view.document.runs.find(item => item.id === id) : undefined;
    return run ? [[node.id, run] as const] : [];
  }));
  const accepted = scope.filter(node => node.status === "accepted").length;
  const review = scope.filter(node => latestRuns.get(node.id)?.status === "review").length;
  const running = scope.filter(node => ["queued", "running"].includes(latestRuns.get(node.id)?.status ?? "")).length;
  const blocked = scope.filter(node => ["blocked", "paused", "needs_revision"].includes(node.status)).length;
  const ready = scope.filter(node => node.status === "ready").length;
  const unfinished = Math.max(0, scope.length - accepted);
  if (review) return { state: "review", label: `${review} 项待你验收`, total: scope.length, accepted };
  if (blocked) return { state: "blocked", label: `${blocked} 项有卡点`, total: scope.length, accepted };
  if (running) return { state: "running", label: `${running} 项正在执行`, total: scope.length, accepted };
  if (ready) return { state: "ready", label: `${ready} 项可以开始`, total: scope.length, accepted };
  if (unfinished) return { state: "forming", label: `${unfinished} 项待形成结果`, total: scope.length, accepted };
  return { state: "accepted", label: scope.length ? `${accepted}/${scope.length} 项已验收` : "当前没有成果项", total: scope.length, accepted };
}
