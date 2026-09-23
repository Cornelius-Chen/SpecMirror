import type { EngineeringRun, FrozenEngineeringSourceScope, EngineeringSourceBaseline, EngineeringSourceProof } from "@epm/domain";
import { timeLabel } from "./shared.ts";

const changeNames = { added: "新增", modified: "修改", deleted: "删除" };
const reasonNames = { allowed: "在允许范围内", denied: "触及禁止范围", outside_allow: "超出允许范围" };
const exclusionNames = { git_ignored: "Git 忽略文件", generated_or_runtime: "生成文件或运行资料", external_project_reference: "已注册的外部工程引用" };
const checkNames = { passed: "通过", failed: "失败", timeout: "超时", output_limit: "输出超限", spawn_error: "未能启动", not_run: "尚未执行", cancelled: "已取消" };
type IntegrationSourceRun = EngineeringRun & { source_integration_scopes?: FrozenEngineeringSourceScope[]; source_integration_baselines?: EngineeringSourceBaseline[]; source_integration_proofs?: EngineeringSourceProof[] };
export function SourceProofPanel({ run }: { run: IntegrationSourceRun }) {
  const scopes = run.source_integration_scopes ?? run.source_integration_baselines?.map((item) => item.scope) ?? [];
  return <>
    {run.source_scope && <SourceProofScope scope={run.source_scope} baseline={run.source_baseline} proof={run.source_proof} />}
    {scopes.length > 0 && <section className="eng-section eng-source-integration" aria-label="组合源码检查"><h2>组合源码检查</h2><p className="eng-muted">按本次整合使用的源工程重新执行检查，核对组合后的当前文件。已有步骤的通过结果继续保留，本次整合仍需独立检查与人工验收。</p>{scopes.map((scope, index) => <SourceProofScope key={`${scope.root}:${scope.contract_sha256}`} scope={scope} baseline={run.source_integration_baselines?.find((item) => item.scope.root === scope.root && item.scope.contract_sha256 === scope.contract_sha256)} proof={run.source_integration_proofs?.find((item) => item.root === scope.root && item.contract_sha256 === scope.contract_sha256)} integration={index + 1} />)}</section>}
  </>;
}
function SourceProofScope({ scope, baseline, proof, integration }: { scope: FrozenEngineeringSourceScope; baseline?: EngineeringSourceBaseline; proof?: EngineeringSourceProof; integration?: number }) {
  const title = integration ? `组合源码检查来源 ${integration}` : "源工程改动与实际检查";
  return <section className="eng-section eng-source-proof" aria-label={title}>
    <div className="eng-section-heading"><h2>{title}</h2><span>{proof ? proof.passed ? "检查通过，仍需核对验收" : "源工程核验未通过" : "等待实际核验"}</span></div>
    <p className="eng-muted">核对真实源目录的前后文件与冻结命令结果。此处为事后核验，不提供操作系统隔离；交付文件另在本次运行目录校验。</p>
    <dl className="eng-summary-list"><div><dt>源工程</dt><dd>{scope.root}</dd></div><div><dt>允许改动</dt><dd>{scope.allow.join("、")}</dd></div><div><dt>禁止改动</dt><dd>{scope.deny.join("、") || "无补充"}</dd></div></dl>
    {!baseline && <p className="eng-notice">{integration ? "尚未记录整合起点。调度器获得源目录核验位置后才采集；当前尚无组合检查结果。" : "尚未记录执行起点。真实负责人领取并获得源目录执行位置后才采集；当前不能认定源工程已经开始修改。"}</p>}
    {baseline && <details className="eng-disclosure"><summary>核对本次真实执行起点</summary><p>记录于 {timeLabel(baseline.captured_at)} · {baseline.manifest.length} 个源文件 · {baseline.total_bytes} 字节</p><p className="eng-wrap">Git 起点：{baseline.git.repository ? baseline.git.head_sha || "仓库尚无提交" : "此目录不是 Git 仓库，使用实际文件摘要"}</p><p className="eng-wrap">文件清单摘要：{baseline.manifest_sha256}</p>
      <h3>执行前已存在的改动</h3><p>{integration ? "以下改动在本次整合前已存在，保留供核对组合输入。" : "以下改动在领取时已存在，不自动归属于本次 Agent。"}</p>{baseline.git.preexisting_changes.length ? <ul>{baseline.git.preexisting_changes.map((item, index) => <li key={index}><code>{item.path}</code> · {item.status}</li>)}</ul> : <p>未记录到 Git 既有改动。</p>}
    </details>}
    {!proof && <div className="eng-empty-inline"><p>{baseline ? integration ? "已保存整合起点，等待实际组合检查完成。" : "已保存起点，等待负责人提交完成后进行实际检查。" : "还没有可验收的源工程证据。"}</p><h3>冻结的检查命令</h3>{scope.checks.map((check) => <details key={check.id}><summary>{check.title}</summary><code className="eng-wrap">node {check.args.map((arg) => JSON.stringify(arg)).join(" ")}</code><p>超时 {check.timeout_ms ?? 30000} 毫秒</p></details>)}</div>}
    {proof && <>
      <p className={proof.passed ? "eng-success-text" : "eng-inline-error"}>{proof.passed ? "源文件范围与实际检查通过，仍按当前人工条件决定验收。" : "源文件范围或实际检查未通过，不能沿用这次结果完成验收。"} · {timeLabel(proof.verified_at)}</p>
      {proof.error && <p className="eng-notice">{proof.error}</p>}{proof.source_changed_during_checks && <p className="eng-notice">检查过程中源文件发生变化，需要重新核对执行起点与结果。</p>}
      <h3>本次实际文件变更 · {proof.changes.length} 项</h3>{proof.changes.length ? <div className="eng-source-changes">{proof.changes.map((item) => <div className="eng-source-change" key={item.path}><strong className={item.allowed ? "eng-success-text" : "eng-inline-error"}>{changeNames[item.kind]} · {reasonNames[item.reason]}</strong><code className="eng-wrap">{item.path}</code><details><summary>前后文件摘要</summary><p className="eng-wrap">之前：{item.before_sha256 || "文件不存在"}</p><p className="eng-wrap">之后：{item.after_sha256 || "文件已删除"}</p></details></div>)}</div> : <p className="eng-muted">未发现纳入清单的源文件变化；是否满足目标仍需按实际验收条件核对。</p>}
      <h3>实际检查结果</h3>{proof.checks.map((check) => <div className="eng-source-check" key={check.id}><div className="eng-section-heading"><strong>{check.title}</strong><b className={check.status === "passed" ? "eng-success-text" : "eng-inline-error"}>{checkNames[check.status]}</b></div><p>退出状态 {check.exit_code ?? "未返回"} · 耗时 {check.duration_ms} 毫秒</p>{check.error && <p className="eng-notice">{check.error}</p>}<details><summary>核对实际命令与输出摘要</summary><code className="eng-wrap">node {check.args.map((arg) => JSON.stringify(arg)).join(" ")}</code><p className="eng-wrap">命令摘要：{check.command_sha256}</p><p className="eng-wrap">输出摘要：{check.output_sha256} · {check.output_bytes} 字节</p></details></div>)}
      <details className="eng-disclosure"><summary>本次核验范围与排除项</summary><p>清单使用以下排除规则，不能将排除文件视为已经核验。</p><ul>{proof.exclusion_rules.map((rule, index) => <li key={index}><code>{rule}</code></li>)}</ul>{proof.exclusions.map((item, index) => <p key={index}><code>{item.path}</code> · {exclusionNames[item.reason]}</p>)}<p className="eng-wrap">起点摘要：{proof.baseline_manifest_sha256}</p><p className="eng-wrap">结束摘要：{proof.final_manifest_sha256 || "未完成清单核验"}</p></details>
    </>}
  </section>;
}
