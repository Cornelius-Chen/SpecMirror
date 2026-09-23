import type { EngineeringNode, EngineeringView } from "@epm/domain";

const timestamp = (value?: string | null) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

/** Callers own workspace identity. An older response cannot overwrite newer document or observation facts. */
export function selectEngineeringView(current: EngineeringView | undefined, incoming: EngineeringView): EngineeringView {
  if (!current || current.document.id !== incoming.document.id) return incoming;
  if (incoming.document.revision !== current.document.revision) return incoming.document.revision > current.document.revision ? incoming : current;
  return timestamp(incoming.observation?.captured_at) < timestamp(current.observation?.captured_at) ? current : incoming;
}

/** A display-only projection: retain the actual observation timestamp and never mutate stored records. */
export function expireEngineeringObservations(view: EngineeringView, at = Date.now()): EngineeringView {
  if (!view.observation) return view;
  let changed = false;
  const runs = { ...view.observation.runs };
  for (const run of view.document.runs) {
    const observed = runs[run.id];
    if (run.mode !== "external" || observed?.state !== "current") continue;
    const age = at - timestamp(observed.last_observed_at);
    if (!Number.isFinite(age) || age < -60_000 || age > 30 * 60_000) {
      runs[run.id] = { ...observed, state: "stale", message: "最后观察已过期，当前执行状态待更新。" };
      changed = true;
    }
  }
  return changed ? { ...view, observation: { ...view.observation, runs } } : view;
}

export function hasActiveExternalEngineeringRun(view?: EngineeringView): boolean {
  return !!view?.document.runs.some(run => run.mode === "external" && ["queued", "running"].includes(run.status) && view.derived[run.node_id]?.latest_run_id === run.id);
}

/** Only this node is edited. Child contributions and other nodes' contracts need their own reviewed change. */
export function removeEngineeringCriterion(node: EngineeringNode, criterionId: string): EngineeringNode {
  return { ...node, criteria: node.criteria.filter(item => item.id !== criterionId),
    ...(node.delivery ? { delivery: { ...node.delivery, outputs: node.delivery.outputs.map(output => ({ ...output, criterion_ids: output.criterion_ids.filter(id => id !== criterionId) })) } } : {}),
    ...(node.composition ? { composition: { ...node.composition, integration_criterion_ids: node.composition.integration_criterion_ids.filter(id => id !== criterionId) } } : {}) };
}
