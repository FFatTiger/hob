import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { AssistantMenu } from "./components/AssistantMenu.tsx";
import { Chat, ChatPage } from "./components/Chat.tsx";
import { DropFiles } from "./components/DropFiles.tsx";
import { FilePreviewOverlay } from "./components/FilePreview.tsx";
import { JobOverlay } from "./components/JobDetail.tsx";
import { Login } from "./components/Login.tsx";
import { Knowledge } from "./components/Knowledge.tsx";
import { Plugins } from "./components/Plugins.tsx";
import { MobileList, Sheet } from "./components/Mobile.tsx";
import { Panel } from "./components/Panel.tsx";
import { PushPrompt } from "./components/PushPrompt.tsx";
import { SettingsPage } from "./components/Settings.tsx";
import { Stars } from "./components/Stars.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { AssistantSidebar, GroupSidebar, MobileAssistantTopics, MobileTopics } from "./components/Topics.tsx";
import { Home } from "./components/Home.tsx";
import { assistantSidebarFor, groupSidebarFor } from "./topics.ts";
import { useLeave } from "./motion.ts";
import { applyUpdate } from "./pwa.ts";
import { gonePages, layerList, pageKey, panelAssistant, panelDesk, type GonePage } from "./panel-stack.ts";
import { backPanel, answer, clearNotice, closeLoginDesktop, leaveChat, leaveTopicList, loadDesktopWidth, saveDesktopWidth, start, tick, useApp, type PanelPage } from "./store.ts";
import { isNarrow, updateStatusColor } from "./theme.ts";
import { useDesktopScreens } from "./desktop-screens.ts";
import { Avatar } from "./sprites.tsx";

const LoginDesktop = lazy(() => import("./components/DesktopView.tsx").then((module) => ({ default: module.DesktopView })));

/** 右栏的页一层层盖上去：新页从右边滑进来，下面的页不动也不隐藏；退掉的页滑出去以后再卸。换了助手直接换，不滑。 */
function useLayers(stack: PanelPage[], owner: string | null) {
  const [shown, setShown] = useState({ stack, owner });
  const [gone, setGone] = useState<GonePage[]>([]);
  if (shown.stack !== stack || shown.owner !== owner) {
    const keys = new Set(stack.map(pageKey));
    setGone(shown.owner !== owner ? [] : [...gone.filter((g) => !keys.has(pageKey(g.page))), ...gonePages(shown.stack, stack)]);
    setShown({ stack, owner });
  }
  useEffect(() => {
    if (!gone.length) return;
    const timer = setTimeout(() => setGone([]), 240);
    return () => clearTimeout(timer);
  }, [gone]);
  return layerList(stack, gone);
}

/** 页面已经写了「无法连接 Hob」，原始错误里重复的前缀去掉。 */
function rawError(text: string): string {
  return text.replace(/^无法连接 Hob：/, "");
}

