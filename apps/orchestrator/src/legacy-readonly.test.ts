import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLegacyReadonlyGuard } from "./app.ts";

describe("unified production history archive", () => {
  it("keeps history readable and refuses legacy mutations without entering old executor", async () => {
    const app = Fastify(); registerLegacyReadonlyGuard(app, true); let legacyWrites = 0;
    app.get("/api/supervision", () => ({history: "preserved"}));
    for (const url of ["/api/changesets/:id/dispatch", "/api/supervision/runs/:id/resume", "/api/supervision/details/:id/review", "/api/codex-companion/sync-plan"]) app.post(url, () => {legacyWrites++;return {executed:true};});
    app.put("/api/supervision/details/:id",()=>{legacyWrites++;return {saved:true};});
    expect((await app.inject({url:"/api/supervision"})).json()).toEqual({history:"preserved"});
    for (const url of ["/api/changesets/old/dispatch", "/api/supervision/runs/old/resume", "/api/supervision/details/old/review", "/api/codex-companion/sync-plan"]) {
      const response=await app.inject({url,method:"POST"});expect(response.statusCode,response.body).toBe(409);expect(response.json().code).toBe("legacy_archive_readonly");
    }
    expect((await app.inject({url:"/api/supervision/details/old",method:"PUT"})).statusCode).toBe(409);
    expect(legacyWrites).toBe(0);await app.close();
  });
  it("preserves the unified workflow and explicit legacy compatibility mode", async () => {
    for (const enabled of [true,false]) {
      const app=Fastify();registerLegacyReadonlyGuard(app,enabled);
      for(const url of ["/api/task-workspaces","/api/task-inbox/:id/receive","/api/codex-companion/hooks","/api/codex-companion/run-plan","/api/codex/smoke","/api/codex/smoke/stop","/api/engineering/dispatch","/api/engineering/runs/:id/review"])app.post(url,()=>({ok:true}));
      app.post("/api/changesets/:id/dispatch",()=>({ok:true}));
      for(const url of ["/api/task-workspaces","/api/task-inbox/current/receive","/api/codex-companion/hooks","/api/codex-companion/run-plan","/api/engineering/dispatch","/api/engineering/runs/current/review"])expect((await app.inject({url,method:"POST"})).statusCode).toBe(200);
      for(const url of ["/api/codex/smoke","/api/codex/smoke/stop"]) {
        expect((await app.inject({url,method:"POST"})).statusCode).toBe(enabled?409:200);
        expect((await app.inject({url,method:"POST",headers:{"x-mirror-surface":"current-task"}})).statusCode).toBe(200);
      }
      expect((await app.inject({url:"/api/changesets/old/dispatch",method:"POST"})).statusCode).toBe(enabled?409:200);
      await app.close();
    }
  });
});
