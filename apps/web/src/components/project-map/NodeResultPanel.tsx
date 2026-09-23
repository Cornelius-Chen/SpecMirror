import { useState } from "react";
import type { EngineeringRun, EngineeringView } from "@epm/domain";
import type { EngineeringApi } from "../../engineering-api.ts";
import { timeLabel } from "../engineering/shared.ts";
import { isResultArtifactPath, materialLabels, nodeResultRuns, nodeResultSummary } from "./node-result-state.ts";
import { useEngineeringRunResult } from "./use-engineering-run-result.ts";
import { ArtifactFiles } from "./ArtifactFiles.tsx";
import "./node-result.css";

interface Props { api: EngineeringApi; view: EngineeringView; nodeId: string }

export function NodeResultPanel(props: Props) {
  return <ResultSelection key={JSON.stringify([props.api.workspaceId ?? "host", props.nodeId])} {...props} />;
}

function ResultSelection({ api, view, nodeId }: Props) {
  const { current, history } = nodeResultRuns(view, nodeId);
  const [selection, setSelection] = useState<string | null>(null);
  const selectedId = selection ?? current?.id ?? "";
  const run = [...current ? [current] : [], ...history].find(item => item.id === selectedId);
  return <section className="node-result-panel" aria-label="节点运行成果" data-node-id={nodeId}>
    <header><h3>运行成果</h3>{history.length > 0 && <label>查看记录<select aria-label="选择成果运行" value={selectedId} onChange={event => setSelection(event.target.value)}>
      <option value={current?.id ?? ""}>{current ? "当前运行" : "当前版本 · 还未执行"}</option>
      {history.map((item, index) => <option key={item.id} value={item.id}>历史 {history.length - index} · {timeLabel(item.started_at)}</option>)}
    </select></label>}</header>
    {run ? <ResultRead key={JSON.stringify([api.workspaceId ?? "host", nodeId, run.id])} api={api} view={view} nodeId={nodeId} run={run} selectedCurrent={run.id === current?.id} />
      : <p className="nr-summary">{selectedId ? "所选运行已不可用，请重新选择记录。" : "当前版本还未执行。"}{!selectedId && history.length > 0 && " 可选择历史记录查阅；历史成果不代表当前完成。"}</p>}
  </section>;
}

function ResultRead({ api, view, nodeId, run, selectedCurrent }: Props & { run: EngineeringRun; selectedCurrent: boolean }) {
  const { loading, result, error, refresh } = useEngineeringRunResult(api, nodeId, run, view.document.revision);
  const summary = result ? nodeResultSummary(result, selectedCurrent) : undefined;
  const artifacts = result?.artifacts.filter(item => isResultArtifactPath(item.path) && item.actual_sha256 && !["missing", "unreadable"].includes(item.status)) ?? [];
  return <div data-run-id={run.id} aria-busy={loading}>
    {loading && <p role="status" className="nr-summary">正在核对本次结果…</p>}
    {error && <p role="alert" className="nr-error">{error}</p>}
    {result && summary && <>
      <p className={`nr-status is-${summary.tone}`}><span>{summary.current ? "当前运行" : "历史运行 · 不代表当前完成"}</span><strong>{summary.label}</strong></p>
      <p className="nr-summary">{summary.summary}</p>
      {summary.notices.length > 0 && <p className="nr-progress-note">{summary.notices.join("；")}</p>}
      {summary.issues.length > 0 && <div className="nr-issues" role="status"><strong>需处理的问题</strong><ul>{summary.issues.slice(0, 3).map(issue => <li key={issue}>{issue}</li>)}</ul>{summary.issues.length > 3 && <details><summary>另外 {summary.issues.length - 3} 项问题</summary><ul>{summary.issues.slice(3).map(issue => <li key={issue}>{issue}</li>)}</ul></details>}</div>}
      <ArtifactFiles api={api} result={result} artifacts={artifacts} actionClassName="nr-actions" statusLabel={summary.label} historical={!summary.current}
        label={(artifact, index) => artifacts.length > 1 ? artifact.path! : "打开成果"} />
      <div className="nr-actions">
        {!artifacts.length && <button type="button" disabled title="本次没有可打开的文件成果">打开成果</button>}
        <a href={api.resultUrl(result.run_id)} download="engineering-run-result.json">下载记录</a>
      </div>
      <details className="nr-evidence"><summary>材料、检查与时间</summary>
        {result.artifacts.map(item => <p key={item.evidence_id}><span>{item.path || item.evidence_id}</span> · {materialLabels[item.status]}</p>)}
        {result.source_checks.map((check, index) => <p key={`${check.id}:${index}`}>{check.title} · 原检查{check.status === "passed" && check.exit_code === 0 ? "通过" : "未通过"} · 当前材料{check.material_status ? materialLabels[check.material_status as keyof typeof materialLabels] || "待核对" : "尚未核实"}</p>)}
        <dl><div><dt>运行</dt><dd>{result.run_id}</dd></div><div><dt>冻结版本</dt><dd>{result.node_revision}</dd></div><div><dt>开始</dt><dd>{timeLabel(result.started_at)}</dd></div><div><dt>结束</dt><dd>{timeLabel(result.finished_at)}</dd></div><div><dt>本次材料核对</dt><dd>{timeLabel(result.observed_at)}</dd></div><div><dt>本次运行 Token</dt><dd>{result.metrics ? `${result.metrics.token_usage.total_tokens.toLocaleString("zh-CN")}（${result.metrics.state === "final" ? "最终记录" : "已观测"}）` : "缺测"}</dd></div></dl>
        {result.review && <blockquote>原复核记录：{result.review.review_note || "未填写意见"}<small>{timeLabel(result.review.reviewed_at)}</small></blockquote>}
      </details>
    </>}
    <button type="button" className="nr-refresh" onClick={refresh}>刷新核对</button>
  </div>;
}
