import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the unit tests cover pure logic
// (page parsing, alert decisions) and have no business loading the React
// Router plugin or its route graph to run.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
