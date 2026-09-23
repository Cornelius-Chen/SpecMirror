import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringNode, EngineeringView } from "@epm/domain";
import { loadEngineering, RuntimeStore } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";
import { TaskWorkspaces, registerTaskWorkspaceRoutes, type TaskWorkspaceSummary, type TaskWorkspaceOptions } from "./task-workspaces.ts";

const fixtures: Array<{root: string; app: FastifyInstance}> = [];
async function fixture(existingRoot?: string, options: TaskWorkspaceOptions = {}) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "mirror-workspaces-"));
  let version = "current-source";
  let approval = 0;
  const humanApproval: HumanApprovalVerifier = async (_request, requirement) => ({
    kind: "authenticated_human_approval",
    principalId: "isolated-task-workspace-test-owner",
    approvalId: "task-workspace-approval-" + ++approval,
    requestDigest: requirement.requestDigest,
    expiresAt: Date.now() + 60_000
  });
  const source = async (id: string) => ({id, title: "真实任务 " + id, cwd: resolve(root, "../source-project"), version, preview: "来源请求，需要先细化约束与验收。", updatedAt: 1, pinned: false, received: false, receivedAt: null});
  const app = Fastify(), events = new EventBus(), runtime = new RuntimeStore(root), companion = new WorkspaceCompanion(root, runtime, events, { readonlyLegacy: true });
  // This lifecycle observation belongs only to the temporary fixture; it is not a production online assertion.
  companion.receiveHook({session_id:"fixture-worker",cwd:resolve(root,"../source-project"),hook_event_name:"SessionStart"});
  const workspaces = new TaskWorkspaces(root, events, {source}, {sessions:record=>companion.sessions(record),...options});
  app.addHook("onClose",async()=>{runtime.close();});
  registerHumanApprovalGuard(app, humanApproval);
  registerEngineeringRoutes(app, root, events, undefined, workspaces);
  registerTaskWorkspaceRoutes(app, workspaces);
  await app.ready(); fixtures.push({root, app});
  const connect = async (id: string, mode: "create" | "link_existing" = "create", status = 201, sourceVersion = version) => {
    const response = await app.inject({method:"POST", url:"/api/task-workspaces", payload:{thread_id:id,source_version:sourceVersion,mode}});
    expect(response.statusCode,response.body).toBe(status); return response.json<TaskWorkspaceSummary>();
  };
  const call = async (workspaceId: string, method: "GET" | "POST" | "PUT", path: string, payload?: unknown, status = 200, extraHeaders: Record<string,string> = {}) => {
    if ((path === "/dispatch" && (payload as {mode?: string})?.mode === "external") || /^\/runs\/[^/]+\/(actions\/|finish$)/.test(path)) extraHeaders={"x-engineering-agent-session-id":"fixture-worker","x-engineering-cwd":encodeURIComponent(resolve(root,"../source-project")),...extraHeaders};
    const response = await app.inject({method,url:"/api/engineering"+path,headers:{"x-mirror-workspace-id":workspaceId,...extraHeaders},...(payload !== undefined ? {payload:payload as object} : {})});
    expect(response.statusCode,response.body).toBe(status); return response;
  };
  const view = async (id: string) => (await call(id,"GET","")).json<EngineeringView>();
  const configure = async (id: string, resources: string[] = [], owner = "codex:fixture-worker") => {
    const v = await view(id), node: EngineeringNode = {...v.document.nodes[0],owner,objective:"形成可核对交付",constraints:{allow:["artifacts/**"],deny:[],rules:[],resources},
      criteria:[{id:"result",text:"文件包含任务身份",kind:"file_contains",path:"artifacts/result.txt",expected:id}],
      delivery:{included:["本任务独立产物"],excluded:["其他工作区产物"],outputs:[{id:"result",title:"本任务结果",criterion_ids:["result"]}],inputs:[]},
      actions:[{id:"write",title:"提交当前工作区结果",type:"write_file",path:"artifacts/result.txt",content:id,criterion_id:"result",capability_id:""}]};
    const payload = {node,expected_revision:v.document.revision,reason:"细化本任务独立执行合同"};
    await call(id,"POST","/nodes/engineering-project/preview",payload);
    await call(id,"PUT","/nodes/engineering-project",payload);
    await call(id,"POST","/nodes/engineering-project/ready",{expected_revision:(await view(id)).document.revision});
  };
  const dispatch = async (id: string, mode: "external" | "controlled" = "external") => { await call(id,"POST","/dispatch",{node_ids:["engineering-project"],mode},202); await workspaces.settled(); return (await view(id)).document.runs.at(-1)!; };
  return {root,app,workspaces,connect,call,view,configure,dispatch,changeSource:()=>{version="new-source";}};
}

afterEach(async () => {
  const all = fixtures.splice(0).reverse();
  for (const item of all) await item.app.close();
  for (const root of new Set(all.map(item=>item.root))) {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir())+sep)) throw new Error("unsafe_cleanup");
    rmSync(absolute,{recursive:true,force:true});
  }
});

