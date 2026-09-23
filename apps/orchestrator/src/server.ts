import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { findRepoRoot } from "@epm/spec-io";
import { buildApp } from "./app.ts";
import { createLocalWebAuthnHumanApprovalProvider } from "./human-approval-webauthn.ts";

const root = findRepoRoot();
const localEnv = join(root, ".env.local");
if (existsSync(localEnv)) loadEnvFile(localEnv);
const host = process.env.EPM_HOST ?? "127.0.0.1";
if (!new Set(["127.0.0.1", "localhost"]).has(host)) throw new Error("EPM_HOST must be a local loopback address.");
const port = Number(process.env.EPM_PORT ?? 4317);
const gateway = process.env.EPM_AGENT_GATEWAY === "codex-app-server" ? "codex-app-server" : "mock";
const humanApprovalProvider = createLocalWebAuthnHumanApprovalProvider({ expectedOrigin: `http://localhost:${port}` });
const app = await buildApp({ root, gateway, recoverInterrupted: true, readonlyLegacy: true, humanApprovalProvider });
await app.listen({ host, port });
console.log(`EPM control plane listening on http://${host}:${port} (${gateway})`);
