import { useMemo, useState } from "react";
import type { EngineeringView } from "@epm/domain";
import type { EngineeringFeedbackTarget } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { projectDeliveryRelations } from "./delivery-selectors.ts";
import { engineeringNodeName } from "../engineering/node-names.ts";

const kindLabels = { input: "成果交接", prerequisite: "开工前提", interaction: "使用时配合", dependency: "旧方案前置" };
export function NodeRelationsPanel({ view, nodeId, nodeNames, onEdit, onFeedback, onNavigate }: { view: EngineeringView; nodeId: string; nodeNames?: Record<string, string>; onEdit: (nodeId: string, field: string) => void; onFeedback?: (target: EngineeringFeedbackTarget) => void; onNavigate: (id: string) => void }) {
  const relations = useMemo(() => projectDeliveryRelations(view, view.document.nodes.map(item => item.id)).filter(item => item.sourceNodeId === nodeId || item.targetNodeId === nodeId), [view, nodeId]);
  const [selectedId, setSelectedId] = useState("");
  const selected = relations.find(item => item.id === selectedId);
  const name = (id: string) => { const node = view.document.nodes.find(item => item.id === id); return node ? engineeringNodeName(node, nodeNames) : "端点待核对"; };
  return <section className="pni-relations" aria-label="本项关键联系"><header><h3>本项关键联系 <span>{relations.length}</span></h3><button type="button" onClick={() => onEdit(nodeId, "relations")}>添加或调整联系</button></header>{!relations.length ? <p className="pni-helper">本项尚未声明跨节点联系；不能据此推断它与其他部分无关。</p> : <><div className="pni-relation-choices">{relations.map(item => <button type="button" key={item.id} aria-pressed={selectedId === item.id} data-relation-kind={item.kind} onClick={() => setSelectedId(selectedId === item.id ? "" : item.id)}><small>{kindLabels[item.kind]}</small><span>{name(item.sourceNodeId)} → {name(item.targetNodeId)}</span><strong>{item.label}</strong></button>)}</div>{selected && <div className="pni-relation-detail" data-selected-relation={selected.relationId}><h4>{kindLabels[selected.kind]} · {selected.label}</h4><p>{selected.detail}</p><p className="pni-helper">{selected.kind === "interaction" ? "这条联系说明使用时的配合，不自动形成开工等待。" : "这条关系影响执行前提；修改后应核对相关成果与运行。"}</p>{selected.problem && <p className="pni-delivery-issue">{selected.problem}</p>}<div className="pni-local-actions"><button type="button" onClick={() => onNavigate(selected.sourceNodeId)}>查看来源</button><button type="button" onClick={() => onNavigate(selected.targetNodeId)}>查看接收方</button><button type="button" onClick={() => onEdit(selected.ownerNodeId, selected.relationId)}>修改这条联系</button>{onFeedback && <button type="button" onClick={() => onFeedback({ kind: "relation", node_id: selected.ownerNodeId, id: selected.relationId })}>反馈这条联系</button>}</div></div>}</>}</section>;
}
