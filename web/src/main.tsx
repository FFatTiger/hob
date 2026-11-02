import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// iOS Safari 不认 user-scalable=no：双指缩放在这里拦掉，页面像 App 一样固定
document.addEventListener("gesturestart", (event) => event.preventDefault());

// 只在生产构建里注册：开发时免得 Vite 的热更新被缓存的旧壳挡住
if (import.meta.env.PROD) registerServiceWorker();
