import type { EngineeringCriterion, EngineeringDeliveryContract, EngineeringSnapshot } from "@epm/domain";
import "./frozen-delivery-contract.css";

interface Props {
  nodeId: string;
  delivery?: EngineeringDeliveryContract;
  criteria: EngineeringCriterion[];
  lineage?: EngineeringSnapshot["delivery_lineage"];
}

/** Only frozen values enter this view; names and criteria are never read from the current plan. */
export function FrozenDeliveryContract({ nodeId, delivery, criteria, lineage }: Props) {
  const inherited = (lineage ?? []).filter(layer => layer.node_id !== nodeId);
  const criterionText = new Map(criteria.map(criterion => [criterion.id, criterion.text]));
  return <div className="eng-frozen-delivery" aria-label="冻结交付约定">
    <h3>本次交付约定</h3>
    <p className="eng-muted">以下内容保留冻结时的要求。业务范围仍须结合实际产物核对；有约定不代表已经执行或验收通过。</p>
    {delivery ? <>
      <div className="eng-frozen-boundaries"><div><h4>负责什么</h4><FrozenLines values={delivery.included} empty="本次冻结记录未说明负责范围。" /></div><div><h4>不做什么</h4><FrozenLines values={delivery.excluded} empty="本次冻结记录未说明排除范围。" /></div></div>
      <h4>交付什么</h4>
      {delivery.outputs.length ? <ul className="eng-frozen-results">{delivery.outputs.map((output, index) => <li key={output.id}>
        <strong>{output.title.trim() || `成果 ${index + 1}（未命名）`}</strong>
        <span className="eng-muted">对应的完成条件</span>
        {output.criterion_ids.length ? <ul>{output.criterion_ids.map(id => <li key={id}>{criterionText.get(id) || "此冻结记录未保留对应的完成条件。"}</li>)}</ul> : <p className="eng-muted">本次冻结记录没有关联完成条件。</p>}
      </li>)}</ul> : <p className="eng-muted">本次冻结记录未声明交付成果。</p>}
      <h4>需要什么</h4>
      {delivery.inputs.length ? <ul className="eng-frozen-inputs">{delivery.inputs.map((input, index) => <li key={input.id}>
        <strong>{input.title.trim() || `输入 ${index + 1}（未命名）`}</strong>
        {input.source_node_id ? <><p>来源：工程内的交付成果。</p><details><summary>查看冻结来源标识</summary><p>提供方：<code>{input.source_node_id}</code></p><p>具体成果：<code>{input.source_output_id || "未记录"}</code></p></details></> : <p>外部来源：{input.external_source.trim() || "本次冻结记录未说明来源。"}</p>}
      </li>)}</ul> : <p className="eng-muted">本次冻结记录未声明输入。</p>}
    </> : <p className="eng-muted">这次历史运行没有单独记录交付约定；不使用当前方案补写历史。</p>}
    <h3>继承的业务边界</h3>
    {inherited.length ? <div className="eng-frozen-inherited">{inherited.map(layer => <div key={layer.node_id}>
      <h4>{layer.title}</h4><div className="eng-frozen-boundaries"><div><strong>上级负责范围</strong><FrozenLines values={layer.delivery.included} empty="未记录" /></div><div><strong>上级排除范围</strong><FrozenLines values={layer.delivery.excluded} empty="未记录" /></div></div>
    </div>)}</div> : <p className="eng-muted">本次冻结记录没有上级业务边界。</p>}
  </div>;
}

function FrozenLines({ values, empty }: { values: string[]; empty: string }) {
  const visible = values.filter(value => value.trim());
  return visible.length ? <ul>{visible.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="eng-muted">{empty}</p>;
}
