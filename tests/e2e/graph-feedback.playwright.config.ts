import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "graph-feedback.spec.ts", workers: 1, timeout: 45000,
  outputDir: "../../test-results/graph-feedback-ui", use: { baseURL: "http://127.0.0.1:5223", browserName: "chromium", trace: "retain-on-failure", video: "on" },
  projects: [
    { name: "graph-feedback-desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "graph-feedback-phone", use: { viewport: { width: 390, height: 844 } } }
  ],
  webServer: { command: "pnpm --filter @epm/web dev --port 5223", url: "http://127.0.0.1:5223", reuseExistingServer: false, timeout: 60000 }
});
