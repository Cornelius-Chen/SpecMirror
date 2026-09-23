import { useEffect, useState } from "react";
import type { EngineeringHandoffPacket, EngineeringRun } from "@epm/domain";
import type { EngineeringApi } from "../../engineering-api.ts";
import { actionNames, criterionNames, runStatusLabel, timeLabel } from "./shared.ts";
import { FrozenDeliveryContract } from "./FrozenDeliveryContract.tsx";

export function HandoffPanel({ api, run, revision }: { api: EngineeringApi; run: EngineeringRun; revision: number }) {
  const [packet, setPacket] = useState<EngineeringHandoffPacket>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true; setPacket(undefined); setError(""); setCopyMessage("");
    if (!run.handoff) return;
    setLoading(true);
    api.handoff(run.id).then((next) => { if (current) setPacket(next); }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, run.id, run.handoff?.state, revision, retry]);
  const canContinue = packet?.current && ["queued", "running"].includes(run.status);
  const callContext = packet ? { cwd: packet.source_cwd, session_id: packet.owner.replace(/^codex:/, ""), workspace_id: packet.workspace_id, run_id: packet.run_id } : undefined;
  const instructions = packet ? [
    `请在已分配的 Codex 会话中接收 Mirror 步骤：${run.snapshot.node.title}。`,
    `真实来源目录：${packet.source_cwd}；负责人：${packet.owner}。请先通过 SpecMirror 状态工具确认当前 Hook session_id 与 cwd；身份不符时停止，不要冒用交接包的负责人。`,
    `读取此 workspace / node / run 的当前冻结交接包，核对 contract_key=${packet.contract_key}；只领取当前有效版本。领取后若仍排队，等待依赖和资源满足再执行。`,
    "按冻结目标、做法、继承规则、能力版本及动作顺序工作。通过 SpecMirror 工程动作接口提交每项产物，最后提交执行完成；需要变更先提出调整，不改冻结包。人工验收留给工作台。",
    "这里的文件范围限制本次运行目录里的交付文件。源工程代码改动须另附实际变更清单、文件版本与测试证据；交接包不提供操作系统隔离。",
    "确认当前真实身份与上方一致后，依次调用已安装的原生插件工具：",
    `specmirror_engineering_handoff(${JSON.stringify(callContext)})`,
    `specmirror_engineering_claim(${JSON.stringify({ ...callContext, contract_key: packet.contract_key })})`,
    "如果工具未加载或 Hook 尚待信任审核，请报告具体连接状态；不要绕过审核、伪造事件或调用别人的会话。",
    "冻结交接包：", JSON.stringify(packet, null, 2)
  ].join("\n\n") : "";
  async function copy() {
    try { await navigator.clipboard.writeText(instructions); setCopyMessage("交接说明已复制。只有负责人实际领取后，才会更新接单状态。"); }
    catch { setCopyMessage("未能访问剪贴板，请在下方交接说明中全选复制。"); }
  }
  return <section className="eng-section eng-handoff" aria-label="协作交接">
    <div className="eng-section-heading"><h2>交给实际负责人</h2><span>{runStatusLabel(run)}</span></div>
    {!run.handoff ? <p className="eng-notice">这次历史运行没有可核对的领取记录。保留历史证据；继续工作时请按当前方案重新准备交接。</p> : <>
      <p className="eng-muted">{run.handoff.state === "awaiting_claim" ? "已冻结方案，尚无负责人领取回执。复制后交给下方已分配的 Codex 会话；复制不代表 Agent 已收到。" : `负责人已于 ${timeLabel(run.handoff.claimed_at)} 领取。${run.status === "queued" ? "仍在等待依赖或共享资源，尚未执行。" : "后续动作和产出由该负责人提交。"}`}</p>
      <dl className="eng-summary-list"><div><dt>负责人</dt><dd>{run.handoff.owner}</dd></div><div><dt>来源目录</dt><dd>{run.handoff.source_cwd}</dd></div><div><dt>冻结时间</dt><dd>{timeLabel(run.handoff.created_at)}</dd></div></dl>
      {loading && <p role="status" className="eng-muted">正在读取当前冻结交接包…</p>}
      {error && <p role="alert" className="eng-inline-error">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>重试交接包</button></p>}
      {packet && <>
        {!canContinue && <p className="eng-notice">此运行已经结束、暂停或版本失效。下面仅供追溯；继续工作需重新核对当前方案。</p>}
        <p className="eng-muted">冻结文档版本 {packet.document_revision} · 步骤版本 {packet.node_revision}</p>
        <details className="eng-disclosure"><summary>核对冻结目标、做法与验收条件</summary>
          <h3>预期结果</h3><p className="eng-preserve">{packet.objective}</p>
          <FrozenDeliveryContract nodeId={packet.node_id} delivery={packet.delivery} criteria={packet.criteria} lineage={packet.delivery_lineage} />
          <h3>执行思路</h3><p className="eng-preserve">{packet.method || "未填写"}</p>
          <h3>结构与衔接</h3><p className="eng-preserve">{packet.architecture || "未填写"}</p>
          <h3>交付文件范围与继承规则</h3><p>范围相对本次运行的产物目录。源工程改动仍需独立证据核对。</p>
          {packet.constraints.allow_layers.map((layer) => <p key={layer.node_id}>{layer.title}：允许 {layer.patterns.join("、")}</p>)}
          {packet.constraints.deny.map((item, index) => <p key={index}>禁止 {item.pattern} · {item.title}</p>)}
          {packet.constraints.rules.map((item, index) => <p key={index}>{item.text} · {item.title}</p>)}
          <p>共享资源：{packet.constraints.resources.join("、") || "无"}</p>
          {packet.source_scope && <><h3>实际源工程核验</h3><p className="eng-wrap">源目录：{packet.source_scope.root}</p><p>允许改动：{packet.source_scope.allow.join("、")}；禁止：{packet.source_scope.deny.join("、") || "无补充"}</p><p>领取并获得执行位置后采集实际起点；结束时核对变更并执行以下冻结检查。事后核验不提供操作系统隔离。</p>{packet.source_scope.checks.map((check) => <p key={check.id}>{check.title}<br /><code className="eng-wrap">node {check.args.map((arg) => JSON.stringify(arg)).join(" ")}</code></p>)}</>}
          <h3>执行动作</h3><ol>{packet.actions.map((item) => <li key={item.id}>{item.title} · {actionNames[item.type]}<p className="eng-wrap">交付：{item.path || "按关联验收条件核对"}</p></li>)}</ol>
          <h3>选用能力</h3>{packet.capabilities.length ? packet.capabilities.map((item) => <p key={item.id}>{item.id} · 版本 {item.version}<br />用途：{item.purpose}</p>) : <p>此步骤未选用外部能力。</p>}
          <h3>验收条件</h3><ol>{packet.criteria.map((item) => <li key={item.id}>{item.text} · {criterionNames[item.kind]}</li>)}</ol>
        </details>
        {canContinue && <><button type="button" className="eng-primary" onClick={() => void copy()}>复制交接说明与冻结包</button><p className="eng-muted">领取、提交产物和结束执行均由真实负责人完成；界面保留检查与人工验收。</p></>}
        {copyMessage && <p role="status" className="eng-notice">{copyMessage}</p>}
        <details className="eng-disclosure"><summary>{canContinue ? "查看或手动复制完整交接说明" : "查看历史冻结包"}</summary><textarea aria-label="冻结交接说明" readOnly rows={12} value={canContinue ? instructions : JSON.stringify(packet, null, 2)} onFocus={(event) => event.currentTarget.select()} /></details>
      </>}
    </>}
  </section>;
}
