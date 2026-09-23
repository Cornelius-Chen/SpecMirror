import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { EventBus } from "../src/events.ts";
import { registerEngineeringRoutes } from "../src/engineering-routes.ts";
import { createEngineeringJervisBridge } from "../src/engineering-jervis.ts";
import { TaskWorkspaces, registerTaskWorkspaceRoutes } from "../src/task-workspaces.ts";
import { registerTaskPresentationRoutes } from "../src/task-presentation.ts";

export async function createEngineeringBrowserServer(root: string, jervisRoot: string, webRoot: string) {
  const app = Fastify();
  const events = new EventBus();
  const bridge = createEngineeringJervisBridge(root, { jervisRoot });
  const workspaces = new TaskWorkspaces(root, events, {source: async () => {throw new Error("source_not_used_in_host_engineering_fixture");}}, {jervis:bridge,sessions:()=>[]});
  registerTaskWorkspaceRoutes(app, workspaces);
  registerTaskPresentationRoutes(app, workspaces);
  registerEngineeringRoutes(app, root, events, bridge, workspaces);
  app.get("/api/task-inbox", async () => ({ data: [], nextCursor: null, syncedAt: new Date().toISOString() }));
  app.get("/api/codex-companion/status", async () => ({ sessions: [] }));
  app.get("/api/events", async (request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    reply.raw.write(": connected\n\n");
    const listener = (event: unknown) => reply.raw.write("data: " + JSON.stringify(event) + "\n\n");
    events.emitter.on("event", listener);
    request.raw.on("close", () => events.emitter.off("event", listener));
  });
  await app.register(fastifyStatic, { root: webRoot });
  return app;
}
