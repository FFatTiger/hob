import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginUpdate, UpdateCheck } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({
  assistants: [],
  groups: [],
  groupPrefs: {},
  query: "",
  search: false,
  sel: null as string | null,
  gsel: null as string | null,
  section: "about" as string | null,
  sub: null,
  update: null as UpdateCheck | null,
  pluginUpdates: [] as PluginUpdate[],
  settings: {
    revision: 1,
    settings: {
      general: { theme: "system", timezone: "UTC", proxy: "", noProxy: "", aboutYou: { name: "", language: "", notes: "" } },
      providers: [],
      models: { roster: [], conversation: { ref: "", thinking: "low" }, work: { ref: "", thinking: "high" } },
      image: { source: "off" },
      search: { providers: [] },
      work: { maxJobs: 2, jobStallMinutes: 15, routerStallMinutes: 6 },
      push: { email: "" },
    },
  },
  theme: "system" as const,
  palette: "default" as const,
  locale: "zh-CN" as const,
  globalRules: { rules: [], error: null, busy: false },
}));

vi.mock("../store.ts", () => ({
  useApp: () => state,
  useAppSelect: (pick: (s: unknown) => unknown) => pick(state),
  shallow: () => false,
  getState: () => state,
  goHome: vi.fn(),
  openKnowledge: vi.fn(),
  openPlugins: vi.fn(),
  openSettings: vi.fn(),
  openStars: vi.fn(),
  toggleSideCollapsed: vi.fn(),
  closeSettings: vi.fn(),
  closeSub: vi.fn(),
  setSection: vi.fn(),
  loadAbout: vi.fn().mockResolvedValue(null),
}));
vi.mock("./CommandPalette.tsx", () => ({ cmdkShortcut: () => "⌘K", triggerCommandPalette: vi.fn() }));
vi.mock("./HomeSections.tsx", () => ({ HomeSections: () => null, pinLayout: () => ({ cls: "", size: 42 }), Pin: () => null }));
vi.mock("./Groups.tsx", () => ({ GroupPin: () => null }));
vi.mock("./GroupCreate.tsx", () => ({ PlusButton: () => null }));
vi.mock("./PinDrag.ts", () => ({ usePinDrag: () => ({ order: [], locked: false, grid: { current: null }, className: () => "", target: () => ({}) }) }));
vi.mock("./Panel.tsx", () => ({ Panel: () => null }));
vi.mock("./Markdown.tsx", () => ({ Markdown: () => null }));
vi.mock("./Usage.tsx", () => ({ UsageSection: () => null }));

import { MobileList } from "./Mobile.tsx";
import { SettingsPage } from "./Settings.tsx";
import { Sidebar } from "./Sidebar.tsx";

describe("新版本小箭头提示", () => {
  beforeEach(() => {
    state.update = null;
    state.pluginUpdates = [];
    state.section = "about";
  });

  it("左栏底部「设置」有新版本时带强调色小箭头和读屏说明，没有时不显示", () => {
    const plain = renderToStaticMarkup(<Sidebar />);
    expect(plain).toContain(">设置</span>");
    expect(plain).not.toContain("update-dot");
    expect(plain).not.toContain("有新版本");

    state.update = { status: "up-to-date", latest: "1.14.0" };
    expect(renderToStaticMarkup(<Sidebar />)).not.toContain("update-dot");

    state.update = { status: "error", error: "请求超时" };
    expect(renderToStaticMarkup(<Sidebar />)).not.toContain("update-dot");

    state.update = { status: "available", latest: "1.15.0" };
    const withUpdate = renderToStaticMarkup(<Sidebar />);
    expect(withUpdate).toContain('class="update-dot"');
    expect(withUpdate).toContain('title="有新版本 1.15.0"');
    expect(withUpdate).toContain('aria-label="有新版本 1.15.0"');
  });

  it("设置页桌面导航和手机列表中「关于」有新版本时带小箭头，没有时不显示", () => {
    const desktopPlain = renderToStaticMarkup(<SettingsPage narrow={false} leaving={false} />);
    expect(desktopPlain).not.toContain("update-dot");

    state.section = null;
    const mobilePlain = renderToStaticMarkup(<SettingsPage narrow leaving={false} />);
    expect(mobilePlain).not.toContain("update-dot");

    state.update = { status: "available", latest: "1.15.0" };
    state.section = "about";
    const desktopUpdate = renderToStaticMarkup(<SettingsPage narrow={false} leaving={false} />);
    expect(desktopUpdate).toMatch(/关于<span class="update-dot" title="有新版本 1\.15\.0" role="img" aria-label="有新版本 1\.15\.0">/);

    state.section = null;
    const mobileUpdate = renderToStaticMarkup(<SettingsPage narrow leaving={false} />);
    expect(mobileUpdate).toMatch(/关于<span class="update-dot" title="有新版本 1\.15\.0" role="img" aria-label="有新版本 1\.15\.0">/);
  });

  it("手机端首页设置入口有新版本时带小箭头，没有时保持原样", () => {
    const plain = renderToStaticMarkup(<MobileList />);
    expect(plain).toContain('class="me"');
    expect(plain).not.toContain("has-update");
    expect(plain).not.toContain("update-dot");

    state.update = { status: "available", latest: "1.15.0" };
    const withUpdate = renderToStaticMarkup(<MobileList />);
    expect(withUpdate).toContain('class="me has-update"');
    expect(withUpdate).toContain('class="update-dot"');
    expect(withUpdate).toContain('aria-label="有新版本 1.15.0"');
  });

  it("左栏与手机首页「插件」入口有可更新插件时带圆点与个数说明，没有时保持原样", () => {
    const desktopPlain = renderToStaticMarkup(<Sidebar />);
    expect(desktopPlain).toContain(">插件</span>");
    expect(desktopPlain).not.toContain("update-dot");

    const mobilePlain = renderToStaticMarkup(<MobileList />);
    expect(mobilePlain).toContain('title="插件"');
    expect(mobilePlain).not.toContain("个插件有新版本");

    state.pluginUpdates = [
      { id: "github", source: "official", current: "1.0.0", latest: "1.2.0" },
      { id: "email", source: "official", current: "1.0.0", latest: "1.1.0" },
    ];
    const desktopUpdate = renderToStaticMarkup(<Sidebar />);
    expect(desktopUpdate).toMatch(/插件<span class="update-dot" title="2 个插件有新版本" role="img" aria-label="2 个插件有新版本"/);

    const mobileUpdate = renderToStaticMarkup(<MobileList />);
    expect(mobileUpdate).toContain('class="hob-icon-btn has-update"');
    expect(mobileUpdate).toContain('title="插件 · 2 个插件有新版本"');
    expect(mobileUpdate).toContain('aria-label="2 个插件有新版本"');
  });
});
