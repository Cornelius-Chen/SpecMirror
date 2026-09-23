import type { EngineeringView } from "@epm/domain";
import type { ReactNode } from "react";
import type { EngineeringApi } from "../../engineering-api.ts";
import type { EngineeringFeedbackTarget } from "../../../../../packages/domain/src/engineering-feedback.ts";

export type ProjectDetailTab = "reading" | "plan" | "bounds" | "criteria" | "actions" | "capabilities" | "runs" | "history";
export type ProjectMapCanvasMode = "embedded" | "focus";
export type ProjectMapDensity = "auto" | "overview" | "structure" | "detail";

/** A read-only, turn-scoped Codex projection. It never replaces engineering status. */
export interface ProjectMapRunPlanActivity {
  agentCount: number;
  completedSteps: number;
  totalSteps: number;
  executionAuthorized: boolean;
  phase: "plan" | "waiting" | "running" | "reported" | "idle";
  currentStepTitle?: string;
}

export type ProjectMapNavigationIntent =
  | { type: "toggle"; nodeId: string }
  | { type: "collapse"; nodeId: string }
  | { type: "focus"; nodeId: string; reason: "enter" | "back" | "root" | "locate" }
  | { type: "select"; nodeId: string | null }
  | { type: "open"; nodeId: string; section: "read" | "edit" | "runs" };

export interface ProjectStructureMapProps {
  view: EngineeringView;
  nodeNames?: Record<string, string>;
  workspaceId: string;
  canvasMode?: ProjectMapCanvasMode;
  onCanvasModeChange?: (mode: ProjectMapCanvasMode) => void;
  density?: ProjectMapDensity;
  onDensityChange?: (density: ProjectMapDensity) => void;
  runPlanActivityByNode?: Readonly<Record<string, ProjectMapRunPlanActivity>>;
  focusNodeId?: string | null;
  selectedNodeId?: string | null;
  expandedNodeIds?: readonly string[];
  showDependencies?: boolean;
  disabled?: boolean;
  observationUnavailable?: boolean;
  onRequestNavigation: (intent: ProjectMapNavigationIntent) => void;
  onDependenciesChange?: (visible: boolean) => void;
  onFeedback?: (target: EngineeringFeedbackTarget, scopeNodeIds?: string[], feedbackId?: string) => void;
  feedbackTarget?: EngineeringFeedbackTarget;
  feedbackScopeNodeIds?: readonly string[];
  feedbackId?: string;
  contextPanel?: ReactNode;
  onOpenDetail?: (nodeId: string, section: "read" | "edit" | "runs") => void;
  onDismissFeedback?: (afterDismiss?: () => void) => void;
}

export interface ProjectNodeInspectorProps {
  api?: EngineeringApi;
  view: EngineeringView;
  nodeNames?: Record<string, string>;
  nodeId: string;
  labels?: string[];
  onRename?: () => void;
  onOpenDetail: (nodeId: string, tab?: ProjectDetailTab, field?: string) => void;
  onNavigateNode: (nodeId: string) => void;
  onFeedback?: (target: EngineeringFeedbackTarget) => void;
  observationUnavailable?: boolean;
}
