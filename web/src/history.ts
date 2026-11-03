// 手机上的返回：每打开一层页面（对话、助手信息、设置的各级、任务、文件预览）就压一条浏览器历史。
// iPhone 侧滑、安卓返回键、浏览器后退都走 popstate，关掉最上面一层；
// 点页面里的返回按钮关掉的，同步退掉多出来的历史，免得之后侧滑多退一次。桌面不压历史。
import {
  backToJobs,
  closeDetail,
  closeFilePreview,
  closeSettings,
  closeSheet,
  closeSub,
  getState,
  setMobile,
  setSection,
  subscribe,
  type State,
} from "./store.ts";

type Layer = "chat" | "sheet" | "settings" | "section" | "sub" | "jobs" | "job" | "file";

/** 当前从底到顶叠着哪几层。 */
export function layers(s: State, narrow: boolean): Layer[] {
  if (!narrow) return [];
  const out: Layer[] = [];
  if (s.page === "settings") {
    out.push("settings");
    if (s.section) out.push("section");
    if (s.sub) out.push("sub");
  } else {
    if (s.mobile === "chat" && s.sel) out.push("chat");
    if (s.sheet) out.push("sheet");
  }
  if (s.detail?.kind === "jobs" || (s.detail?.kind === "job" && s.worklog)) out.push("jobs");
  if (s.detail?.kind === "job") out.push("job");
  if (s.filePreview) out.push("file");
  return out;
}

const CLOSE: Record<Layer, () => void> = {
  file: closeFilePreview,
  job: backToJobs,
  jobs: closeDetail,
  sheet: closeSheet,
  chat: () => setMobile("list"),
  sub: closeSub,
  section: () => setSection(null),
  settings: closeSettings,
};

export function startHistory(narrow: () => boolean = () => window.innerWidth < 768) {
  let pushed = 0;
  let skipPops = 0;
  let popping = false;
  history.replaceState({ hobDepth: 0 }, "");

  const sync = () => {
    if (popping) return;
    const n = layers(getState(), narrow()).length;
    while (pushed < n) history.pushState({ hobDepth: ++pushed }, "");
    if (pushed > n) {
      skipPops++;
      history.go(n - pushed);
      pushed = n;
    }
  };

  window.addEventListener("popstate", (event) => {
    if (skipPops > 0) {
      skipPops--;
      return;
    }
    const depth = Number((event.state as { hobDepth?: number } | null)?.hobDepth ?? 0);
    pushed = depth;
    popping = true;
    // 一次后退可能跨好几层（长按返回选更早的一条），逐层关到和历史一样深
    for (let guard = 0; guard < 10; guard++) {
      const top = layers(getState(), narrow()).at(-1);
      if (!top || layers(getState(), narrow()).length <= depth) break;
      CLOSE[top]();
    }
    popping = false;
    sync();
  });

  subscribe(sync);
  sync();
}
