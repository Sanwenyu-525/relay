import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [workspaceRoot]
    }
  },
  build: {
    rollupOptions: {
      // 多页入口：overlay.html 是电脑操控桌面 Overlay（透明穿透窗口）的轻量页面，
      // 不加载工作台 SPA；打包产物随 frontendDist 一起被 Tauri 壳使用。
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
      },
    },
  },
});
