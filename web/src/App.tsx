import { useEffect, useLayoutEffect, useState } from "react";
import { AssistantMenu } from "./components/AssistantMenu.tsx";
import { Chat, ChatPage } from "./components/Chat.tsx";
import { FilePreviewOverlay } from "./components/FilePreview.tsx";
import { JobOverlay } from "./components/JobDetail.tsx";
import { Login } from "./components/Login.tsx";
import { MobileList, Sheet } from "./components/Mobile.tsx";
import { Panel } from "./components/Panel.tsx";
import { SettingsPage } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { useLeave } from "./motion.ts";
import { applyUpdate } from "./pwa.ts";
import { clearNotice, start, tick, useApp } from "./store.ts";
import { updateStatusColor } from "./theme.ts";
import { Avatar } from "./sprites.tsx";

/** 页面已经写了「无法连接 Hob」，原始错误里重复的前缀去掉。 */
function rawError(text: string): string {
  return text.replace(/^无法连接 Hob：/, "");
}

export function App() {
  const s = useApp();
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  const chat = useLeave(s.mobile === "chat" && Boolean(s.sel), 240);
  const settings = useLeave(s.page === "settings", 180);
  const sheet = useLeave(s.sheet, 180);

  useLayoutEffect(() => {
    updateStatusColor(s, narrow);
  }, [s.phase, s.page, s.mobile, s.sheet, s.detail, s.filePreview, s.theme, narrow]);

  useEffect(() => {
    void start();
  }, []);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // “进行中 · N 分钟”要自己走
  useEffect(() => {
    const timer = setInterval(() => tick(), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const n = s.assistants.reduce((sum, a) => sum + a.unread, 0);
    document.title = n > 0 ? `(${n}) Hob` : "Hob";
  }, [s.assistants]);

  useEffect(() => {
    if (!s.notice) return;
    const timer = setTimeout(() => clearNotice(), 6000);
    return () => clearTimeout(timer);
  }, [s.notice]);

  if (s.phase === "login") return <Login />;

  if (s.phase === "error") {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="t">无法连接 Hob</div>
          <div className="d">请检查网络，或确认 Hob 服务已启动。</div>
          <button className="btn solid" onClick={() => location.reload()}>
            重试
          </button>
          {s.error ? <div className="raw">{rawError(s.error)}</div> : null}
        </div>
      </div>
    );
  }

  if (s.phase === "loading") return <div className="boot"><div className="boot-loading"><Avatar sprite="hob" size={92} motion="think" /><span className="activity-shimmer">正在连接 Hob…</span></div></div>;

  const toast = s.notice ? (
    <div className="toast">{s.notice}</div>
  ) : s.updateReady ? (
    <button className="upd" onClick={() => void applyUpdate()}>
      有新版本，点击更新
    </button>
  ) : null;

  if (settings.mounted) {
    return (
      <>
        <SettingsPage narrow={narrow} leaving={settings.leaving} />
        {/* 设置 → 工作 → 查看全部任务：任务记录直接盖在设置页上 */}
        <JobOverlay />
        <FilePreviewOverlay />
        {toast}
      </>
    );
  }

  if (narrow) {
    return (
      <>
        <div className="mapp">
          <div className={`mpane list${s.mobile === "chat" ? " back" : ""}`}>
            <MobileList />
          </div>
          {chat.mounted ? (
            <div className={`mpane chat${chat.leaving ? " out" : ""}`}>
              <ChatPage />
            </div>
          ) : null}
          {sheet.mounted ? <Sheet leaving={sheet.leaving} /> : null}
        </div>
        <AssistantMenu />
        <JobOverlay />
        <FilePreviewOverlay />
        {toast}
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <Chat />
      <div className={`panelwrap${s.detail ? " detail" : s.collapsed ? " off" : ""}`}>
        {s.detail ? <JobOverlay embedded /> : <Panel />}
      </div>
      <FilePreviewOverlay />
      <AssistantMenu />
      {s.offline ? <div className="toast">{s.offline}</div> : null}
      {toast}
    </div>
  );
}
