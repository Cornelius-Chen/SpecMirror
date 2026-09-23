import type { EngineeringNode, EngineeringRun, EngineeringView } from "@epm/domain";

export const statusNames: Record<string, string> = { draft: "待完善", ready: "可执行", running: "执行中", review: "待验收", accepted: "已验收", blocked: "受阻", paused: "已暂停", needs_revision: "需修改", archived: "已归档", queued: "排队中", rejected: "未通过", stale: "方案已变更" };
export const kindNames = { project: "项目", task: "任务", step: "步骤" };
export const criterionNames = { manual: "人工核对", file_exists: "文件已生成", file_contains: "文件包含指定内容", json_valid: "JSON 格式有效" };
export const actionNames = { write_file: "写入确定的内容", agent_artifact: "由 Agent 生成交付成果", check_file: "核对验收条件", use_capability: "应用 Jervis 能力" };
export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const lines = (value: string) => value.split("\n");
export const timeLabel = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
export const ordered = (nodes: EngineeringNode[]) => [...nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export const runStatusLabel = (run: EngineeringRun) => run.mode === "external" && run.status === "queued" ? run.handoff?.state === "awaiting_claim" ? "待负责人领取" : run.handoff?.state === "claimed" ? "已领取，等待执行条件" : "交接记录待核对" : statusNames[run.status];
export const currentNodeRun = (view: EngineeringView, id: string) => view.document.runs.find((run) => run.id === view.derived[id]?.latest_run_id);
export const nodeStatusLabel = (view: EngineeringView, node: EngineeringNode) => { const run = currentNodeRun(view, node.id); return run?.status === "queued" ? runStatusLabel(run) : statusNames[view.derived[node.id]?.status ?? node.status]; };
