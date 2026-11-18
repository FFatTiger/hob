import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ImageViewerHost } from "./components/FilePreview.tsx";
import { startHistory } from "./history.ts";
import { registerServiceWorker } from "./pwa.ts";
// 文件预览里的文档排版用 GitHub 的样式表；颜色在 styles.css 里换成 Hob 自己的
import "github-markdown-css/github-markdown.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<><App /><ImageViewerHost /></>);

// 手机上侧滑 / 返回键退回上一层页面
startHistory();

// iOS Safari 不认 user-scalable=no：双指缩放在这里拦掉，页面像 App 一样固定
document.addEventListener("gesturestart", (event) => event.preventDefault());

// iPhone 主屏应用：键盘收起、从后台切回来后，iOS 有时不把页面高度还原，整页比屏幕高、输入框被挤出底部
// （划掉重开就好）。这几个时机按当前可见高度重设一次，并把残留的整页滚动归零。
if ((navigator as Navigator & { standalone?: boolean }).standalone) {
  const fit = () => {
    document.documentElement.style.setProperty("--app-h", `${window.innerHeight}px`);
    if (window.scrollY) window.scrollTo(0, 0);
  };
  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("pageshow", fit);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") fit(); });
  document.addEventListener("focusout", () => setTimeout(fit, 100));
}

// 只在生产构建里注册：开发时免得 Vite 的热更新被缓存的旧壳挡住
if (import.meta.env.PROD) registerServiceWorker();


