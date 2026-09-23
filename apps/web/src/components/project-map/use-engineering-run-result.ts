import { useEffect, useState } from "react";
import type { EngineeringRun } from "@epm/domain";
import type { EngineeringApi } from "../../engineering-api.ts";
import { nodeResultSelectionKey, type EngineeringRunResult } from "./node-result-state.ts";

type LoadState = { key: string; api: EngineeringApi; result?: EngineeringRunResult; error?: string };

/** Shared, read-only material observation. Each request owns its cancellation flag. */
export function useEngineeringRunResult(api: EngineeringApi, nodeId: string, run: EngineeringRun, documentRevision: number) {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<LoadState>();
  const workspaceId = api.workspaceId ?? "host";
  const key = JSON.stringify([nodeResultSelectionKey(workspaceId, nodeId, run.id, documentRevision, refresh), run.snapshot.contract_key, run.snapshot.node.revision]);
  // Hide stale data synchronously, before effect cleanup, including workspace switches.
  const visible = state?.key === key && state.api === api ? state : undefined;
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    void api.result(run.id, controller.signal).then(result => {
      if (!active) return;
      if (result.workspace_id !== workspaceId || result.run_id !== run.id || result.node_id !== nodeId
        || result.contract_key !== run.snapshot.contract_key || result.node_revision !== run.snapshot.node.revision) {
        setState({ key, api, error: "结果记录与所选节点或冻结版本不匹配，请刷新工作区后重试。" }); return;
      }
      setState({ key, api, result });
    }).catch(() => { if (active) setState({ key, api, error: "暂时无法核对这次结果，请刷新重试。原运行记录保持不变。" }); });
    return () => { active = false; controller.abort(); };
  }, [api, workspaceId, nodeId, run.id, run.snapshot.contract_key, run.snapshot.node.revision, key]);
  return { loading: !visible, result: visible?.result, error: visible?.error, refresh: () => setRefresh(value => value + 1) };
}
