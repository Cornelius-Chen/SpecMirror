import { ArrowUpRight, FileCheck2 } from "lucide-react";
import type { EngineeringRun } from "@epm/domain";
import type { EngineeringApi } from "../../engineering-api.ts";
import type { FeedbackResult } from "./feedback-comparison.ts";
import { isResultArtifactPath, materialLabels, nodeResultSummary } from "./node-result-state.ts";
import { useEngineeringRunResult } from "./use-engineering-run-result.ts";
import { timeLabel } from "../engineering/shared.ts";
import { ArtifactFiles } from "./ArtifactFiles.tsx";

interface Props {
  api: EngineeringApi; reference: FeedbackResult; nodeId: string; documentRevision: number; onOpenRecords: () => void;
}

/** A recorded feedback link selects the run; it never proves that its files still exist. */
export function GraphFeedbackResult(props: Props) {
  if (!props.reference.run) return <section className="gfc-result is-missing" aria-label="原位置成果">
    <header><FileCheck2 size={14}/><strong>原交付记录已变化</strong></header>
    <button type="button" onClick={props.onOpenRecords}>查看交付与验收记录<ArrowUpRight size={12}/></button>
  </section>;
  return <ObservedFeedbackResult key={JSON.stringify([props.api.workspaceId ?? "host", props.nodeId, props.reference.run.id])} {...props} run={props.reference.run}/>;
}

function ObservedFeedbackResult({ api, reference, nodeId, documentRevision, onOpenRecords, run }: Props & { run: EngineeringRun }) {
  const { loading, result, error, refresh } = useEngineeringRunResult(api, nodeId, run, documentRevision);
  const summary = result ? nodeResultSummary(result, reference.state === "current") : undefined;
  const artifacts = result?.artifacts.filter(item => isResultArtifactPath(item.path) && item.actual_sha256 && !["missing", "unreadable"].includes(item.status)) ?? [];
  const tone = error || summary?.tone === "attention" ? "attention" : summary && !summary.current ? "historical" : "current";
  return <section className={`gfc-result is-${tone}`} aria-label="原位置成果" aria-busy={loading} data-run-id={run.id}>
    <header><FileCheck2 size={14}/><div>
      <strong>{loading ? "正在核对本次结果…" : error ? "成果暂未核对" : summary?.current ? summary.label : "历史交付 · 不代表当前完成"}</strong>
      {summary && <small>方案第 {run.snapshot.node.revision} 版 · {summary.current ? "本次核对" : "历史交付"} {timeLabel(result!.observed_at)}</small>}
    </div></header>
    {error && <p role="alert" className="gfc-result-warning">{error}</p>}
    {summary && <>
      <p className="gfc-result-summary">{summary.summary}</p>
      {summary.issues.length > 0 && <details className="gfc-material-issues"><summary>需核对 {summary.issues.length} 处</summary><ul>{summary.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
      <ArtifactFiles api={api} result={result!} artifacts={artifacts} actionClassName="gfc-result-actions" statusLabel={summary.label} historical={!summary.current}
        label={(artifact, index) => artifact.status === "changed" ? "查看现有文件 · 内容已变化" : artifact.status !== "verified" ? `查看文件 · ${materialLabels[artifact.status]}` : index ? artifact.path! : "打开成果"} />
      {!artifacts.length && <p className="gfc-result-summary">目前没有可打开的文件成果。</p>}
    </>}
    <div className="gfc-observation-actions"><button type="button" disabled={loading} onClick={refresh}>刷新核对</button><button type="button" onClick={onOpenRecords}>查看交付与验收记录<ArrowUpRight size={12}/></button></div>
  </section>;
}
