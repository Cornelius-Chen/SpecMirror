import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { TaskCatalog, registerTaskCatalogRoutes } from "../src/task-catalog.ts";
import type { JsonRpcTransport } from "../src/stdio-jsonrpc.ts";
import { TaskWorkspaces, registerTaskWorkspaceRoutes } from "../src/task-workspaces.ts";
import { registerEngineeringRoutes } from "../src/engineering-routes.ts";
import { EventBus } from "../src/events.ts";
import { registerTaskPresentationRoutes } from "../src/task-presentation.ts";
export async function createTaskInboxBrowserServer(root:string,webRoot:string,transport:JsonRpcTransport) {
 const app=Fastify(),events=new EventBus(),catalog=new TaskCatalog(root,()=>transport),workspaces=new TaskWorkspaces(root,events,catalog,{sessions:()=>[]});
 registerTaskCatalogRoutes(app,root,catalog);registerTaskWorkspaceRoutes(app,workspaces);registerEngineeringRoutes(app,root,events,undefined,workspaces);
 registerTaskPresentationRoutes(app,workspaces);
 app.addHook("onClose",async()=>workspaces.close());
 app.get("/api/events",async(request,reply)=>{reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});reply.raw.write(": connected\n\n");const listener=(event:unknown)=>reply.raw.write("data: "+JSON.stringify(event)+"\n\n");events.emitter.on("event",listener);request.raw.on("close",()=>events.emitter.off("event",listener));});
 await app.register(fastifyStatic,{root:webRoot});return app;
}
