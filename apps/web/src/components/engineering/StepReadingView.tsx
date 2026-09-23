import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineeringCapabilityCatalog, EngineeringNode, EngineeringView } from "@epm/domain";
import { createTaskPresentationApi, subscribeTaskPresentation, TaskPresentationApiError, type TaskPresentationView } from "../../task-presentation-api.ts";
import { actionNames, criterionNames, currentNodeRun, nodeStatusLabel, ordered, runStatusLabel } from "./shared.ts";
import { engineeringNodeName } from "./node-names.ts";
import "../../step-reading.css";

interface Props {
  nodeNames?: Record<string, string>;
  node: EngineeringNode; view: EngineeringView; catalog?: EngineeringCapabilityCatalog; catalogError: string;
  owners: Array<{ id: string; label: string; available: boolean }>; dirty: boolean;
  onEdit: (tab: string, label?: string) => void; onSelect: (id: string) => void; onRuns: () => void; onControls: () => void;
}
export function StepReadingView({ node, view, nodeNames, catalog, catalogError, owners, dirty, onEdit, onSelect, onRuns, onControls }: Props) {
  const derived = view.derived[node.id]; const run = currentNodeRun(view, node.id);
  const children = ordered(view.document.nodes.filter((item) => item.parent_id === node.id && item.status !== "archived"));
  const dependencies = [...derived.path.filter((id) => id !== node.id), node.id].flatMap((id) => { const source = view.document.nodes.find((item) => item.id === id); return (source?.dependencies ?? []).map((dependencyId) => ({ id: dependencyId, sourceId: id, sourceTitle: source ? engineeringNodeName(source, nodeNames) : id })); });
  const inherited = derived.effective.rules.filter((rule) => rule.node_id !== node.id);
  const owner = owners.find((item) => item.id === node.owner);
  const edit = (name: string, tab: string, label?: string) => <button type="button" className="eng-text-button" disabled={node.status === "archived"} onClick={() => onEdit(tab, label)}>修改{name}</button>;
  const titleFor = (id: string, fallback = id) => { const item = view.document.nodes.find((candidate) => candidate.id === id); return item ? engineeringNodeName(item, nodeNames) : fallback; };
  const next = node.status === "archived" ? "本项已归档，保留历史说明与证据。" : node.status === "paused" ? "本任务已暂停，请先核对暂停原因与当前方案。" : run?.status === "queued" ? runStatusLabel(run) : run?.status === "running" ? "等待负责人完成已冻结的动作，并提交真实证据。" : run?.status === "review" ? "核对本次证据，再由验收人决定通过或退回。" : derived.status === "accepted" ? "本层已通过当前版本验收，可查看记录或继续上层整合。" : derived.blockers.length ? "先处理下面的等待条件，再检查方案就绪。" : node.status === "ready" ? "方案已就绪，可查看调度条件并安排执行。" : "补齐本层目标、做法与验收条件，再检查方案就绪。";
  return <div className="eng-reading" aria-label="步骤说明正文">
    {dirty && <p className="eng-notice">有尚未保存的方案修改；下方展示已保存内容。<button type="button" className="eng-text-button" onClick={() => onEdit("plan")}>继续编辑草稿</button></p>}
    <section className="eng-reading-next-summary" aria-label="下一步摘要"><div><strong>下一步</strong><p>{next}</p></div><button type="button" onClick={node.status === "archived" || run && ["queued", "running", "review"].includes(run.status) ? onRuns : onControls}>查看下一步安排</button></section>
    <div className="eng-reading-layout"><div className="eng-reading-content">
      <section className="eng-reading-section" aria-labelledby="step-objective"><div className="eng-reading-heading"><h2 id="step-objective">{node.kind === "project" ? "本工程要完成什么" : node.kind === "task" ? "本任务要完成什么" : "本步骤要完成什么"}</h2>{edit("目标", "plan", "预期结果")}</div><p className="eng-reading-prose">{node.objective || "目标尚待补充：写清完成后得到什么，以及为谁解决什么问题。"}</p></section>
      <section className="eng-reading-section" aria-labelledby="step-method"><div className="eng-reading-heading"><h2 id="step-method">准备怎么做</h2>{edit("做法", "plan", "执行思路")}</div><p className="eng-reading-prose">{node.method || "做法尚待补充：说明先后步骤，以及何时可以继续。"}</p>{node.architecture && <><h3>结构与衔接</h3><p className="eng-reading-prose">{node.architecture}</p></>}
        <div className="eng-reading-heading"><h3>已选能力及用途</h3>{edit("能力", "capabilities")}</div>{node.capabilities.length ? <ul className="eng-reading-list">{node.capabilities.map((binding) => <li key={binding.id}><strong>{catalog?.capabilities.find((item) => item.id === binding.id)?.title ?? binding.id}</strong><p>{binding.purpose || "尚未说明本步用途"}</p><small>{node.actions.some((action) => action.type === "use_capability" && action.capability_id === binding.id) ? "已安排使用动作；实际应用结果见运行证据。" : "尚未安排使用动作。选入方案不代表已经应用或验证。"}</small></li>)}</ul> : <p className="eng-muted">尚未选用外部能力；按任务需要补充即可。</p>}{catalogError && node.capabilities.length > 0 && <p className="eng-notice">能力名称暂时无法更新；已保存的用途仍可阅读。{catalogError}</p>}
        <details className="eng-disclosure"><summary>执行动作与配置 · {node.actions.length} 项</summary>{node.actions.map((action, index) => <div className="eng-reading-action" key={action.id}><strong>{index + 1}. {action.title || "待说明动作"}</strong><p>{actionNames[action.type]}</p>{action.path && <code>{action.path}</code>}{action.content && <details><summary>已配置内容</summary><pre>{action.content}</pre></details>}</div>)}{edit("执行动作", "actions")}</details>
      </section>
      {children.length > 0 && <section className="eng-reading-section"><div className="eng-reading-heading"><h2>拆分为哪些步骤</h2>{edit("拆分", "plan", "任务名称")}</div><ol className="eng-reading-children">{children.map((child) => <li key={child.id}><button type="button" onClick={() => onSelect(child.id)}>{engineeringNodeName(child, nodeNames)}</button><span>{nodeStatusLabel(view, child)}</span><p>{child.objective || "目标待补充"}</p></li>)}</ol><p className="eng-muted">子项各自验收后，本层仍需整合检查与人工验收。</p></section>}
      <section className="eng-reading-section" aria-labelledby="step-bounds"><div className="eng-reading-heading"><h2 id="step-bounds">必须遵守什么</h2>{edit("约束", "bounds", "本层补充规则")}</div><h3>本层约束</h3>{node.constraints.rules.length ? <ul>{node.constraints.rules.map((rule, index) => <li key={index}>{rule}</li>)}</ul> : <p className="eng-muted">本层未补充规则，继续遵守上级边界。</p>}<h3>从上级继承</h3>{inherited.length ? <ul className="eng-reading-list">{inherited.map((rule, index) => <li key={`${rule.node_id}-${index}`}>{rule.text}<button type="button" className="eng-source" onClick={() => onSelect(rule.node_id)}>来自 {titleFor(rule.node_id, rule.title)}</button></li>)}</ul> : <p className="eng-muted">没有继承的通用规则。</p>}
        {node.source_scope && <p className="eng-notice">本步核验真实源工程改动，并运行 {node.source_scope.checks.length} 条检查。同源目录需等待前一步人工验收后再使用；这是审计边界，不是操作系统隔离。</p>}
        <details className="eng-disclosure"><summary>文件范围、源工程与共享资源</summary>{derived.effective.allow_layers.map((layer) => <p key={layer.node_id}>{titleFor(layer.node_id, layer.title)}允许：<code>{layer.patterns.join("、")}</code></p>)}{derived.effective.deny.map((item, index) => <p key={index}>{titleFor(item.node_id, item.title)}禁止：<code>{item.pattern}</code></p>)}<p>独占资源：{derived.effective.resources.join("、") || "无"}</p>{node.source_scope && <><p>源目录：<code>{node.source_scope.root}</code></p><p>允许：{node.source_scope.allow.join("、")}</p><p>禁止：{node.source_scope.deny.join("、") || "未另设"}</p>{node.source_scope.checks.map((check) => <p key={check.id}>{check.title}<code>node {check.args.join(" ")}</code></p>)}</>}<p className="eng-muted">交付范围相对运行产物目录。历史检查不会自动证明新的文件版本。</p></details>
      </section>
      <section className="eng-reading-section" aria-labelledby="step-criteria"><div className="eng-reading-heading"><h2 id="step-criteria">怎样证明完成</h2>{edit("验收条件", "criteria")}</div><p className="eng-muted">逐项核对当前运行证据，人工验收通过后才计入完成。</p>{node.criteria.length ? <ol className="eng-reading-criteria">{node.criteria.map((criterion) => { const evidence = run?.evidence.filter((item) => item.criterion_id === criterion.id) ?? []; return <li key={criterion.id}><h3>{criterion.text || "验收条件待说明"}</h3><span className="eng-reading-meta">{criterionNames[criterion.kind]}</span>{evidence.length ? <ul>{evidence.map((item) => <li key={item.id}><strong>{item.kind === "artifact" ? "已提交产物" : item.kind === "capability" ? "能力应用记录" : item.kind === "human" ? item.passed ? "人工核对通过" : "人工核对未通过" : item.passed ? "检查通过" : "检查未通过"}</strong> · {item.summary}</li>)}</ul> : <p className="eng-muted">当前运行尚无关联证据。</p>}{children.filter((child) => child.contributes_to.includes(criterion.id)).map((child) => <p key={child.id}>子项贡献：<button type="button" className="eng-text-button" onClick={() => onSelect(child.id)}>{engineeringNodeName(child, nodeNames)}</button> · {nodeStatusLabel(view, child)}</p>)}</li>; })}</ol> : <p className="eng-empty-inline">尚未定义验收条件。补充可逐项核对的结果。</p>}
        {run?.source_proof && <p className="eng-notice">本次源工程核验：{run.source_proof.status === "passed" ? "实际检查通过，仍需人工验收" : "未通过或受阻，请核对真实检查记录"}。</p>}{!!run?.source_integration_proofs?.length && <p className="eng-notice">本次保留 {run.source_integration_proofs.length} 组真实组合源码检查记录。</p>}
        <button type="button" className="eng-text-button" onClick={onRuns}>查看运行证据与人工验收 →</button><p className="eng-muted">{run ? `当前记录：${runStatusLabel(run)}。` : "尚无当前版本运行。"}历史证据保留在运行记录中，不能直接替代本次验收。</p>
      </section>
    </div><aside className="eng-reading-next" aria-label="当前下一步"><h2>当前下一步</h2><p>{next}</p><button type="button" onClick={run && ["queued", "running", "review"].includes(run.status) ? onRuns : onControls}>{run && ["queued", "running", "review"].includes(run.status) ? "查看当前运行" : "查看执行条件"}</button><h3>负责人</h3><p>{owner?.label ?? (node.owner.startsWith("codex:") ? "已分配的 Codex 会话" : node.owner || "待分配")}</p>{node.owner.startsWith("codex:") && <p className="eng-muted">{owner?.available ? "近期有真实连接记录；交接后仍需负责人领取。" : "尚无近期连接记录，不能据此认定正在执行。"}</p>}{edit("负责人", "plan", "选择负责人")}<h3>开始前需要</h3>{dependencies.length ? <ul>{dependencies.map(({ id, sourceId, sourceTitle }) => <li key={`${sourceId}:${id}`}><button type="button" className="eng-text-button" onClick={() => onSelect(id)}>{titleFor(id)}</button><span> · {view.document.nodes.find((item) => item.id === id) ? nodeStatusLabel(view, view.document.nodes.find((item) => item.id === id)!) : "待核对"}</span><small className="eng-reading-dependency-source">{sourceId === node.id ? "本层前置" : `继承自 ${sourceTitle}`}</small></li>)}</ul> : <p className="eng-muted">本层与上级均未声明前置依赖。</p>}{run?.reason && <p className="eng-notice">{run.reason}</p>}{derived.blockers.length > 0 && <><h3>当前等待条件</h3><ul>{derived.blockers.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</aside></div>
  </div>;
}

export function NodeLabelsEditor({ workspaceId, nodeId, resetKey, disabled, onDirty, onBusy, onLabels }: { workspaceId: string; nodeId: string; resetKey: number; disabled: boolean; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; onLabels: (labels: Record<string, string[]>) => void }) {
  const api = useMemo(() => createTaskPresentationApi(workspaceId), [workspaceId]);
  const [view, setView] = useState<TaskPresentationView>();
  const [draft, setDraft] = useState(""); const [editing, setEditing] = useState(false);
  const [baseRevision, setBaseRevision] = useState<number>(); const [baseLabels, setBaseLabels] = useState<string[]>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false); const [conflict, setConflict] = useState(false); const [saving, setSaving] = useState(false);
  const generation = useRef(0); const alive = useRef(true); const editingRef = useRef(false); const savingRef = useRef(false);
  const labels = view?.workspace.node_labels[nodeId] ?? [];
  const parsed = [...new Set(draft.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
  const dirty = editing && JSON.stringify(parsed) !== JSON.stringify(baseLabels);
  const invalidLabels = parsed.length > 12 || parsed.some((label) => label.length > 24);
  useEffect(() => { if (view) onLabels(view.workspace.node_labels); }, [view?.workspace.node_labels, onLabels]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { onBusy(saving); }, [saving, onBusy]);
  async function load(preserve = false, acceptLatestBase = false) {
    const token = ++generation.current; setBusy(true);
    if (!preserve || acceptLatestBase) setError("");
    try {
      const next = await api.load(); if (!alive.current || token !== generation.current) return;
      setView(next);
      if (!preserve) setDraft((next.workspace.node_labels[nodeId] ?? []).join("，"));
      if (acceptLatestBase) {
        setBaseRevision(next.revision); setBaseLabels([...(next.workspace.node_labels[nodeId] ?? [])]); setConflict(false);
        setNotice("已载入最新标签基准，当前输入未改变。请对照已保存标签，核对后再保存。");
      }
    } catch (cause) { if (alive.current && token === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current && token === generation.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current++; }; }, [api, nodeId, resetKey]);
  useEffect(() => subscribeTaskPresentation(() => {
    // mutate publishes its own successful response before resolving. Let save install it.
    if (savingRef.current) return;
    if (editingRef.current) {
      setConflict(true); setNotice(""); setError("分类或标签数据已有新版本，当前输入已保留。请刷新标签版本，核对后再保存。");
    }
    // A different workspace's revision cannot be combined with this workspace's old labels.
    void load(editingRef.current);
  }), [api, nodeId]);
  async function save() {
    if (!view || baseRevision === undefined || busy || invalidLabels || conflict) return;
    const token = ++generation.current; savingRef.current = true; setBusy(true); setSaving(true); setError(""); setNotice("");
    try {
      const next = await api.mutate(baseRevision, { type: "set_node_labels", node_id: nodeId, labels: parsed });
      if (!alive.current || token !== generation.current) return;
      setView(next); setDraft((next.workspace.node_labels[nodeId] ?? []).join("，")); editingRef.current = false; setEditing(false);
    } catch (cause) {
      if (!alive.current || token !== generation.current) return;
      const isConflict = cause instanceof TaskPresentationApiError && cause.status === 409; setConflict(isConflict);
      setError(isConflict ? "标签版本已更新，当前输入已保留。请刷新标签版本，核对后再保存。" : cause instanceof Error ? cause.message : String(cause));
    } finally { savingRef.current = false; if (alive.current && token === generation.current) { setBusy(false); setSaving(false); } }
  }
  return <div className="eng-node-labels" aria-label="步骤内容标签">{!editing ? <><span className="eng-reading-meta">内容标签</span>{labels.map((label) => <span className="eng-content-label" key={label}>{label}</span>)}{!labels.length && <span className="eng-muted">尚未设置</span>}<button type="button" disabled={disabled || busy || !view} onClick={() => { setDraft(labels.join("，")); setBaseLabels([...labels]); setBaseRevision(view!.revision); editingRef.current = true; setEditing(true); setConflict(false); setError(""); setNotice(""); }}>编辑标签</button></> : <><label>步骤内容标签<input value={draft} disabled={busy} placeholder="例如：界面、交互；用逗号分隔" onChange={(event) => setDraft(event.target.value)} /></label><small>最多 12 个标签，每个最多 24 字。仅用于阅读和查找，不改变执行方案或验收条件。</small><div className="eng-inline-actions"><button type="button" disabled={busy} onClick={() => { setDraft(labels.join("，")); editingRef.current = false; setEditing(false); setError(""); setNotice(""); setConflict(false); }}>取消标签修改</button><button type="button" disabled={busy || !dirty || !view || conflict || invalidLabels || disabled} onClick={() => void save()}>保存标签</button></div>{(conflict || notice) && <p className="eng-notice">当前已保存标签：{labels.join("、") || "无"}。{notice}</p>}{invalidLabels && <p role="alert" className="eng-inline-error">请保留最多 12 个标签，且每个不超过 24 字。</p>}{dirty && <span className="eng-reading-meta">标签尚未保存</span>}</>}{error && <div role="alert" className="eng-inline-error">{error}<button type="button" disabled={busy} onClick={() => void load(editing, editing)}>刷新标签版本</button></div>}</div>;
}
