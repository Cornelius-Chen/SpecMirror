import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { readYaml } from "@epm/spec-io";
import { EventBus } from "../src/events.ts";
import { TaskCatalog, registerTaskCatalogRoutes } from "../src/task-catalog.ts";
import { TaskWorkspaces, registerTaskWorkspaceRoutes } from "../src/task-workspaces.ts";
import { registerEngineeringRoutes } from "../src/engineering-routes.ts";
import { registerEngineeringPlanImports } from "../src/engineering-plan-import.ts";
import { registerEngineeringRestructure } from "../src/engineering-restructure.ts";
import { registerTaskPresentationRoutes } from "../src/task-presentation.ts";
import { createEngineeringJervisBridge } from "../src/engineering-jervis.ts";
import type { JsonRpcTransport } from "../src/stdio-jsonrpc.ts";

export const fixtureThreads = [
  {id:"11111111-1111-4111-8111-111111111111",name:"统一工程交付测试",cwd:resolve("D:/MirrorFixture/ProjectA"),updatedAt:1788618000,preview:"形成有来源的工程组织方案，分步交付并核对效果。"},
  {id:"22222222-2222-4222-8222-222222222222",name:"另一项目的独立任务",cwd:resolve("D:/MirrorFixture/ProjectB"),updatedAt:1788617000,preview:"此任务的计划与产物必须独立。"}
];
export async function createUnifiedBrowserServer(root:string, repo:string) {
  const jervisRoot=join(root,"jervis-source-copy"), sourceJervis=resolve(repo,"../Jervis/IRONMAN_Codex_Implementation_Pack_v1_1");
  for(const dir of ["registry/designer/p1_s0c","legacy","domains/designer/adapters"])mkdirSync(join(jervisRoot,dir),{recursive:true});
  for(const file of ["projection_manifest.json","objects.jsonl","object_index.jsonl","relations.jsonl","intake_contract.json"])copyFileSync(join(sourceJervis,"registry/designer/p1_s0c",file),join(jervisRoot,"registry/designer/p1_s0c",file));
  copyFileSync(join(sourceJervis,"domains/designer/adapters/mirror_bridge.py"),join(jervisRoot,"domains/designer/adapters/mirror_bridge.py"));
  const declaration=readYaml<Record<string,any>>(join(sourceJervis,"legacy/SOURCE_ROOTS_DECLARATION.yaml"));declaration.source_root=resolve(sourceJervis,declaration.source_root);writeFileSync(join(jervisRoot,"legacy/SOURCE_ROOTS_DECLARATION.yaml"),JSON.stringify(declaration));
  const transport={request:async(method:string,params:Record<string,unknown>)=>{
    if(method==="thread/list")return {data:params.archived?[]:fixtureThreads.filter(t=>!params.searchTerm||t.name.includes(String(params.searchTerm))),nextCursor:null};
    const thread=fixtureThreads.find(t=>t.id===params.threadId);if(!thread)throw Error("fixture_thread_not_found");
    if(method==="thread/read")return {thread};
    if(method==="thread/turns/list")return {data:[{id:"turn-"+thread.id,status:"completed",items:[{type:"userMessage",content:[{type:"text",text:thread.preview}]},{type:"agentMessage",text:"对话完成仍需核对实际工程证据。"}]}],nextCursor:null};
    throw Error("fixture_forbids_model_execution");
  },notify:async()=>{},close:async()=>{},onNotification:()=>()=>{}} as JsonRpcTransport;
  const app=Fastify(), events=new EventBus(), catalog=new TaskCatalog(root,()=>transport);
  const bridge=createEngineeringJervisBridge(root,{jervisRoot});
  const workspaces=new TaskWorkspaces(root,events,catalog,{jervis:bridge,sessions:()=>[]});
  registerTaskCatalogRoutes(app,root,catalog);registerTaskWorkspaceRoutes(app,workspaces);registerEngineeringRoutes(app,root,events,bridge,workspaces);
  registerEngineeringPlanImports(app,workspaces);
  registerEngineeringRestructure(app,workspaces);
  registerTaskPresentationRoutes(app,workspaces);
  app.addHook("onClose",async()=>workspaces.close());
  app.get("/api/codex-companion/status",async()=>({sessions:[]}));
  app.get("/api/events",async(request,reply)=>{
    reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});reply.raw.write(": connected\n\n");
    const listener=(event:unknown)=>reply.raw.write("data: "+JSON.stringify(event)+"\n\n");events.emitter.on("event",listener);request.raw.on("close",()=>events.emitter.off("event",listener));
  });
  await app.register(fastifyStatic,{root:join(repo,"apps/web/dist")});
  return {app,workspaces,jervisRoot};
}
