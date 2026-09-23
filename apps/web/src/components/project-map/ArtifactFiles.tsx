import { useEffect, useRef, useState } from "react";
import type { EngineeringApi } from "../../engineering-api.ts";
import type { EngineeringRunResult } from "./node-result-state.ts";
import { canPreviewArtifactText, readArtifactText } from "./artifact-text.ts";
import "./artifact-files.css";

type Artifact = EngineeringRunResult["artifacts"][number];
interface Props {
  api: EngineeringApi;
  result: EngineeringRunResult;
  artifacts: Artifact[];
  actionClassName: string;
  label: (artifact: Artifact, index: number) => string;
  statusLabel: string;
  historical: boolean;
}

/** One requested file stays attached to its exact observed result. No eager file reads. */
export function ArtifactFiles(props: Props) {
  const identity = JSON.stringify([props.api.workspaceId ?? "host", props.result.node_id, props.result.run_id,
    props.result.contract_key, props.result.node_revision, props.result.observed_at,
    props.artifacts.map(file => [file.evidence_id, file.path, file.actual_sha256, file.status])]);
  return <FileSelection key={identity} {...props} />;
}

function FileSelection({ api, result, artifacts, actionClassName, label, statusLabel, historical }: Props) {
  const [selection, setSelection] = useState<number | null>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const selected = selection === null ? undefined : artifacts[selection];
  const close = () => { returnFocus.current = selection === null ? null : buttons.current.get(selection) ?? null; setSelection(null); };
  useEffect(() => {
    if (selection !== null || !returnFocus.current) return;
    returnFocus.current.focus({ preventScroll: true }); returnFocus.current.scrollIntoView({ block: "nearest", behavior: "auto" }); returnFocus.current = null;
  }, [selection]);
  const controls = <div className={actionClassName}>{artifacts.map((artifact, index) => canPreviewArtifactText(artifact.path)
      ? <button key={artifact.evidence_id} type="button" ref={element => { if (element) buttons.current.set(index, element); else buttons.current.delete(index); }}
        aria-expanded={selection === index} onClick={() => selection === index ? close() : setSelection(index)}>{label(artifact, index)}</button>
      : <a key={artifact.evidence_id} href={api.artifact(result.run_id, artifact.path!)} target="_blank" rel="noreferrer">{label(artifact, index)}<span aria-hidden="true"> ↗</span></a>)}</div>;
  return <div className="artifact-files">
    {artifacts.length > 3 ? <details className="ar-file-menu"><summary>选择成果文件（{artifacts.length}）</summary>{controls}</details> : controls}
    {selected && <TextReader key={JSON.stringify([selected.evidence_id, selected.path, selected.actual_sha256])}
      api={api} result={result} artifact={selected} statusLabel={statusLabel} historical={historical} onClose={close} />}
  </div>;
}

function TextReader({ api, result, artifact, statusLabel, historical, onClose }: Pick<Props, "api" | "result" | "statusLabel" | "historical"> & { artifact: Artifact; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ api: EngineeringApi; attempt: number; text?: string; error?: string }>();
  const region = useRef<HTMLElement>(null);
  const visible = state?.api === api && state.attempt === attempt ? state : undefined;
  useEffect(() => { region.current?.focus({ preventScroll: true }); region.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); }, []);
  useEffect(() => {
    // Bring the loaded reading area into view, but never pull a user who moved elsewhere.
    if (visible && region.current?.contains(document.activeElement)) region.current.scrollIntoView({ block: "start", behavior: "auto" });
  }, [visible]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    void readArtifactText(api, result.run_id, artifact, controller.signal)
      .then(file => { if (active) setState({ api, attempt, text: file.text }); })
      .catch(error => { if (active && !controller.signal.aborted) setState({ api, attempt, error: error instanceof Error ? error.message : "暂时无法读取这份报告，请重试。" }); });
    return () => { active = false; controller.abort(); };
  }, [api, result.run_id, artifact, attempt]);
  return <section ref={region} tabIndex={-1} className="artifact-reader" aria-label="成果原文" aria-busy={!visible}
    data-node-id={result.node_id} data-run-id={result.run_id} data-file-path={artifact.path} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><strong>报告原文</strong><button type="button" onClick={onClose}>收起报告</button></header>
    <p className="ar-file">{artifact.path?.split("/").at(-1)}<span>{historical ? "历史文件" : statusLabel}</span></p>
    {historical && <p className="ar-note">这是历史运行的文件，当前完成情况见上方记录。</p>}
    {artifact.status !== "verified" && <p className="ar-note">{artifact.status === "changed" ? "文件内容已变化，请对照原交付查看。" : "原交付校验依据不完整，本次只核对当前文件。"}</p>}
    {!visible && <p role="status" className="ar-message">正在读取并核对报告…</p>}
    {visible?.error && <div className="ar-error" role="alert"><p>{visible.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试读取</button></div>}
    {visible?.text !== undefined && <>
      <pre className="ar-content" tabIndex={0} aria-label="报告内容">{visible.text || "（空文件）"}</pre>
      <p className="ar-hint">原文阅读 · 区域内滚动</p>
    </>}
    <details className="ar-source"><summary>查看文件来源</summary><p>{artifact.path}</p><p>运行：{result.run_id}</p><p>工作区：{result.workspace_id}</p><p>本次核对：{result.observed_at}</p>
      <a href={api.artifact(result.run_id, artifact.path!)} target="_blank" rel="noreferrer">原文件 ↗</a></details>
  </section>;
}
