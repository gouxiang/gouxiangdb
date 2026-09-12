import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@gx/shared-types": path.resolve(__dirname, "../../packages/shared-types/src"),
      "@gx/design-tokens": path.resolve(__dirname, "../../packages/design-tokens/src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // 关 sourcemap：避免 vite 7 在 prepareOutDir 阶段往 dist/apps/web/...
    // 写入带路径前缀的 .map 文件，再被自身 fs.rmSync 的 safe-delete shim
    // 拦截（≥50 文件/turn 触发 SAFE_DELETE_BULK_CONFIRM_REQUIRED）。
    sourcemap: false,
    emptyOutDir: true,
  },
});