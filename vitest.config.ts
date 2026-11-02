import { defineConfig } from "vitest/config";

const coreCoverage = [
  "examples/server/control-room/src/account/routes.ts",
  "examples/server/control-room/src/account/tinode.ts",
  "model_interface/src/connections.ts",
  "model_interface/src/httpEndpoint.ts",
  "model_interface/src/modelSessionEndpoint.ts",
  "model_interface/src/qwenLiveEndpoint.ts",
  "server-sdk/core/src/capabilityRouter.ts",
  "server-sdk/core/src/client.ts",
  "server-sdk/core/src/commandService.ts",
  "server-sdk/core/src/exchange.ts",
  "server-sdk/core/src/gateway.ts",
  "server-sdk/core/src/http/observations.ts",
  "server-sdk/core/src/http/routes.ts",
  "server-sdk/core/src/modelBridge.ts",
  "server-sdk/core/src/pairingService.ts",
  "server-sdk/core/src/registry.ts",
  "server-sdk/core/src/remoteDriver.ts",
  "server-sdk/core/src/server.ts",
  "server-sdk/core/src/streamBroker.ts",
  "server-sdk/core/src/transport.ts",
  "examples/server/control-room/src/transportConfig.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    isolate: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { name: "contract", include: ["test/contract/**/*.test.ts"] } },
      { test: { name: "integration", include: ["test/integration/**/*.test.ts"] } }
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage",
      include: coreCoverage,
      exclude: ["**/*.d.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70
      }
    }
  }
});
