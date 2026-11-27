import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PluginCatalogView, PluginUpdate, PluginView, PluginsView } from "../../../shared/types.ts";

vi.mock("../store.ts", () => ({
  MOCK: false,
  useApp: () => ({ assistants: [], pluginSignIn: {}, pluginProviderTick: 0, pluginUpdates: [], pluginInstall: {} }),
  openPlugins: vi.fn(),
  closePlugins: vi.fn(),
  addCustomPlugin: vi.fn(),
  addPluginSource: vi.fn(),
  clearPluginInstallProgress: vi.fn(),
  deletePluginSource: vi.fn(),
  refreshPluginSources: vi.fn(),
  installPlugin: vi.fn(),
  updatePlugin: vi.fn(),
  loadPluginCatalog: vi.fn(),
  loadPlugins: vi.fn(),
}));

import { PluginNav, PluginRow } from "./Plugins.tsx";
import { PluginUpdateRow } from "./PluginDetail.tsx";
import { pluginOverallStatus, pluginUpdateVersion } from "./plugin-meta.ts";

function makePlugin(id: string, source: string, version: string): PluginView {
  return {
    plugin: { id, version, source, enabled: true, tools: {}, config: {} },
    manifest: { name: id, displayName: id },
    config: {},
    missing: [],
    services: [{ pluginId: id, name: id, status: "connected", tools: [] }],
  };
}

describe("插件更新列表与详情提示", () => {
  it("已安装列表行与左侧插件导航只给有新版本的来源插件显示小圆点", () => {
    const github = makePlugin("github", "official", "1.0.0");
    const email = makePlugin("email", "official", "1.0.0");
    const vault = makePlugin("vault", "builtin", "1.0.0");
    const custom = makePlugin("my-mcp", "custom", "1.0.0");
    const view: PluginsView = { plugins: [github, email, vault, custom], migrationErrors: [] };
    const catalog: PluginCatalogView = {
      sources: [{ id: "official", name: "Hob 官方", url: "https://example.test" }],
      plugins: [
        { id: "github", version: "1.2.0", source: "official", manifest: { name: "github" }, installed: true },
        { id: "email", version: "1.0.0", source: "official", manifest: { name: "email" }, installed: true },
        { id: "vault", version: "2.0.0", source: "builtin", manifest: { name: "vault" }, installed: true },
      ],
    };
    const updates: PluginUpdate[] = [{ id: "github", source: "official", current: "1.0.0", latest: "1.2.0" }];

    expect(pluginUpdateVersion(github, catalog, updates)).toBe("1.2.0");
    expect(pluginUpdateVersion(email, catalog, updates)).toBeNull();
    expect(pluginUpdateVersion(vault, catalog, updates)).toBeNull();
    expect(pluginUpdateVersion(custom, catalog, updates)).toBeNull();

    const navHtml = renderToStaticMarkup(
      <PluginNav narrow={false} page="installed" pluginId="github" view={view} catalog={catalog} pluginUpdates={updates} />,
    );
    expect(navHtml.match(/class="update-dot"/g)?.length).toBe(1);
    expect(navHtml).toContain('title="有新版本 1.2.0"');

    const updatableRow = renderToStaticMarkup(
      <PluginRow id="github" manifest={github.manifest} badge={pluginOverallStatus(github)} installed updateVersion="1.2.0" />,
    );
    expect(updatableRow).toContain('class="update-dot"');
    expect(updatableRow).toContain('title="有新版本 1.2.0"');

    const latestRow = renderToStaticMarkup(
      <PluginRow id="email" manifest={email.manifest} badge={pluginOverallStatus(email)} installed updateVersion={null} />,
    );
    expect(latestRow).not.toContain("update-dot");
  });

  it("插件详情页「有新版本」行显示版本号与更新按钮", () => {
    const html = renderToStaticMarkup(<PluginUpdateRow version="1.2.0" onUpdate={() => {}} />);
    expect(html).toContain("有新版本 1.2.0");
    expect(html).toContain(">更新</button>");
  });
});
