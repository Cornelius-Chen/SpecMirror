import { useState } from "react";
import { engineeringDeliveryIssues, type EngineeringDeliveryContract, type EngineeringNode, type EngineeringView } from "@epm/domain";
import { engineeringNodeName } from "./node-names.ts";
import { lines, newId } from "./shared.ts";
import { removeEngineeringCriterion } from "./workspace-state.ts";
import "./delivery-contract-editor.css";

export const emptyDeliveryContract = (): EngineeringDeliveryContract => ({ included: [], excluded: [], outputs: [], inputs: [] });

/** A deliverable cannot wait on its own parent, descendants, or itself. */
export function deliverySourceNodes(nodes: EngineeringNode[], node: EngineeringNode): EngineeringNode[] {
  const byId = new Map(nodes.map(item => [item.id, item]));
  byId.set(node.id, node);
  const ancestors = new Set<string>();
  let parent = node.parent_id;
  while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = byId.get(parent)?.parent_id ?? null; }
  return nodes.filter(candidate => {
    if (candidate.status === "archived" || candidate.id === node.id || ancestors.has(candidate.id)) return false;
    const visited = new Set<string>();
    let next = candidate.parent_id;
    while (next && !visited.has(next)) {
      if (next === node.id) return false;
      visited.add(next); next = byId.get(next)?.parent_id ?? null;
    }
    return true;
  });
}

