import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 部署子路径（飞牛 fnOS 统一网关）：
//   VITE_BASE_PATH=/app/gouxiangdb → base 归一为 "/app/gouxiangdb/"
// 未设置、空白或为 "/" 时维持根路径部署现状（base="/"）。纯 node 归一，不引依赖。
const RAW_BASE = process.env.VITE_BASE_PATH?.trim();
const BASE_PATH =
  RAW_BASE && RAW_BASE !== "/" ? `/${RAW_BASE.replace(/^\/+|\/+$/g, "")}/` : "/";

const API_TARGET = "http://localhost:3001";

export default defineConfig({
  // base 同时注入 import.meta.env.BASE_URL（client.ts 据此解析 API 同源前缀）
  base: BASE_PATH,
  plugins: [react()],
  resolve: {
    alias: {
      "@gx/shared-types": path.resolve(__dirname, "../../packages/shared-types/src"),
      "@gx/blocks": path.resolve(__dirname, "../../packages/blocks/src"),
      "@gx/design-tokens": path.resolve(__dirname, "../../packages/design-tokens/src"),
    },
  },
  server: {
    port: 5173,
    proxy: (() => {
      // 严格回归：5 个根前缀与改造前完全一致（均带 changeOrigin: true）。
      const rootPrefixes = ["/api", "/health", "/healthz", "/readyz", "/uploads"];
      const proxy: Record<string, { target: string; changeOrigin: true }> = {};
      for (const p of rootPrefixes) {
        proxy[p] = { target: API_TARGET, changeOrigin: true };
      }
      // 子路径本地模拟网关：整段前缀透传到 :3001（/app/gouxiangdb/api、
      // /app/gouxiangdb/healthz 等自然命中）。不改写路径，与生产网关 + 后端双形态一致。
      if (BASE_PATH !== "/") {
        proxy[BASE_PATH.replace(/\/$/, "")] = { target: API_TARGET, changeOrigin: true };
      }
      return proxy;
    })(),
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
