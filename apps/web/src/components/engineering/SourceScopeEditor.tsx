import type { EngineeringNode, EngineeringSourceScope } from "@epm/domain";
import { newId } from "./shared.ts";

export function SourceScopeEditor({ node, hasChildren, onChange }: { node: EngineeringNode; hasChildren: boolean; onChange: (node: EngineeringNode) => void }) {
  const scope = node.source_scope;
  const change = (patch: Partial<EngineeringSourceScope>) => { if (scope) onChange({ ...node, source_scope: { ...scope, ...patch } }); };
  return <details className="eng-disclosure eng-source-editor"><summary>实际源工程改动核验{scope ? " · 已启用" : " · 可选"}</summary>
    <p>用于实际修改代码的协作步骤。领取并获得源目录执行位置后记录起点，结束时核对实际文件改动并运行冻结的检查命令。它是事后核验，不是操作系统隔离。</p>
    {hasChildren && !scope ? <p className="eng-notice">请选择具体的末级步骤配置。上级任务通过各步骤的证据进行整合验收。</p> : <>
      <label className="eng-check-row"><input type="checkbox" checked={!!scope} onChange={(event) => onChange({ ...node, source_scope: event.target.checked ? { root: "", allow: [], deny: [], checks: [] } : undefined })} /><span>记录并检查源工程改动</span></label>
      {scope && <>
        <label>实际源工程目录<input value={scope.root} placeholder="填写当前任务已授权的绝对目录" onChange={(event) => change({ root: event.target.value })} /></label>
        <small>源目录与交付文件目录分别核验；只能使用当前工作区已授权的源目录。</small>
        <label>允许改动的源文件范围<textarea rows={3} value={scope.allow.join("\n")} placeholder="每行一个相对源目录的规则，例如 src/**" onChange={(event) => change({ allow: event.target.value.split("\n") })} /></label>
        <label>禁止改动的源文件范围<textarea rows={2} value={scope.deny.join("\n")} placeholder="例如 src/protected/**" onChange={(event) => change({ deny: event.target.value.split("\n") })} /></label>
        <p className="eng-notice">同一或嵌套源目录的修改需依次推进，直到上一运行完成人工验收再释放，避免把其他 Agent 的改动误归到本次运行。</p>
        <div className="eng-section-heading"><h3>结束时实际运行的检查</h3><button type="button" disabled={scope.checks.length >= 12} onClick={() => change({ checks: [...scope.checks, { id: newId("source-check"), title: "", program: "node", args: [], timeout_ms: 30000 }] })}>添加源工程检查</button></div>
        <p>至少配置一条真实 Node 检查。参数逐行传入，不经 Shell 拼接；命令会在源工程目录实际执行，保存前请核对用途。</p>
        {scope.checks.map((check, index) => <div className="eng-edit-item" key={check.id}>
          <div className="eng-item-heading"><strong>源工程检查 {index + 1}</strong><button type="button" aria-label={`删除源工程检查 ${index + 1}`} onClick={() => change({ checks: scope.checks.filter((item) => item.id !== check.id) })}>删除</button></div>
          <label>检查用途<input value={check.title} onChange={(event) => change({ checks: scope.checks.map((item) => item.id === check.id ? { ...item, title: event.target.value } : item) })} placeholder="例如：验证当前步骤的服务回归" /></label>
          <label>Node 参数（每行一个）<textarea rows={4} value={check.args.join("\n")} placeholder={'--test\ntests/current-step.test.mjs'} onChange={(event) => change({ checks: scope.checks.map((item) => item.id === check.id ? { ...item, args: event.target.value.split("\n") } : item) })} /></label>
          <label>检查超时（毫秒）<input type="number" min={20} max={120000} value={check.timeout_ms ?? 30000} onChange={(event) => change({ checks: scope.checks.map((item) => item.id === check.id ? { ...item, timeout_ms: Number(event.target.value) } : item) })} /></label>
        </div>)}
      </>}
    </>}
  </details>;
}
