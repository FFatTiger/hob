import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssistantMenu } from "./components/AssistantMenu.tsx";
import { Chat, ChatPage } from "./components/Chat.tsx";
import { FilePreviewOverlay } from "./components/FilePreview.tsx";
import { JobOverlay } from "./components/JobDetail.tsx";
import { Login } from "./components/Login.tsx";
import { Knowledge } from "./components/Knowledge.tsx";
import { MobileList, Sheet } from "./components/Mobile.tsx";
import { Panel } from "./components/Panel.tsx";
import { SettingsPage } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { useLeave } from "./motion.ts";
import { applyUpdate } from "./pwa.ts";
import { backPanel, clearNotice, start, tick, useApp, type PanelPage } from "./store.ts";
import { updateStatusColor } from "./theme.ts";
import { Avatar } from "./sprites.tsx";

function pageKey(page: PanelPage): string {
  return `${page.kind}:${"id" in page ? page.id : "path" in page ? page.liveId ?? page.path : ""}`;
}

/** 页面已经写了「无法连接 Hob」，原始错误里重复的前缀去掉。 */
function rawError(text: string): string {
  return text.replace(/^无法连接 Hob：/, "");
}

export function App() {
  const s = useApp();
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  const chat = useLeave(s.mobile === "chat" && Boolean(s.sel), 240);
  const settings = useLeave(s.page === "settings", 180);
  const knowledge = useLeave(s.page === "knowledge", 180);
  const sheet = useLeave(s.sheet, 180);
  const top = s.panelStack.at(-1);
  const key = top ? pageKey(top) : "root";
  const previous = useRef({ key, depth: s.panelStack.length, direction: "" });
  if (previous.current.key !== key) previous.current = { key, depth: s.panelStack.length, direction: s.panelStack.length > previous.current.depth ? "from-right" : "from-left" };
  if (narrow && !s.sheet && !top) previous.current.direction = "";

  useLayoutEffect(() => {
    updateStatusColor(s, narrow);
  }, [s.phase, s.page, s.mobile, s.sheet, s.panelStack, s.theme, narrow]);

  useEffect(() => {
    void start();
  }, []);

  useEffect(() => {
    if (!s.panelStack.length) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) backPanel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.panelStack]);

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
        <JobOverlay direction={narrow ? previous.current.direction : ""} />
        <FilePreviewOverlay direction={narrow ? previous.current.direction : ""} />
        {toast}
      </>
    );
  }

  if (knowledge.mounted) {
    return (
      <>
        <Knowledge narrow={narrow} leaving={knowledge.leaving} />
        {narrow ? <FilePreviewOverlay direction={previous.current.direction} /> : null}
        {toast}
      </>
    );
  }

  const filePreview = top?.kind === "file" ? top : null;
  const detail = top?.kind === "job" || top?.kind === "jobs";

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
          {sheet.mounted ? <div style={{ display: top ? "none" : undefined }}><Sheet leaving={sheet.leaving} page={null} layered={!top && previous.current.direction === "from-left"} direction="from-left" /></div> : null}
          {s.panelStack.map((page, index) => {
            const active = index === s.panelStack.length - 1;
            const direction = active ? previous.current.direction : "";
            return <div key={pageKey(page)} style={{ display: active ? undefined : "none" }}>
              {page.kind === "file" ? <FilePreviewOverlay page={page} direction={direction} />
                : page.kind === "job" || page.kind === "jobs" ? <JobOverlay page={page} direction={direction} />
                : <Sheet page={page} leaving={false} layered direction={direction} />}
            </div>;
          })}
        </div>
        <AssistantMenu />
        {toast}
      </>
    );
  }

  return (
    <div className={`app${filePreview?.full ? " preview-full" : ""}`}>
      <Sidebar />
      <Chat />
      <div className={`panelwrap${filePreview?.full ? " full" : ""}${filePreview || detail || (!top && s.nowWide) ? " wide" : ""}${!top && s.collapsed ? " off" : ""}`}>
        <div className={`panel-page${!top && previous.current.direction ? ` ${previous.current.direction}` : ""}`} style={{ display: top ? "none" : undefined }}><Panel page={null} /></div>
        {s.panelStack.map((page, index) => {
          const active = index === s.panelStack.length - 1;
          return <div key={pageKey(page)} className={`panel-page${active && previous.current.direction ? ` ${previous.current.direction}` : ""}`} style={{ display: active ? undefined : "none" }}>
            {page.kind === "file" ? <FilePreviewOverlay embedded page={page} />
              : page.kind === "job" || page.kind === "jobs" ? <JobOverlay embedded page={page} />
              : <Panel page={page} />}
          </div>;
        })}
      </div>
      <AssistantMenu />
      {s.offline ? <div className="toast">{s.offline}</div> : null}
      {toast}
    </div>
  );
}