export function App() {
  const s = useApp();
  const desktop = useDesktopScreens();
  const [narrow, setNarrow] = useState(isNarrow);
  const chat = useLeave(s.mobile === "chat" && Boolean(s.sel ?? s.gsel), 240);
  const settings = useLeave(s.page === "settings", 180);
  const knowledge = useLeave(s.page === "knowledge", 180);
  const plugins = useLeave(s.page === "plugins", 180);
  const sheet = useLeave(s.sheet, 180);
  // 左栏的群/多话题助手二级页（桌面）和手机的话题列表：退场时还要画着刚才那个群或助手，id 先记下来
  const sideGroup = groupSidebarFor(s.gsel, s.sideHome, s.groups);
  const sideAssistant = sideGroup ? undefined : assistantSidebarFor(s.sel, s.sideHome, s.assistants);
  const hasSecondarySide = Boolean(sideGroup || sideAssistant);
  const groupSide = useLeave(hasSecondarySide, 180);
  const sideTarget = useRef<{ kind: "group" | "assistant"; id: string } | undefined>(undefined);
  if (sideGroup) sideTarget.current = { kind: "group", id: sideGroup.id };
  else if (sideAssistant) sideTarget.current = { kind: "assistant", id: sideAssistant.id };
  // 打开页面时就在群或助手二级页：直接在那，不播推入
  const sideStill = useRef(hasSecondarySide);
  if (!groupSide.mounted) sideStill.current = false;
  const mobileAssistant = !s.gsel && s.sel ? s.assistants.find((a) => a.id === s.sel && Boolean(a.topics)) : undefined;
  const topicsPane = useLeave(s.mobile !== "list" && Boolean(s.gsel || mobileAssistant), 180);
  const topicsTarget = useRef<{ kind: "group" | "assistant"; id: string } | undefined>(undefined);
  if (s.mobile !== "list" && s.gsel) topicsTarget.current = { kind: "group", id: s.gsel };
  else if (s.mobile !== "list" && mobileAssistant) topicsTarget.current = { kind: "assistant", id: mobileAssistant.id };
  const top = s.panelStack.at(-1);
  const layers = useLayers(s.panelStack, s.sel);
  const mobileLayers = layers.map(({ page, leaving }) => (
    <div key={pageKey(page)} className={`mlayer${leaving ? " leaving" : ""}`}>
      {page.kind === "file" ? <FilePreviewOverlay page={page} />
        : page.kind === "job" || page.kind === "jobs" ? <JobOverlay page={page} />
        : <Sheet page={page} leaving={false} />}
    </div>
  ));

  useLayoutEffect(() => {
    updateStatusColor(s, narrow);
  }, [s.phase, s.page, s.mobile, s.sheet, s.panelStack, s.theme, narrow]);

  useEffect(() => {
    void start();
  }, []);

  useEffect(() => {
    const login = s.desktopLogin;
    if (!login) return;
    if (s.approvals[login.approvalId]?.status !== "pending") closeLoginDesktop();
  }, [s.desktopLogin, s.approvals]);

  const finishLogin = () => {
    const login = s.desktopLogin;
    closeLoginDesktop();
    if (login && s.approvals[login.approvalId]?.status === "pending") void answer(login.approvalId, { key: "A" });
  };
  const loginApproval = s.desktopLogin ? s.approvals[s.desktopLogin.approvalId] : undefined;
  const loginProfile = s.desktopLogin ? desktop.profiles[s.desktopLogin.assistantId] ?? s.desktopLogin.assistantId : undefined;
  const loginOverlay = s.desktopLogin && loginApproval?.status === "pending" && loginProfile ? (
    <Suspense fallback={null}><LoginDesktop initialScreen={loginProfile} takeOver login onClose={finishLogin} /></Suspense>
  ) : null;


  useEffect(() => {
    if (!s.panelStack.length) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) backPanel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.panelStack]);

  useEffect(() => {
    const onResize = () => setNarrow(isNarrow());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // “进行中 · N 分钟”要自己走
  useEffect(() => {
    const timer = setInterval(() => tick(), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const n =
      s.assistants.reduce((sum, a) => sum + a.unread, 0) +
      s.assistantTopics.reduce((sum, t) => sum + t.unread, 0) +
      s.groups.reduce((sum, g) => sum + g.unread, 0);
    document.title = n > 0 ? `(${n}) Hob` : "Hob";
  }, [s.assistants, s.assistantTopics, s.groups]);

  useEffect(() => {
    if (!s.notice) return;
    const timer = setTimeout(() => clearNotice(), 6000);
    return () => clearTimeout(timer);
  }, [s.notice]);

  // 云桌面展开时右栏的宽度可以拖：往左拖变宽，最宽到样式里算出的上限（对话区留 420px、画面放得下高度）
  const panelwrap = useRef<HTMLDivElement>(null);
  const [desktopWidth, setDesktopWidth] = useState(loadDesktopWidth);
  // 手机左边缘跟手右滑返回（必须位于所有条件 return 之前，遵守 React Hooks 规则）
  const [edgeDrag, setEdgeDrag] = useState<{ target: "chat" | "topics"; dx: number } | null>(null);
  const edgeRef = useRef<{ target: "chat" | "topics"; startX: number; startY: number; dx: number; active: boolean; locked: "h" | "v" | null } | null>(null);
  const edgeHandlers = (target: "chat" | "topics", commit: () => void) => ({
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch" || event.clientX > 28) return;
      edgeRef.current = { target, startX: event.clientX, startY: event.clientY, dx: 0, active: true, locked: null };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const st = edgeRef.current;
      if (!st?.active || st.target !== target) return;
      const dx = event.clientX - st.startX;
      const dy = event.clientY - st.startY;
      if (!st.locked && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        st.locked = dx > 0 && Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }
      if (st.locked === "h") {
        st.dx = Math.max(0, dx);
        setEdgeDrag({ target, dx: st.dx });
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      const st = edgeRef.current;
      if (!st?.active || st.target !== target) return;
      const finalDx = st.dx;
      edgeRef.current = null;
      setEdgeDrag(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (finalDx > Math.min(120, window.innerWidth * 0.32)) commit();
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      edgeRef.current = null;
      setEdgeDrag(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
  });
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const wrap = panelwrap.current;
    if (!wrap || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = wrap.getBoundingClientRect().width;
    wrap.classList.add("resizing");
    const move = (e: PointerEvent) => wrap.style.setProperty("--desk-w", `${Math.max(360, startWidth + startX - e.clientX)}px`);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      wrap.classList.remove("resizing");
      // 存实际显示出来的宽度：拖过了上限也只记上限
      const width = wrap.getBoundingClientRect().width;
      setDesktopWidth(width);
      saveDesktopWidth(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  if (s.phase === "login") return <Login />;

  if (s.phase === "error") {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="t">{t("无法连接 Hob")}</div>
          <div className="d">{t("请检查网络，或确认 Hob 服务已启动。")}</div>
          <button className="hob-btn hob-btn-primary" onClick={() => location.reload()}>
            {t("重试")}
          </button>
          {s.error ? <div className="raw">{rawError(s.error)}</div> : null}
        </div>
      </div>
    );
  }

  if (s.phase === "loading") return <div className="boot"><div className="boot-loading"><Avatar sprite="hob" size={92} motion="think" /><span className="activity-shimmer">{t("正在连接 Hob…")}</span></div></div>;

  const toast = s.notice ? (
    <div className="toast">{s.notice}</div>
  ) : s.updateReady ? (
    <button className="upd" onClick={() => void applyUpdate()}>
      {t("有新版本，点击更新")}
    </button>
  ) : null;

  const pushPrompt = <PushPrompt />;

  // 拖文件进窗口：只在界面里接管，登录页/连不上时不管
  const drop = <DropFiles />;

  if (settings.mounted) {
    return (
      <>
        <SettingsPage narrow={narrow} leaving={settings.leaving} />
        {/* 设置 → 工作 → 查看全部任务：任务记录直接盖在设置页上 */}
        {narrow ? mobileLayers : <><JobOverlay /><FilePreviewOverlay /></>}
        {drop}
        {toast}
        {pushPrompt}
        {loginOverlay}
      </>
    );
  }

  if (s.page === "stars") return <><Stars narrow={narrow} />{toast}{pushPrompt}{loginOverlay}</>;
  if (plugins.mounted) return <><Plugins narrow={narrow} leaving={plugins.leaving} />{toast}{pushPrompt}{loginOverlay}</>;

  if (knowledge.mounted) {
    return (
      <>
        {/* 知识库自己能拖文件进分类，这里不接管，免得一次拖放传两份 */}
        <Knowledge narrow={narrow} leaving={knowledge.leaving} />
        {narrow ? mobileLayers : null}
        {toast}
        {pushPrompt}
        {loginOverlay}
      </>
    );
  }

  const fullPage = (top?.kind === "file" || top?.kind === "job") && top.full;
  // 任务、文件这类宽页打开时右栏自己变宽，把对话区挤窄，不盖在对话上
  const widePage = top?.kind === "file" || top?.kind === "job" || top?.kind === "jobs";
  // 桌面没打开对话就是首页：右栏收起，点开的任务、文件照样盖上来
  const home = !s.sel && !s.gsel;
  const sideHidden = s.sideCollapsed && !home;
  const desktopFocus = s.nowWide && (!s.gsel || !top || top.kind === "member") && panelDesk(
    s.panelStack,
    s.sel,
    s.gsel,
    s.groups,
    desktop,
    !s.gsel && s.tsel ? { topicId: s.tsel } : undefined,
    Boolean(!s.gsel && !s.tsel && s.assistants.find((a) => a.id === panelAssistant(s.panelStack, s.sel))?.topics),
  ).running;

  if (narrow) {
    const vw = typeof window !== "undefined" ? window.innerWidth || 390 : 390;
    const chatDrag = edgeDrag?.target === "chat" ? edgeDrag.dx : 0;
    const topicsDrag = edgeDrag?.target === "topics" ? edgeDrag.dx : 0;
    const chatProgress = Math.min(1, chatDrag / vw);
    const topicsProgress = Math.min(1, topicsDrag / vw);
    return (
      <>
        <div className="mapp">
          <div
            className={`mpane list${s.mobile === "list" ? "" : " back"}${topicsDrag > 0 || (chatDrag > 0 && !topicsPane.mounted) ? " dragging" : ""}`}
            style={topicsDrag > 0 ? { transform: `translateX(${-30 * (1 - topicsProgress)}%)` } : chatDrag > 0 && !topicsPane.mounted ? { transform: `translateX(${-30 * (1 - chatProgress)}%)` } : undefined}
            inert={s.mobile !== "list"}
          >
            <MobileList />
          </div>
          {topicsPane.mounted && topicsTarget.current ? (
            <div
              className={`mpane topics${topicsPane.leaving ? " out" : s.mobile === "chat" ? " back" : ""}${topicsDrag > 0 || chatDrag > 0 ? " dragging" : ""}`}
              style={topicsDrag > 0 ? { transform: `translateX(${topicsDrag}px)` } : chatDrag > 0 ? { transform: `translateX(${-30 * (1 - chatProgress)}%)` } : undefined}
              inert={s.mobile === "chat" || topicsPane.leaving}
              {...edgeHandlers("topics", leaveTopicList)}
            >
              {topicsTarget.current.kind === "group"
                ? <MobileTopics groupId={topicsTarget.current.id} />
                : <MobileAssistantTopics assistantId={topicsTarget.current.id} />}
            </div>
          ) : null}
          {chat.mounted ? (
            <div
              className={`mpane chat${chat.leaving ? " out" : ""}${chatDrag > 0 ? " dragging" : ""}`}
              style={chatDrag > 0 ? { transform: `translateX(${chatDrag}px)` } : undefined}
              {...edgeHandlers("chat", leaveChat)}
            >
              <ChatPage />
            </div>
          ) : null}
          {sheet.mounted ? <Sheet leaving={sheet.leaving} page={null} /> : null}
          {mobileLayers}
        </div>
        <AssistantMenu />
        {drop}
        {toast}
        {pushPrompt}
        {loginOverlay}
      </>
    );
  }

  return (
    <div className={`app${fullPage ? " preview-full" : ""}${sideHidden ? " side-collapsed" : ""}`}>
      <div className="sidestack" inert={sideHidden}>
        <div className={`sidepane home${hasSecondarySide ? " away" : ""}`} aria-hidden={hasSecondarySide ? true : undefined}>
          <Sidebar />
        </div>
        {groupSide.mounted && sideTarget.current ? (
          <div className={`sidepane grp${groupSide.leaving ? " out" : ""}${sideStill.current ? " still" : ""}`}>
            {sideTarget.current.kind === "group"
              ? <GroupSidebar groupId={sideTarget.current.id} />
              : <AssistantSidebar assistantId={sideTarget.current.id} />}
          </div>
        ) : null}
      </div>
      {home ? <Home /> : <Chat />}
      {/* 右栏宽度跟根页走（收起、云桌面展开），宽页（任务、文件）打开时变宽、把对话区挤窄；上面的页一层层盖在右栏里 */}
      <div ref={panelwrap} className={`panelwrap${fullPage ? " full" : widePage ? " wide page" : home || s.collapsed ? " off" : desktopFocus ? " wide focus" : s.nowWide ? " wide" : ""}`} style={desktopWidth ? { ["--desk-w" as string]: `${desktopWidth}px` } : undefined}>
        {desktopFocus && !widePage && !fullPage && !home && !s.collapsed ? <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label={t("拖动调整云桌面宽度")} onPointerDown={startResize} /> : null}
        {/* 首页右栏是收起的：不渲染根页，免得回首页那一刻在滑出去的面板里重画一遍主助手的资料 */}
        {home ? null : <Panel page={null} />}
        {layers.map(({ page, leaving }) => (
          <div key={pageKey(page)} className={`panel-layer${page.kind === "file" || page.kind === "job" || page.kind === "jobs" ? " wide" : ""}${page.kind === "job" && page.instant ? " instant" : ""}${leaving ? " leaving" : ""}`}>
            {page.kind === "file" ? <FilePreviewOverlay embedded page={page} />
              : page.kind === "job" || page.kind === "jobs" ? <JobOverlay embedded page={page} />
              : <Panel page={page} />}
          </div>
        ))}
      </div>
      <AssistantMenu />
      {s.offline ? <div className="toast">{s.offline}</div> : null}
      {drop}
      {toast}
      {pushPrompt}
      {loginOverlay}
    </div>
  );
}
