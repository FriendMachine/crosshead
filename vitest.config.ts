import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["tests/setup/isolate-host-env.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/release/**", "**/.git/**"],
  },
});