function deliveryRequired(nodes: EngineeringNode[], node: EngineeringNode): boolean {
  const byId = new Map(nodes.map(item => [item.id, item]));
  const visited = new Set<string>();
  let current: EngineeringNode | undefined = node;
  while (current && !visited.has(current.id)) {
    if (current.delivery) return true;
    visited.add(current.id); current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return false;
}

interface Props {
  node: EngineeringNode; view: EngineeringView; nodeNames?: Record<string, string>;
  onChange: (node: EngineeringNode) => void;
}

export function DeliveryContractEditor({ node, view, nodeNames, onChange }: Props) {
  const [sourceModes, setSourceModes] = useState<Record<string, "node" | "external">>({});
  const [notice, setNotice] = useState("");
  const required = deliveryRequired(view.document.nodes, node);
  if (!node.delivery && !required) return <section className="eng-section eng-delivery-intro">
    <div className="eng-section-heading"><h2>交付约定</h2><button type="button" onClick={() => onChange({ ...node, delivery: emptyDeliveryContract() })}>补充交付约定</button></div>
    <p className="eng-muted">明确这项成果的范围、输入和完成条件。补充后，下级也需要各自的交付约定；可先保存草稿，再逐步完善。</p>
  </section>;

  const delivery = node.delivery ?? emptyDeliveryContract();
  const change = (patch: Partial<EngineeringDeliveryContract>, extra: Partial<EngineeringNode> = {}) => onChange({ ...node, ...extra, delivery: { ...delivery, ...patch } });
  const name = (item: EngineeringNode) => engineeringNodeName(item, nodeNames);
  const sources = deliverySourceNodes(view.document.nodes, node);
  const document = { ...view.document, nodes: view.document.nodes.map(item => item.id === node.id ? { ...node, delivery } : item) };
  const issues = engineeringDeliveryIssues(document, node.id);
  const sourceName = (id: string) => { const item = view.document.nodes.find(candidate => candidate.id === id); return item ? name(item) : "来源任务已不存在"; };
  const updateInput = (id: string, patch: Partial<EngineeringDeliveryContract["inputs"][number]>) => {
    const previous = delivery.inputs.find(input => input.id === id);
    const inputs = delivery.inputs.map(input => input.id === id ? { ...input, ...patch } : input);
    const next = inputs.find(input => input.id === id)!;
    if (previous?.source_node_id && previous.source_node_id !== next.source_node_id && node.dependencies.includes(previous.source_node_id)) {
      setNotice(`输入来源已改变，仍保留对「${sourceName(previous.source_node_id)}」的前置依赖。若已不再需要，请在下方「其他前置依赖」中移除。`);
    } else if (next.source_node_id) {
      setNotice(`本项将等待「${sourceName(next.source_node_id)}」的有效验收成果；等待来自这条输入，不重复加入其他前置依赖。`);
    }
    change({ inputs });
  };
  const removeInput = (id: string) => {
    const previous = delivery.inputs.find(input => input.id === id);
    if (previous?.source_node_id && node.dependencies.includes(previous.source_node_id)) setNotice(`已移除这项输入，仍保留对「${sourceName(previous.source_node_id)}」的前置依赖。若已不再需要，请在下方「其他前置依赖」中移除。`);
    change({ inputs: delivery.inputs.filter(input => input.id !== id) });
  };

  return <div className="eng-delivery-editor">
    <section className="eng-section eng-delivery-overview">
      <div className="eng-section-heading"><h2>这项成果的交付约定</h2><span>{issues.length ? "仍有待补充内容" : "约定已齐备 · 尚需执行与验收"}</span></div>
      <p className="eng-muted">能明确分工、独立交付并独立验收，就可以停在这一层。内部操作放在执行记录中。</p>
      {issues.length > 0 && <details className="eng-disclosure eng-delivery-issues"><summary>查看待补充内容（{issues.length} 项）</summary><ul>{issues.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul><p className="eng-muted">可以保存草稿。约定齐备只说明具备明确的边界和交接条件，不代表成果已经完成。</p></details>}
      <div className="eng-field-row">
        <label>负责什么<textarea rows={3} value={delivery.included.join("\n")} placeholder="每行一项，例如：生成指定因子的历史评估报告。" onChange={event => change({ included: lines(event.target.value) })} /></label>
        <label>不做什么<textarea rows={3} value={delivery.excluded.join("\n")} placeholder="每行一项，例如：不负责策略组合和真实交易。" onChange={event => change({ excluded: lines(event.target.value) })} /><small>没有额外排除项时可勾选下方确认，仍继承上级的约束。</small></label>
      </div>
      <label className="eng-check-row"><input type="checkbox" checked={delivery.no_extra_exclusions ?? false} onChange={event => change({ no_extra_exclusions: event.target.checked })} /><span>没有额外排除项，沿用上级边界</span></label>
    </section>

    <section className="eng-section">
      <div className="eng-section-heading"><h2>交付什么</h2><button type="button" onClick={() => change({ outputs: [...delivery.outputs, { id: newId("output"), title: "", criterion_ids: [] }] })}>＋ 添加成果</button></div>
      <p className="eng-muted">写出完成后可以使用或查收的东西，并勾选它要满足的完成条件。</p>
      {!delivery.outputs.length && <p className="eng-empty-inline">尚未声明交付成果。</p>}
      {delivery.outputs.map((output, index) => {
        const consumers = view.document.nodes.filter(item => item.status !== "archived" && item.delivery?.inputs.some(input => input.source_node_id === node.id && input.source_output_id === output.id));
        return <div className="eng-edit-item eng-delivery-output" key={output.id}>
          <div className="eng-item-heading"><strong>成果 {index + 1}</strong><button type="button" aria-label={`删除成果 ${index + 1}`} onClick={() => { if (consumers.length) setNotice(`已从草稿删除「${output.title || `成果 ${index + 1}`}」。「${consumers.map(name).join("、")}」仍在引用它；请先调整这些任务的输入，才能保存删除。`); change({ outputs: delivery.outputs.filter(item => item.id !== output.id) }); }}>删除</button></div>
          <label>成果名称<input value={output.title} placeholder="例如：单因子评估报告" onChange={event => change({ outputs: delivery.outputs.map(item => item.id === output.id ? { ...item, title: event.target.value } : item) })} /></label>
          <fieldset className="eng-delivery-criteria"><legend>满足哪些完成条件</legend>{node.criteria.length ? node.criteria.map((criterion, criterionIndex) => <label className="eng-check-row" key={criterion.id}><input type="checkbox" checked={output.criterion_ids.includes(criterion.id)} onChange={() => change({ outputs: delivery.outputs.map(item => item.id === output.id ? { ...item, criterion_ids: item.criterion_ids.includes(criterion.id) ? item.criterion_ids.filter(id => id !== criterion.id) : [...item.criterion_ids, criterion.id] } : item) })} /><span>{criterion.text || `完成条件 ${criterionIndex + 1}（待填写）`}</span></label>) : <p className="eng-muted">先在下方「怎样完成」添加条件，再关联到这项成果。</p>}</fieldset>
          {consumers.length > 0 && <p className="eng-muted">交给：{consumers.map(name).join("、")}。调整成果会影响这些任务。</p>}
        </div>;
      })}
    </section>

    <section className="eng-section">
      <div className="eng-section-heading"><h2>需要什么</h2><button type="button" onClick={() => change({ inputs: [...delivery.inputs, { id: newId("input"), title: "", source_node_id: null, source_output_id: "", external_source: "" }] })}>＋ 添加输入</button></div>
      <p className="eng-muted">需要其他子项目的成果时，选择具体来源；已有资料则说明外部来源。不依赖任何输入的工作可留空。</p>
      {notice && <p className="eng-notice eng-delivery-notice" role="status">{notice}</p>}
      {!delivery.inputs.length && <p className="eng-empty-inline">尚未声明输入。{node.dependencies.length ? "已有前置依赖，请说明需要它们提供什么。" : "确认本项可独立开始后，可以保持为空。"}</p>}
      {delivery.inputs.map((input, index) => {
        const mode = sourceModes[input.id] ?? (input.external_source ? "external" : "node");
        const source = sources.find(item => item.id === input.source_node_id);
        return <div className="eng-edit-item eng-delivery-input" key={input.id} data-edit-target={`input:${input.id}`}>
          <div className="eng-item-heading"><strong>输入 {index + 1}</strong><button type="button" aria-label={`删除输入 ${index + 1}`} onClick={() => removeInput(input.id)}>删除</button></div>
          <label>需要的内容<input value={input.title} placeholder="例如：指定日期范围的历史行情" onChange={event => updateInput(input.id, { title: event.target.value })} /></label>
          <label>来源类型<select value={mode} onChange={event => { setSourceModes(current => ({ ...current, [input.id]: event.target.value as "node" | "external" })); updateInput(input.id, { source_node_id: null, source_output_id: "", external_source: "" }); }}><option value="node">工程内的交付成果</option><option value="external">工程外的已有资料</option></select></label>
          {mode === "node" ? <div className="eng-field-row">
            <label>来自哪个子项目<select value={input.source_node_id ?? ""} onChange={event => updateInput(input.id, { source_node_id: event.target.value || null, source_output_id: "", external_source: "" })}><option value="">选择提供成果的子项目…</option>{input.source_node_id && !source && <option value={input.source_node_id} disabled>{sourceName(input.source_node_id)}（来源不可用）</option>}{sources.map(item => <option key={item.id} value={item.id} disabled={!item.delivery?.outputs.length}>{name(item)}{!item.delivery?.outputs.length ? "（尚无交付成果）" : ""}</option>)}</select></label>
            <label>使用哪项成果<select value={input.source_output_id} disabled={!source?.delivery?.outputs.length} onChange={event => updateInput(input.id, { source_output_id: event.target.value })}><option value="">选择具体成果…</option>{input.source_output_id && !source?.delivery?.outputs.some(output => output.id === input.source_output_id) && <option value={input.source_output_id} disabled>原成果已不可用</option>}{source?.delivery?.outputs.map((output, outputIndex) => <option key={output.id} value={output.id} disabled={!output.title.trim()}>{output.title || `成果 ${outputIndex + 1}（待命名）`}</option>)}</select></label>
          </div> : <label>外部来源<textarea rows={2} value={input.external_source} placeholder="说明由谁提供、资料名称或可核对的来源位置。" onChange={event => updateInput(input.id, { external_source: event.target.value, source_node_id: null, source_output_id: "" })} /></label>}
        </div>;
      })}
    </section>

    <section className="eng-section eng-delivery-completion">
      <div className="eng-section-heading"><h2>怎样完成</h2><button type="button" onClick={() => onChange({ ...node, delivery, criteria: [...node.criteria, { id: newId("criterion"), text: "", kind: "manual", path: "", expected: "" }] })}>＋ 添加完成条件</button></div>
      <p className="eng-muted">写出查收时能逐项核对的结果。这里与「验收条件」共用同一份要求；自动核对方式可在该页配置。父级整体验收仍需单独进行。</p>
      {!node.criteria.length && <p className="eng-empty-inline">至少明确一条可核对的完成条件。</p>}
      {node.criteria.map((criterion, index) => <div className="eng-edit-item" key={criterion.id} data-edit-target={`criterion:${criterion.id}`}>
        <div className="eng-item-heading"><strong>条件 {index + 1}</strong><button type="button" aria-label={`删除完成条件 ${index + 1}`} onClick={() => onChange(removeEngineeringCriterion({ ...node, delivery }, criterion.id))}>删除</button></div>
        <label>完成条件 {index + 1}<textarea rows={2} value={criterion.text} placeholder="例如：使用同一批输入可复现报告，并说明结果的适用范围。" onChange={event => onChange({ ...node, delivery, criteria: node.criteria.map(item => item.id === criterion.id ? { ...item, text: event.target.value } : item) })} /></label>
      </div>)}
    </section>
  </div>;
}