describe("one unified Codex task workspace",()=>{
  it("creates from authoritative metadata without accepting, assigning, or writing to source project",async()=>{
    const f=await fixture(), workspace=await f.connect("thread-a");
    expect(workspace).toMatchObject({thread_id:"thread-a",title:"真实任务 thread-a",kind:"managed",status:"draft",counts:{accepted:0}});
    const doc=(await f.view(workspace.id)).document;
    expect(doc.nodes).toHaveLength(1); expect(doc.nodes[0]).toMatchObject({title:"真实任务 thread-a",owner:"未分配",criteria:[],actions:[],objective:"来源请求，需要先细化约束与验收。"});
    expect(existsSync(join(workspace.source_cwd,".project","engineering"))).toBe(false);
    expect(f.workspaces.resolve(workspace.id).root).toContain(join(".project","task-workspaces",workspace.id));
  });
  it("keeps long source requests as bounded editable drafts",async()=>{
    const f=await fixture();
    const original=f.workspaces.catalog.source;
    f.workspaces.catalog.source=async(id)=>({...await original(id),preview:"长请求".repeat(6000)});
    const a=await f.connect("long-request"),node=(await f.view(a.id)).document.nodes[0];
    expect(node.objective.length).toBeLessThanOrEqual(12000);
    expect(node.objective).toContain("来源摘要");expect(node.status).toBe("draft");
  });
  it("serializes concurrent association, rejects stale sources and conflicting links, and preserves host history",async()=>{
    const f=await fixture();
    const hostBefore=JSON.stringify(loadEngineering(f.root));
    const [a,b]=await Promise.all([f.connect("thread-a"),f.connect("thread-a")]); expect(a.id).toBe(b.id);
    expect(f.workspaces.list().data).toHaveLength(2);
    await f.connect("thread-a","link_existing",409);
    const host=await f.connect("thread-host","link_existing"); expect(host.id).toBe("host");
    expect(JSON.stringify(loadEngineering(f.root))).toBe(hostBefore);
    await f.connect("thread-b","link_existing",409);
    f.changeSource(); await f.connect("thread-new","create",409,"current-source");
    expect(f.workspaces.forThread("thread-new")).toBeUndefined();
  });
  it("keeps document, preview, run and artifact identity inside selected scope even when node IDs match",async()=>{
    const f=await fixture(), a=await f.connect("a"), b=await f.connect("b");
    await f.configure(a.id); const first=(await f.view(a.id)).document;
    expect((await f.view(b.id)).document.nodes[0].actions).toEqual([]);
    const run=await f.dispatch(a.id,"controlled"); expect(run.status).toBe("review");
    expect(readFileSync(join(run.output_dir,"artifacts/result.txt"),"utf8")).toBe(a.id);
    await f.call(b.id,"GET","/runs/"+run.id+"/artifact?path=artifacts%2Fresult.txt",undefined,404);
    await f.call(b.id,"POST","/runs/"+run.id+"/review",{verdict:"accepted"},404);
    await f.call("missing","GET","",undefined,404);
    await f.call(a.id,"GET","?workspace="+b.id,undefined,400);
    const aDoc=await f.view(a.id), proposed={...aDoc.document.nodes[0],objective:"另一项变更"}, payload={node:proposed,expected_revision:aDoc.document.revision,reason:"范围验证"};
    await f.call(a.id,"POST","/nodes/engineering-project/preview",payload);
    await f.call(b.id,"PUT","/nodes/engineering-project",{...payload,node:{...(await f.view(b.id)).document.nodes[0],objective:"非法沿用预览"},expected_revision:1},409);
    expect(first.nodes[0].id).toBe((await f.view(b.id)).document.nodes[0].id);
    const artifact=await f.app.inject({url:`/api/engineering/runs/${run.id}/artifact?path=artifacts%2Fresult.txt&workspace=${a.id}`});
    expect(artifact.statusCode).toBe(200);expect(artifact.body).toBe(a.id);
  });
  it("shares three host slots across independent projects and wakes the next workspace on release",async()=>{
    const f=await fixture(), workspaces=await Promise.all(["a","b","c","d"].map(id=>f.connect(id)));
    for (const w of workspaces) {await f.configure(w.id);await f.dispatch(w.id);}
    expect(f.workspaces.scheduler.stats()).toEqual({max_parallel:3,active:3,queued:1});
    const first=(await f.view(workspaces[0].id)).document.runs.at(-1)!;
    await f.call(workspaces[0].id,"POST",`/runs/${first.id}/actions/write`,{});
    await f.call(workspaces[0].id,"POST",`/runs/${first.id}/finish`,{});
    await f.workspaces.settled();
    expect((await f.view(workspaces[3].id)).document.runs.at(-1)?.status).toBe("running");
    expect(f.workspaces.scheduler.stats()).toEqual({max_parallel:3,active:3,queued:0});
  });
  it("holds a shared resource across workspaces while independent output paths remain parallel",async()=>{
    const f=await fixture(), a=await f.connect("a"), b=await f.connect("b"), c=await f.connect("c");
    await f.configure(a.id,["shared-jervis-index"]);await f.configure(b.id,["shared-jervis-index"]);await f.configure(c.id,["unrelated-index"]);
    await f.dispatch(a.id);await f.dispatch(b.id);await f.dispatch(c.id);
    expect((await f.view(b.id)).document.runs.at(-1)?.status).toBe("queued");
    expect((await f.view(b.id)).derived["engineering-project"].blockers.join(" ")).toContain("shared-jervis-index");
    expect((await f.view(c.id)).document.runs.at(-1)?.status).toBe("running");
    await f.call(a.id,"POST","/nodes/engineering-project/pause",{reason:"释放资源检查"});await f.workspaces.settled();
    expect((await f.view(b.id)).document.runs.at(-1)?.status).toBe("running");
  });
  it("persists association and task versions across restart and safely pauses unfinished execution",async()=>{
    const f=await fixture(), a=await f.connect("a");await f.configure(a.id);const run=await f.dispatch(a.id);
    expect(run.status).toBe("running");await f.app.close();
    const restarted=await fixture(f.root);
    expect(restarted.workspaces.forThread("a")?.record.id).toBe(a.id);
    expect((await restarted.view(a.id)).document.runs.at(-1)).toMatchObject({id:run.id,status:"paused"});
    expect((await restarted.connect("a")).id).toBe(a.id);
  });
});
