import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}", "lib/**/*.ts", "proxy.ts"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.testkit.ts"],
      thresholds: { lines: 70 },
    },
  },
});
