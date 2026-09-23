import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@epm/domain": `${root}packages/domain/src/index.ts`,
      "@epm/spec-io": `${root}packages/spec-io/src/index.ts`
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "html"] }
  }
});
