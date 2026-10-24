import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom", setupFiles: ["./tests/setup.ts"], css: true,
    include: ["output/triage-defects-20261022/*.spec.tsx"]
  }
});
