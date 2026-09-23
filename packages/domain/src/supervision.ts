import type { SupervisionCategory, SupervisionDocument, SupervisionRun } from "./schema.ts";

const statusScore = {
  draft: 0,
  ready: 20,
  assigned: 40,
  reviewing: 65,
  needs_revision: 50,
  accepted: 100
} as const;

export interface SupervisionProgress {
  designProgress: number;
  outputCoverage: number;
  evidenceCoverage: number;
  acceptanceCoverage: number;
  activeRuns: number;
  revisionNeeded: number;
  totalDetails: number;
  totalRuns: number;
  byTask: Record<string, { total: number; accepted: number; progress: number; outputCoverage: number }>;
  byCategory: Record<SupervisionCategory, { total: number; accepted: number; progress: number }>;
  nextBestAction: { detailId: string | null; title: string; reason: string };
}

const percent = (part: number, whole: number) => whole ? Math.round(part / whole * 100) : 0;

export function deriveSupervisionProgress(document: SupervisionDocument, runs: SupervisionRun[]): SupervisionProgress {
  const detailScore = document.details.reduce((sum, detail) => sum + statusScore[detail.status], 0);
  const outputs = document.details.filter((detail) => detail.output);
  const checks = outputs.filter((detail) => detail.output?.source !== "mock").flatMap((detail) => detail.output?.checks ?? []);
  const evidenced = checks.filter((check) => check.result === "pass" || check.result === "partial").length;
  const categories: SupervisionCategory[] = ["function", "visual", "interaction", "copy", "asset"];
  const byTask = Object.fromEntries(document.tasks.map((task) => {
    const details = document.details.filter((detail) => detail.task_id === task.id);
    return [task.id, {
      total: details.length,
      accepted: details.filter((detail) => detail.status === "accepted").length,
      progress: details.length ? Math.round(details.reduce((sum, detail) => sum + statusScore[detail.status], 0) / details.length) : 0,
      outputCoverage: percent(details.filter((detail) => detail.output).length, details.length)
    }];
  }));
  const byCategory = Object.fromEntries(categories.map((category) => {
    const details = document.details.filter((detail) => detail.category === category);
    return [category, {
      total: details.length,
      accepted: details.filter((detail) => detail.status === "accepted").length,
      progress: details.length ? Math.round(details.reduce((sum, detail) => sum + statusScore[detail.status], 0) / details.length) : 0
    }];
  })) as SupervisionProgress["byCategory"];

  const needsRevision = document.details.find((detail) => detail.status === "needs_revision");
  const ready = document.details.find((detail) => ["draft", "ready"].includes(detail.status));
  const reviewing = document.details.find((detail) => detail.status === "reviewing");
  const target = needsRevision ?? ready ?? reviewing;
  const nextBestAction = !target
    ? { detailId: null, title: "监督闭环已逐项通过", reason: "所有设计细节都已有被人确认的验收结论。" }
    : needsRevision
      ? { detailId: target.id, title: `局部重做：${target.title}`, reason: "该条目已被要求修订，应保持类别隔离后重新派发。" }
      : ready
        ? { detailId: target.id, title: `派发：${target.title}`, reason: "该条目尚无可检查产出，先生成隔离运行快照。" }
        : { detailId: target.id, title: `检查：${target.title}`, reason: "已有产出等待监督者逐项通过或退回。" };

  return {
    designProgress: document.details.length ? Math.round(detailScore / document.details.length) : 0,
    outputCoverage: percent(outputs.length, document.details.length),
    evidenceCoverage: percent(evidenced, checks.length),
    acceptanceCoverage: percent(document.details.filter((detail) => detail.status === "accepted").length, document.details.length),
    activeRuns: runs.filter((run) => ["queued", "running"].includes(run.status)).length,
    revisionNeeded: document.details.filter((detail) => detail.status === "needs_revision").length,
    totalDetails: document.details.length,
    totalRuns: runs.length,
    byTask,
    byCategory,
    nextBestAction
  };
}
