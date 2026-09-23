const labels: Record<string, string> = {
  guarded: "已保护", verified: "已验证", approved: "已批准", accepted: "已接受", supported: "有证据支持",
  draft: "草拟", deferred: "已延期", compiled: "已编译", planning: "规划中", implementing: "执行中",
  reviewing: "审查中", integrating: "集成中", blocked: "已阻塞", failed: "失败", captured: "待评审",
  active: "生效中", at_risk: "有风险", proposed: "待决定"
};

export function StatusMark({ status = "unknown" }: { status?: string }) {
  return <span className={`status-mark status-${status}`}><i />{labels[status] ?? status}</span>;
}
