import { engineeringCompositionCoverage, engineeringCompositionIssues, type EngineeringNode, type EngineeringView } from "@epm/domain";
import { engineeringNodeName } from "./node-names.ts";

export function CompositionEditor({ node, view, nodeNames, onChange }: { node: EngineeringNode; view: EngineeringView; nodeNames?: Record<string, string>; onChange: (node: EngineeringNode) => void }) {
  const children = view.document.nodes.filter(item => item.parent_id === node.id && item.status !== "archived");
  const composed = node.composition;
  const document = { ...view.document, nodes: view.document.nodes.map(item => item.id === node.id ? node : item) };
  const issues = engineeringCompositionIssues(document, node.id);
  const coverage = engineeringCompositionCoverage(document, node.id);
  const update = (patch: Partial<NonNullable<EngineeringNode["composition"]>>) => onChange({ ...node, composition: { summary: "", scenario: "", integration_criterion_ids: [], ...composed, ...patch } });
  return <>
    {node.parent_id && <section className="eng-section"><h2>本项为什么需要</h2><label>具体贡献<textarea rows={2} value={node.contribution?.summary ?? ""} placeholder="说明交出什么，以及它怎样帮助上级完成目标。" onChange={event => onChange({ ...node, contribution: { summary: event.target.value } })} /></label><p className="eng-muted">对应的上级完成条件在「为上级目标贡献什么」中选择。</p></section>}
    {children.length > 0 && <section className="eng-section" data-edit-target="composition"><div className="eng-section-heading"><h2>这些部分怎样组成整体</h2>{!composed && <button type="button" onClick={() => update({})}>补充组合说明</button>}</div>{!composed ? <p className="eng-muted">先说明各块怎样配合、父级负责什么，再判断拆分是否完整。旧方案可以继续查阅；补充后按新约定核对。</p> : <>
      <label>组合说明<textarea rows={3} value={composed.summary} onChange={event => update({ summary: event.target.value })} placeholder="例如：数据提供统一输入，报告形成结论，说明交代使用范围，父级负责整套交付。" /></label>
      <label>完整使用场景<textarea rows={3} value={composed.scenario} onChange={event => update({ scenario: event.target.value })} placeholder="从用户开始使用到获得最终结果，怎样核对这些成果确实配合成功？" /></label>
      <fieldset className="eng-delivery-criteria"><legend>由本层整合负责的完成条件</legend>{node.criteria.map(criterion => <label className="eng-check-row" key={criterion.id}><input type="checkbox" checked={composed.integration_criterion_ids.includes(criterion.id)} onChange={() => update({ integration_criterion_ids: composed.integration_criterion_ids.includes(criterion.id) ? composed.integration_criterion_ids.filter(id => id !== criterion.id) : [...composed.integration_criterion_ids, criterion.id] })} /><span>{criterion.text}</span></label>)}</fieldset>
      <details className="eng-disclosure"><summary>核对成果分工（{coverage.filter(item => !item.covered).length} 项尚无承接）</summary>{coverage.map(item => <div key={item.criterion_id} className="eng-linked-row"><strong>{node.criteria.find(criterion => criterion.id === item.criterion_id)?.text}</strong><span>{item.child_ids.map(id => { const child = children.find(candidate => candidate.id === id); return child ? engineeringNodeName(child, nodeNames) : id; }).concat(item.integration ? ["本层整合"] : []).join("、") || "尚无承接"}</span></div>)}<p className="eng-muted">覆盖检查只核对分工引用。多个子项共同承担时，还需说明各自贡献；拆分是否充分、组合是否可用须另行核对。</p>{issues.map((issue, index) => <p className="eng-notice" key={index}>{issue}</p>)}</details>
    </>}</section>}
  </>;
}
