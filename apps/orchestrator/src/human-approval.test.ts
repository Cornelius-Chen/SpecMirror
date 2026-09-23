import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authenticatedHumanApproval, humanApprovalRequestDigest, registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";

const apps: ReturnType<typeof Fastify>[] = [];
function fixture(verifier?: HumanApprovalVerifier) {
  const app = Fastify(); apps.push(app); let writes = 0;
  registerHumanApprovalGuard(app, verifier);
  app.get("/api/engineering", async () => ({revision:118}));
  app.post("/api/engineering/structure-proposal/preview", async () => ({preview:true}));
  app.post("/api/engineering/plan-import/preview", async () => ({preview:true}));
  app.post("/api/engineering/work-package/preview", async () => ({preview:true}));
  app.post("/api/engineering/work-package/commit", async request => {writes++; return {approved:authenticatedHumanApproval(request)?.approvalId};});
  for (const path of ["/api/engineering/structure-proposal/commit", "/api/engineering/plan-import/commit", "/api/engineering/nodes/:id/ready", "/api/engineering/runs/:id/review", "/api/engineering/feedback-items/:id/update", "/api/task-workspaces", "/api/permission-contracts/:id/review", "/api/changesets/:id/dispatch", "/api/supervision/details/:id/review"]) {
    app.post(path, async request => {writes++; return {approved:authenticatedHumanApproval(request)?.approvalId};});
  }
  app.post("/api/codex-companion/run-plan", async () => ({accepted:true}));
  return {app, writes:()=>writes};
}
afterEach(async () => {for(const app of apps.splice(0))await app.close();});
const grant: HumanApprovalVerifier = async (_request, requirement) => ({kind:"authenticated_human_approval",principalId:"isolated-test-owner",approvalId:"test-one-approval",requestDigest:requirement.requestDigest,expiresAt:Date.now()+60000});

