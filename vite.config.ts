import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web 是前端根目录；开发时 /api 代理到 server（HOB_PORT，默认 30148）
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: Number(process.env.HOB_WEB_PORT ?? 5173),
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.HOB_PORT ?? 30148}`, changeOrigin: true } },
  },
});
