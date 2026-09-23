import type { Page } from "@playwright/test";

/** English presentation of the real isolated UI fixture; product behavior is unchanged. */
export async function installEnglishShowcase(page: Page) {
  await page.evaluate(() => {
    const labels: Record<string, string> = {
      "映": "S", "Mirror 映构": "SpecMirror", "任务工作区": "Task Workspace",
      "计划 · 执行 · 验收": "Plan · Run · Review", "收起任务列表": "Hide tasks",
      "搜索全部任务标题": "Search task titles", "输入任务或成果名称": "Search tasks or results",
      "Codex 运行门禁": "Codex run gate", "历史档案": "Archive", "我的任务": "My tasks",
      "按项目": "By project", "按分类": "By category", "当前": "Current", "归档": "Archive",
      "工程状态": "Project status", "全部状态": "All statuses", "自动": "Auto", "图上讨论隔离测试": "Review at origin · fixture",
      "1 项待验收": "1 awaiting review", "9月6日 08:00": "Sep 6 · 08:00",
      "9月6日 12:00": "Sep 6 · 12:00",
      "项已验收": "accepted", "· 对话有更新": "· conversation updated",
      "本机 Codex ·": "Local Codex ·", "目录": "directory", "已载入": "loaded",
      "项": "items", "· 已读完": "· read", "同步于 08:00:00": "Synced at 08:00",
      "同步于 12:00:00": "Synced at 12:00",
      "isolated-graph-feedback · Codex 任务": "isolated-graph-feedback · Codex task",
      "待完善": "Needs detail", "待分类": "Unclassified", "修改分类": "Edit category",
      "工程地图": "Project map", "原始对话": "Original conversation",
      "工程反馈隔离测试": "Review at origin · fixture", "查找、状态与关系": "Find, status & links",
      "2 处反馈需处理": "2 opinions need attention", "当前层无跨项联系": "No cross-item link in this layer",
      "专注看图": "Focus map", "意见位置": "Opinion location", "记录影响 2 项": "2 affected nodes",
      "已修改，等待你查看": "Changed · awaiting your review", "全图": "Full map",
      "适应区域": "Fit view", "信息": "Detail", "因子发现": "Factor discovery",
      "待分配": "Unassigned", "策略验证": "Strategy check",
      "交付可直接使用并逐项核对的任务成果。": "Deliver inspectable work, reviewed at each node.",
      "下级 1 项待验收": "1 child awaits review",
      "交付包含质量说明的因子结果。": "Deliver factor results with a quality explanation.",
      "成果待查收": "Result awaits review", "在这里讨论": "Discuss here",
      "交付包含质量说明的因子结果": "Deliver factor results with quality context",
      "先写出这一步要执行的具体动作。": "Describe the next concrete action.",
      "继续提意见": "Add opinion", "这里的意见": "Opinions here", "全部意见": "All opinions",
      "因子结果缺少质量说明，请补齐。": "Factor results need a quality explanation.",
      "已修改待查看": "Changed · review pending",
      "已有修订或新交付，仍需核对，尚未关闭。": "A revision or new result exists. Review is still open.",
      "处理依据待核对": "Handling evidence needs review",
      "缺少本轮采用或执行时间依据，暂不能确认当前处理。": "This run lacks adoption or timing proof; current handling is unconfirmed.",
      "查看处理来源": "Inspect source of handling", "本机受控运行": "Controlled local run",
      "运行：": "Run:", "实际交付已关联，等待查看": "Delivered result linked; awaiting review",
      "原意见": "Original opinion", "改动已标图": "Changes mapped", "查收成果": "Review result",
      "改动已标在工程图上": "Changes are marked on the project map",
      "补齐因子质量说明": "Add factor quality explanation", "· 记录影响": "· impact recorded",
      "查看前后": "Compare before/after", "目标": "Objective", "原来": "Before", "现在": "After",
      "打开完整变更记录": "Open full change record", "待查收": "Awaiting review",
      "方案第": "Plan v", "版 ·": " ·", "本次核对": "Current review",
      "已提交1 份成果记录，等待人工查收。": "1 result submitted; human review pending.",
      "打开成果": "Open result", "刷新核对": "Refresh review",
      "查看交付与验收记录": "View delivery and review record",
      "完整处理记录": "Full handling record", "查看依据与高级编辑": "Evidence and advanced edit",
      "本项交接": "Node handoff", "交付约定待补充": "Delivery contract needed",
      "需要什么": "Inputs needed", "输入与来源待说明。": "Inputs and sources not specified.",
      "本项交付": "Node output", "可独立交付的成果待说明。": "Independent output not specified.",
      "交给谁": "Consumers", "尚无其他节点声明使用本项成果。": "No downstream node consumes this output.",
      "全部联系": "All links",
      "细线表示组成；箭头按类型说明交接、开工前提或使用配合。选中节点后，画布只突出它的相关联系。虚线表示真实节点收在分支内。": "Thin lines show composition; arrows show handoffs, prerequisites or collaboration. Select a node to highlight its links. Dashed lines lead into a collapsed branch.",
      "工程尚未声明节点之间的联系。": "No links are declared between these nodes.",
      "图中显示": "Showing", "条相关箭头；全部关系在此逐条可查。": "related arrows; inspect all links here.",
      "定位节点": "Find node", "按名称查找": "Search by name", "工程根": "Project root",
      "共": "Total", "当前查看：": "Viewing:", "查看本项说明与结果": "View this node's brief and result",
      "Codex 本轮": "Current Codex run", "等待真实计划": "Awaiting real plan",
      "轮询更新": "Polling for updates", "任务来源": "Task source",
      "当前 Codex 任务的工程计划、执行和验收均使用此关联。对话阅读记录不改变工程验收状态。": "This link tracks the current Codex task's plan, run and review. Reading a conversation does not accept engineering work.",
      "来源目录": "Source directory", "工程": "Project", "更新时间": "Updated"
    };
    const translate = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const raw = node.textContent ?? "", trimmed = raw.trim();
        if (!/[\u3400-\u9fff]/.test(trimmed)) continue;
        const english = labels[trimmed];
        if (english) node.textContent = raw.replace(trimmed, english);
      }
      for (const element of document.querySelectorAll<HTMLInputElement>("input[placeholder]")) {
        const english = labels[element.placeholder];
        if (english) element.placeholder = english;
      }
    };
    translate();
    new MutationObserver(translate).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

export async function untranslatedVisibleText(page: Page) {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = new Set<string>(); let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim(), element = node.parentElement;
      if (text && /[\u3400-\u9fff]/.test(text) && element && element.getClientRects().length) found.add(text);
    }
    for (const input of document.querySelectorAll<HTMLInputElement>("input[placeholder]")) {
      if (/[\u3400-\u9fff]/.test(input.placeholder) && input.getClientRects().length) found.add(input.placeholder);
    }
    return [...found];
  });
}