describe("positively authenticated, request-bound human approval", () => {
  it("previews need no PIN but a work package still needs exact single-use human approval", async () => {
    const f=fixture(grant);
    for(const url of ["/api/engineering/plan-import/preview", "/api/engineering/work-package/preview"])
      expect((await f.app.inject({method:"POST",url,payload:{expected_revision:3}})).statusCode).toBe(200);
    expect(f.writes()).toBe(0);
    const request={method:"POST" as const,url:"/api/engineering/work-package/commit",payload:{token:"isolated-preview",request:{expected_revision:3}}};
    expect((await f.app.inject(request)).statusCode).toBe(200);
    expect((await f.app.inject(request)).statusCode).toBe(403);
    expect(f.writes()).toBe(1);
    const missing=fixture();
    for(const headers of [{},{"x-engineering-agent-session-id":"agent"},{"x-engineering-cwd":"D%3A%2Fproject"}])
      expect((await missing.app.inject({...request,headers})).statusCode).toBe(403);
    const marked=fixture(grant);
    expect((await marked.app.inject({...request,headers:{"x-engineering-agent-session-id":"agent"}})).statusCode).toBe(403);
    expect(missing.writes()).toBe(0);expect(marked.writes()).toBe(0);
  });
  it("canonically binds special JSON keys including __proto__", () => {
    const app=Fastify();apps.push(app);registerHumanApprovalGuard(app);
    const plain=JSON.parse('{"safe":true,"__proto__":{"role":"owner"}}');
    const changed=JSON.parse('{"safe":true,"__proto__":{"role":"agent"}}');
    expect(humanApprovalRequestDigest(app,{method:"POST",url:"/api/write",workspace:"host",body:plain}))
      .not.toBe(humanApprovalRequestDigest(app,{method:"POST",url:"/api/write",workspace:"host",body:changed}));
  });
  it("treats the runtime-only current plan projection as an Agent observation endpoint", async () => {
    const f=fixture();
    const response=await f.app.inject({method:"POST",url:"/api/codex-companion/run-plan",payload:{session_id:"observed",cwd:"D:/source",plan:[{step:"Inspect",status:"in_progress"}]}});
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual({accepted:true});
  });
  it("keeps reads available while every supervisor route rejects an unidentified caller", async () => {
    const f=fixture(); expect((await f.app.inject({method:"GET",url:"/api/engineering"})).statusCode).toBe(200);
    for(const headers of [{},{"x-engineering-agent-session-id":"agent","x-engineering-cwd":"D%3A%2Fproject"}]){
      const preview=await f.app.inject({method:"POST",url:"/api/engineering/structure-proposal/preview",headers,payload:{proposal_id:"proposal"}});
      expect(preview.statusCode).toBe(200);
    }
    for(const url of ["/api/engineering/structure-proposal/commit", "/api/engineering/plan-import/commit", "/api/engineering/nodes/root/ready", "/api/engineering/runs/run/review", "/api/engineering/feedback-items/feedback/update", "/api/task-workspaces", "/api/permission-contracts/permission/review", "/api/changesets/change/dispatch", "/api/supervision/details/detail/review"]){
      const response=await f.app.inject({method:"POST",url,payload:{expected_revision:118}});
      expect(response.statusCode,url).toBe(403); expect(response.json().code).toBe("human_approval_required");
    }
    expect(f.writes()).toBe(0);
  });
  it("does not infer human identity from origin, cookies, headers, body assertions or the ratification", async () => {
    const f=fixture();
    const response=await f.app.inject({method:"POST",url:"/api/engineering/structure-proposal/commit",headers:{origin:"http://127.0.0.1:4317",cookie:"role=owner",authorization:"Bearer human", "x-human-approved":"true"},payload:{role:"human",owner:true,status:"HUMAN_RATIFIED",incident_id:"engineering-rev117-to-rev118"}});
    expect(response.statusCode).toBe(403); expect(f.writes()).toBe(0);
  });
  it.each(["null", "exception", "expired", "mismatch", "future", "no-principal", "no-id"])("fails closed for %s verification",async kind=>{
    const f=fixture(async(request, requirement)=>{
      if(kind==="null")return null; if(kind==="exception")throw Error("identity provider unavailable");
      const proof=(await grant(request,requirement))!;
      if(kind==="expired")proof.expiresAt=Date.now()-1;
      if(kind==="future")proof.expiresAt=Date.now()+3600000;
      if(kind==="mismatch")proof.requestDigest="other-request";
      if(kind==="no-principal")proof.principalId="";
      if(kind==="no-id")proof.approvalId="";
      return proof;
    });
    expect((await f.app.inject({method:"POST",url:"/api/engineering/runs/run/review",payload:{verdict:"accepted"}})).statusCode).toBe(403);expect(f.writes()).toBe(0);
  });
  it("accepts a trusted verifier result once and blocks concurrent replay",async()=>{
    const f=fixture(grant), request={method:"POST" as const,url:"/api/engineering/runs/run/review",payload:{verdict:"accepted"}};
    const responses=await Promise.all([f.app.inject(request),f.app.inject(request)]);
    expect(responses.map(result=>result.statusCode).sort()).toEqual([200,403]);expect(f.writes()).toBe(1);
  });
  it("does not let a known Agent act as a human even with a positive verifier installed",async()=>{
    const f=fixture(grant);
    for(const headers of [{"x-engineering-agent-session-id":"agent"},{"x-engineering-cwd":"D%3A%2Fproject"}])expect((await f.app.inject({method:"POST",url:"/api/engineering/runs/run/review",headers})).statusCode).toBe(403);
    expect(f.writes()).toBe(0);
  });
  it("binds proof to payload, workspace, resource and host instance",async()=>{
    let digest="";
    const proof:HumanApprovalVerifier=async(request,requirement)=>{digest ||= requirement.requestDigest;return {...(await grant(request,requirement))!,requestDigest:digest};};
    const f=fixture(proof);expect((await f.app.inject({method:"POST",url:"/api/engineering/runs/a/review",payload:{verdict:"accepted"}})).statusCode).toBe(200);
    for(const request of [{url:"/api/engineering/runs/a/review",payload:{verdict:"needs_revision"}},{url:"/api/engineering/runs/b/review",payload:{verdict:"accepted"}},{url:"/api/engineering/runs/a/review",payload:{verdict:"accepted"},headers:{"x-mirror-workspace-id":"other"}}])expect((await f.app.inject({method:"POST",...request})).statusCode).toBe(403);
    const other=fixture(proof);expect((await other.app.inject({method:"POST",url:"/api/engineering/runs/a/review",payload:{verdict:"accepted"}})).statusCode).toBe(403);expect(other.writes()).toBe(0);
  });
});
