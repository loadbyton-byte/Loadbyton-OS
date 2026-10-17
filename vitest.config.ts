import { defineConfig } from "vitest/config";
// The operating-platform suites exercise the full multi-tenant app, so they run with brochure mode off.
// tests/requests.test.ts switches it on for its own file.
export default defineConfig({ test: { testTimeout: 60000, hookTimeout: 60000, include: ["tests/**/*.test.ts"], pool: "forks", env: { BROCHURE_MODE: "false" } } });
