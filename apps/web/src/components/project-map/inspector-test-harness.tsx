// Isolated Playwright entry point. This module is never imported by the application.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { EngineeringView } from "@epm/domain";
import { ProjectNodeInspector } from "./ProjectNodeInspector.tsx";
import { inspectorScenario } from "../../../../../tests/fixtures/project-inspector.ts";
import "../../styles.css";

declare global {
  interface Window {
    inspectorActions: Array<{ type: string; nodeId: string; tab?: string }>;
    inspectorSetScenario: (scenario: string) => void;
    inspectorSetView: (value: { view: EngineeringView; nodeId: string }) => void;
  }
}
window.inspectorActions = [];
function Harness() {
  const [value, setValue] = useState(() => inspectorScenario(new URLSearchParams(location.search).get("scenario") || "draft"));
  window.inspectorSetScenario = scenario => setValue(inspectorScenario(scenario));
  window.inspectorSetView = setValue;
  return <main style={{ padding: "16px", maxWidth: 1200, margin: "auto", minWidth: 0 }}><p style={{ margin: 0, fontSize: 12 }}>隔离界面测试 · 不连接真实任务或执行</p><ProjectNodeInspector {...value} labels={["交付体验"]} onOpenDetail={(nodeId, tab) => { window.inspectorActions.push({ type: "open", nodeId, tab }); }} onNavigateNode={nodeId => { window.inspectorActions.push({ type: "navigate", nodeId }); setValue(previous => ({ ...previous, nodeId })); }} /></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Harness /></React.StrictMode>);
