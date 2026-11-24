import { useEffect, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { newerPluginVersion } from "../../../shared/plugin-version.ts";
import type { PluginCatalogView, PluginServiceStatus, PluginsView } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { fmtWhen } from "../util.ts";
import { addCustomPlugin, addPluginSource, deletePluginSource, refreshPluginSources, closePlugins, installPlugin, updatePlugin, loadPluginCatalog, loadPlugins, openPlugins, useApp, MOCK, type PluginPage } from "../store.ts";
import { DialogShell } from "./DialogShell.tsx";
import { PluginDetail } from "./PluginDetail.tsx";
import "./plugins.css";

export function pluginName(manifest: Record<string, unknown>, id: string) {
  return typeof manifest.displayName === "string" ? manifest.displayName : typeof manifest.name === "string" ? manifest.name : id;
}

export function pluginDescription(manifest: Record<string, unknown>, id: string): string {
  return id === "vault" ? t("存网站的账号和密码。助手只看得到存了哪些账号，看不到密码；要登录、注册时，由 Hob 核对网址、请你批准后直接填进网页。") : String(manifest.description ?? "");
}

export function pluginStatus(status: PluginServiceStatus) {
  return ({ pending_config: t("待配置"), connecting: t("连接中"), idle: t("未启动（用到时自动启动）"), connected: t("运行中"), needs_login: t("需要登录"), needs_relogin: t("需要重新登录"), error: t("出错") })[status];
}

export function PluginStatus({ status }: { status: PluginServiceStatus }) {
  return <span className={`plugin-state ${status}`}><span className="plugin-state-dot" />{pluginStatus(status)}</span>;
}

function CredentialStatus() {
  return <span className="plugin-state connected"><span className="plugin-state-dot" />{t("已开启")}</span>;
}

function pluginServiceStatus(item: PluginsView["plugins"][number]): PluginServiceStatus | undefined {
  const priority: Record<PluginServiceStatus, number> = { error: 0, needs_relogin: 1, needs_login: 2, pending_config: 3, connecting: 4, idle: 5, connected: 6 };
  return item.services.map(service => service.status).sort((a, b) => priority[a] - priority[b])[0];
}

/** 需要处理的排在前面，停用的排最后。 */
function sortInstalled(plugins: PluginsView["plugins"]) {
  const rank = (item: PluginsView["plugins"][number]) => {
    if (!item.plugin.enabled) return 5;
    return ({ pending_config: 0, needs_login: 1, needs_relogin: 2, error: 3, connecting: 4, idle: 8, connected: 9 } as Record<PluginServiceStatus, number>)[pluginServiceStatus(item) ?? "connected"];
  };
  return [...plugins].sort((a, b) => rank(a) - rank(b));
}

export function PluginIcon({ name: _name, id, manifest, source }: { name: string; id: string; manifest: Record<string, unknown>; source?: string }) {
  const [failed, setFailed] = useState(false);
  const extensions = manifest.extensions as Record<string, unknown> | undefined;
  const hob = extensions?.["com.hob.plugins"] as Record<string, unknown> | undefined;
  const src = MOCK && typeof manifest.mockIcon === "string" ? manifest.mockIcon : typeof hob?.icon === "string" ? `/api/plugins/${encodeURIComponent(id)}/icon${source ? `?source=${encodeURIComponent(source)}` : ""}` : "";
  return <div className="plugin-icon">{src && !failed ? <img alt="" src={src} onError={() => setFailed(true)} /> : <Icon name={id === "vault" ? "key" : "plugin"} size={22} />}</div>;
}

function PluginNav({ narrow, page, pluginId, view }: { narrow: boolean; page: PluginPage; pluginId: string | null; view: PluginsView | null }) {
  const choose = (next: PluginPage) => openPlugins(null, next);
  if (narrow) return <nav className="home-filters plugin-categories" aria-label={t("插件分类")}>
    <button className={`home-filter${page === "installed" ? " on" : ""}`} onClick={() => choose("installed")}>{t("已安装")}</button>
    <button className={`home-filter${page === "market" ? " on" : ""}`} onClick={() => choose("market")}>{t("市场")}</button>
  </nav>;
  return <nav className="setnav" aria-label={t("插件分类")}>
    <div className="setnavtitle">{t("插件")}</div>
    <button className={`navrow plugin-market-nav${!pluginId && page !== "new" ? " sel" : ""}`} onClick={() => choose("market")}><Icon name="plugin" size={18} />{t("市场")}</button>
    <div className="knowledge-label">{t("已安装的插件")}</div>
    {sortInstalled(view?.plugins ?? []).map((item) => {
      const name = pluginName(item.manifest, item.plugin.id);
      const status = pluginServiceStatus(item);
      return <button className={`navrow plugin-navrow${pluginId === item.plugin.id ? " sel" : ""}`} key={item.plugin.id} onClick={() => openPlugins(item.plugin.id)}>
        <PluginIcon name={name} id={item.plugin.id} manifest={item.manifest} />
        <span className="plugin-nav-text"><span className="plugin-nav-name">{name}</span>{item.plugin.enabled ? (item.credentialRoles?.includes("list") ? <CredentialStatus /> : status ? <PluginStatus status={status} /> : null) : <span className="plugin-state disabled">{t("已停用")}</span>}</span>
      </button>;
    })}
    <button className={`navrow plugin-new${!pluginId && page === "new" ? " sel" : ""}`} onClick={() => choose("new")}>＋ {t("添加自定义 MCP")}</button>
    <span className="sp" />
    <button className="navrow" onClick={closePlugins}>{t("返回 Hob")}</button>
  </nav>;
}

function CustomPluginForm({ run }: { run: (action: () => Promise<unknown>) => void }) {
  const [id, setId] = useState("");
  const [mode, setMode] = useState<"remote" | "local">("remote");
  const [address, setAddress] = useState("");
  const [args, setArgs] = useState("");
  const [entries, setEntries] = useState("");
  const add = async () => {
    const pairs: Record<string, string> = {};
    for (const line of entries.split("\n").filter(Boolean)) {
      const index = line.indexOf("=");
      if (index < 1) throw new Error(t("每行请填写名称=值"));
      pairs[line.slice(0, index).trim()] = line.slice(index + 1);
    }
    const server = mode === "remote" ? { url: address, headers: pairs } : { command: address, args: args.split("\n").filter(Boolean), env: pairs };
    await addCustomPlugin(id.trim(), server);
    setId(""); setAddress(""); setEntries(""); setArgs("");
    openPlugins();
  };
  return <form className="plugin-section plugin-form" onSubmit={(event) => { event.preventDefault(); run(add); }}>
    <label className="lbl">{t("名称")}<input className="field" value={id} onChange={(event) => setId(event.target.value)} /></label>
    <label className="lbl">{t("连接方式")}<select className="field" value={mode} onChange={(event) => setMode(event.target.value as "remote" | "local")}><option value="remote">{t("远程地址")}</option><option value="local">{t("本机命令")}</option></select></label>
    <label className="lbl">{mode === "remote" ? t("远程地址") : t("本机命令")}<input className="field" value={address} onChange={(event) => setAddress(event.target.value)} /></label>
    {mode === "local" && <label className="lbl">{t("参数（每行一个）")}<textarea className="field" value={args} onChange={(event) => setArgs(event.target.value)} /></label>}
    <label className="lbl">{mode === "remote" ? t("请求头（每行名称=值）") : t("环境变量（每行名称=值）")}<textarea className="field" value={entries} onChange={(event) => setEntries(event.target.value)} /></label>
    <div className="plugin-actions"><button className="hob-btn hob-btn-primary">{t("添加")}</button></div>
  </form>;
}

function PluginRow({
  id,
  manifest,
  status,
  disabled = false,
  credentialProvider = false,
  installed = false,
  onOpen,
  action,
  source,
  sourceLabel,
  problem,
}: {
  id: string;
  manifest: Record<string, unknown>;
  status?: PluginServiceStatus;
  disabled?: boolean;
  installed?: boolean;
  credentialProvider?: boolean;
  onOpen?: () => void;
  action?: { label: string; onClick: () => void };
  source?: string;
  sourceLabel?: string;
  problem?: string;
}) {
  const name = pluginName(manifest, id);
  const description = pluginDescription(manifest, id);
  const clickable = Boolean(onOpen);
  return (
    <div
      className={`plugin-list-row${clickable ? " clickable" : ""}`}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } } : undefined}
    >
      <PluginIcon name={name} id={id} manifest={manifest} source={source} />
      <div className="info">
        <div className="name">{name}</div>
        <div className="desc">{description}</div>
        {sourceLabel && <div className="plugin-note">{sourceLabel}</div>}
        {problem && <div className="badline">{problem}</div>}
      </div>
      <span className="plugin-row-end">
        {action ? <button className="hob-btn plugin-install" onClick={(event) => { event.stopPropagation(); action.onClick(); }}>{action.label}</button> : disabled ? <span className="plugin-state disabled">{t("已停用")}</span> : credentialProvider ? <CredentialStatus /> : status ? <PluginStatus status={status} /> : installed ? <span className="plugin-state">{t("已安装")}</span> : null}
        {clickable && !action ? <Icon name="chev" size={15} className="plugin-row-chevron" /> : null}
      </span>
    </div>
  );
}

function hobExtension(manifest: Record<string, unknown>): Record<string, unknown> {
  const extensions = manifest.extensions as Record<string, unknown> | undefined;
  const hob = extensions?.["com.hob.plugins"];
  return hob && typeof hob === "object" ? hob as Record<string, unknown> : {};
}
function pluginCategories(manifest: Record<string, unknown>): string[] {
  const categories = hobExtension(manifest).categories;
  return Array.isArray(categories) ? categories.filter((value): value is string => typeof value === "string" && !!value) : [];
}
const CATEGORY_ORDER = ["communication", "productivity", "development", "data", "search", "design", "media", "finance", "home", "other"];
function categoryName(slug: string): string {
  return ({ communication: t("沟通"), productivity: t("效率"), development: t("开发工具"), data: t("数据"), search: t("搜索"), design: t("设计"), media: t("媒体"), finance: t("财务"), home: t("家居"), other: t("其他") } as Record<string, string>)[slug] ?? slug;
}

function PluginCard({ item, sourceLabel, update, onOpen, onInstall, onUpdate }: { item: PluginCatalogView["plugins"][number]; sourceLabel?: string; update: boolean; onOpen?: () => void; onInstall: () => void; onUpdate: () => void }) {
  const name = pluginName(item.manifest, item.id);
  const publisher = typeof hobExtension(item.manifest).publisher === "string" ? String(hobExtension(item.manifest).publisher) : "";
  const meta = [publisher, sourceLabel].filter(Boolean).join(" · ");
  const categories = pluginCategories(item.manifest).map(categoryName).join(" · ");
  const button = (label: string, onClick: () => void) => <button className="hob-btn plugin-install" onClick={(event) => { event.stopPropagation(); onClick(); }}>{label}</button>;
  return <div className={`plugin-card${onOpen ? " clickable" : ""}`} role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined} onClick={onOpen} onKeyDown={onOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } } : undefined}>
    <div className="plugin-card-head">
      <PluginIcon name={name} id={item.id} manifest={item.manifest} source={item.source} />
      <div className="plugin-card-title"><div className="name">{name}</div>{meta && <div className="plugin-card-meta">{meta}</div>}</div>
      {item.error ? null : update ? button(t("更新"), onUpdate) : item.installed ? <span className="plugin-state">{t("已安装")}</span> : button(t("安装"), onInstall)}
    </div>
    <div className="plugin-card-desc">{pluginDescription(item.manifest, item.id)}</div>
    {item.error && <div className="badline">{item.error}</div>}
    {categories && <div className="plugin-card-cats">{categories}</div>}
  </div>;
}

function sourceName(source: { id: string; name: string }) { return source.id === "official" ? t("Hob 官方") : source.name; }
function sourceAddress(address: string) {
  try {
    const url = new URL(address);
    const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
    return !url.pathname.endsWith(".json") && parts.length >= 2 ? parts.slice(-2).join("/") : url.hostname || address;
  } catch { return address; }
}
function SourceDialog({ sources, refresh, onClose }: { sources: NonNullable<PluginCatalogView["sources"]>; refresh: () => Promise<void>; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    setBusy(true); setError("");
    try { await addPluginSource(url.trim()); await refresh(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const remove = async (source: NonNullable<PluginCatalogView["sources"]>[number]) => {
    if (!window.confirm(t("移除「{name}」？已经装上的插件不受影响。", { name: sourceName(source) }))) return;
    try { await deletePluginSource(source.id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <DialogShell label={t("插件源")} title={t("插件源")} onClose={onClose} onSubmit={event => { event.preventDefault(); void add(); }} actions={<button className="hob-btn hob-btn-primary" disabled={busy || !url.trim()}>{busy && <Icon name="spin" size={14} className="spin" />}{t("添加")}</button>}>
    <div className="plugin-source-list">{sources.map(source => <div className="plugin-source-row" key={source.id}><span>{sourceName(source)}</span><span className="plugin-source-meta" title={source.error ?? source.url}>{sourceAddress(source.url)}{source.error ? <> · <span className="plugin-source-error">{source.error}</span></> : source.updatedAt ? ` · ${t("{time} 更新", { time: fmtWhen(source.updatedAt) })}` : ""}</span>{source.id !== "official" && <button type="button" className="hob-icon-btn" title={t("移除")} aria-label={t("移除")} onClick={() => void remove(source)}><Icon name="trash" size={16} /></button>}</div>)}</div>
    <input className="field plugin-source-input" placeholder={t("仓库地址或索引 JSON 地址")} value={url} onChange={event => { setUrl(event.target.value); setError(""); }} />
    <div className="plugin-note">{t("fork 官方仓库 FFatTiger/hob-plugins 就能建自己的源。")}</div>
    {error && <div className="badline" role="alert">{error}</div>}
  </DialogShell>;
}

function PluginHeading({ title, description }: { title: string; description: string }) {
  return <><div className="plugin-title">{title}</div><div className="plugin-sub">{description}</div></>;
}

export function Plugins({ narrow, leaving }: { narrow: boolean; leaving: boolean }) {
  const s = useApp();
  const [view, setView] = useState<PluginsView | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogView | null>(null);
  const [error, setError] = useState("");
  const [sourceDialog, setSourceDialog] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [marketDetail, setMarketDetail] = useState<PluginCatalogView["plugins"][number] | null>(null);
  const [checking, setChecking] = useState(false);
  const refresh = async () => { const [nextView, nextCatalog] = await Promise.all([loadPlugins(), loadPluginCatalog()]); setView(nextView); setCatalog(nextCatalog); };
  const run = (action: () => Promise<unknown>) => {
    void (async () => { try { setError(""); await action(); await refresh(); } catch (errorValue) { setError(errorValue instanceof Error ? errorValue.message : String(errorValue)); } })();
  };
  useEffect(() => { void refresh().catch((errorValue) => setError(errorValue instanceof Error ? errorValue.message : String(errorValue))); }, []);
  useEffect(() => {
    if (!catalog?.sources?.some(source => source.refreshing)) return;
    const timer = window.setTimeout(() => { void refresh().catch(e => setError(e instanceof Error ? e.message : String(e))); }, 1500);
    return () => window.clearTimeout(timer);
  }, [catalog]);
  useEffect(() => {
    if (sourceFilter !== "all" && catalog?.sources && !catalog.sources.some(source => source.id === sourceFilter)) setSourceFilter("all");
  }, [catalog, sourceFilter]);
  useEffect(() => {
    if (s.page !== "plugins") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]") || target?.closest("[role=dialog], .amenu")) return;
      closePlugins();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.page]);
  const installed = sortInstalled(view?.plugins ?? []);
  const available = (catalog?.plugins ?? []).filter(item => !item.installed && !item.error);
  const sources = catalog?.sources ?? [];
  const usable = (catalog?.plugins ?? []).filter(item => !item.error);
  const categories = [...new Set(usable.flatMap(item => pluginCategories(item.manifest)))].sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (catalog?.plugins ?? []).filter(item => (sourceFilter === "all" || item.source === sourceFilter)
    && (category === "all" || pluginCategories(item.manifest).includes(category))
    && words.every(word => [item.id, pluginName(item.manifest, item.id), pluginDescription(item.manifest, item.id), String(hobExtension(item.manifest).publisher ?? ""), ...pluginCategories(item.manifest).map(categoryName)].some(value => value.toLowerCase().includes(word))));
  const check = <button className="hob-icon-btn" title={t("检查更新")} aria-label={t("检查更新")} disabled={checking} onClick={() => { setChecking(true); run(() => refreshPluginSources().finally(() => setChecking(false))); }}><Icon name={checking ? "spin" : "retry"} size={18} className={checking ? "spin" : undefined} /></button>;
  const plus = <span className="plugin-head-actions">{check}<button className="hob-icon-btn" title={t("添加插件源")} aria-label={t("添加插件源")} onClick={() => setSourceDialog(true)}><Icon name="plus" size={18} /></button></span>;
  const landing = s.pluginPage === "market" || (s.pluginPage === "installed" && !narrow) ? <>
    {!narrow && <div className="plugin-market-heading"><div><PluginHeading title={t("市场")} description={t("装上插件，助手就能用它的工具。装好后在插件页填配置。")} /></div>{plus}</div>}
    {sources.filter(source => source.error).map(source => <div className="badline" key={source.id}>{source.updatedAt ? t("「{name}」没有更新：{error}（上次更新 {time}）", { name: sourceName(source), error: source.error!, time: fmtWhen(source.updatedAt) }) : t("「{name}」读取失败：{error}", { name: sourceName(source), error: source.error! })}</div>)}
    {error && <div className="badline" role="alert">{error}</div>}{view?.migrationErrors.map((message) => <div className="badline" key={message}>{message}</div>)}
    <label className="knowledge-search plugin-search"><Icon name="search" size={16} /><input value={query} placeholder={t("搜索插件")} onChange={(event) => setQuery(event.target.value)} /></label>
    {categories.length > 1 && <div className="home-filters plugin-category-filter"><button className={`home-filter${category === "all" ? " on" : ""}`} onClick={() => setCategory("all")}>{t("全部")}</button>{categories.map(slug => <button key={slug} className={`home-filter${category === slug ? " on" : ""}`} onClick={() => setCategory(slug)}>{categoryName(slug)}</button>)}</div>}
    {sources.length > 1 && <div className="plugin-filter plugin-source-filter"><button className={sourceFilter === "all" ? "on" : ""} onClick={() => setSourceFilter("all")}>{t("全部来源")}</button>{sources.map(source => <button key={source.id} className={sourceFilter === source.id ? "on" : ""} onClick={() => setSourceFilter(source.id)}>{sourceName(source)}</button>)}</div>}
    <div className="plugin-grid">{shown.map((item, index) => {
      const installedVersion = view?.plugins.find(plugin => plugin.plugin.id === item.id && plugin.plugin.source === item.source)?.plugin.version;
      const update = Boolean(item.installed && !item.error && installedVersion && newerPluginVersion(item.version, installedVersion));
      const sourceLabel = item.source === "builtin" ? t("Hob 自带") : sources.length > 1 ? sourceName({ id: item.source ?? "", name: item.sourceName ?? "" }) : undefined;
      return <PluginCard key={`${item.source}:${item.id}:${index}`} item={item} sourceLabel={sourceLabel} update={update} onOpen={item.error ? undefined : item.installed ? () => openPlugins(item.id) : () => setMarketDetail(item)} onInstall={() => run(() => installPlugin(item.id, item.source))} onUpdate={() => run(() => updatePlugin(item.id))} />;
    })}</div>
    {catalog && !shown.length && <div className="plugin-note plugin-empty">{query.trim() ? t("没有找到「{query}」相关的插件。", { query: query.trim() }) : t("这个分类还没有插件。")}</div>}
  </> : s.pluginPage === "new" ? <>
    <PluginHeading title={t("添加自定义 MCP")} description={t("连接自定义工具服务。")} />
    {error && <div className="badline" role="alert">{error}</div>}
    <CustomPluginForm run={run} />
  </> : <>
    {!narrow && <PluginHeading title={t("插件")} description={t("连接常用工具，让助手在工作中使用。")} />}
    {error && <div className="badline" role="alert">{error}</div>}{view?.migrationErrors.map((message) => <div className="badline" key={message}>{message}</div>)}
    <div className="plugin-list plugin-installed-list">{installed.map((item) => <PluginRow key={item.plugin.id} id={item.plugin.id} manifest={item.manifest} status={pluginServiceStatus(item)} credentialProvider={item.credentialRoles?.includes("list")} disabled={!item.plugin.enabled} installed onOpen={() => openPlugins(item.plugin.id)} />)}</div>
    <div className="plugin-note">{t("需要处理的排在前面。停用的插件显示「已停用」。")}</div>
    {available.length ? <section className="plugin-market-more">
      <div className="plugin-section-head"><span>{t("市场里还有")}</span><button className="plugin-link" onClick={() => openPlugins(null, "market")}>{t("去市场")} <Icon name="chev" size={14} /></button></div>
      <div className="plugin-list">{available.map((item, index) => <PluginRow key={`${item.source}:${item.id}:${index}`} id={item.id} manifest={item.manifest} source={item.source} action={{ label: t("安装"), onClick: () => run(() => installPlugin(item.id, item.source)) }} />)}</div>
    </section> : null}
  </>;
  return <main className={`setpage plugins${narrow ? " narrow" : ""}${leaving ? " leaving" : ""}`}>
    {narrow ? <div className="sethead"><button className="hob-icon-btn" title={s.pluginId || marketDetail ? t("返回插件") : t("返回 Hob")} aria-label={s.pluginId || marketDetail ? t("返回插件") : t("返回 Hob")} onClick={() => marketDetail ? setMarketDetail(null) : s.pluginId ? openPlugins() : closePlugins()}><Icon name="left" size={17} /></button><span className="t">{t("插件")}</span>{!s.pluginId && !marketDetail && (s.pluginPage === "market" ? plus : s.pluginPage === "installed" ? <button className="hob-icon-btn" title={t("添加自定义 MCP")} aria-label={t("添加自定义 MCP")} onClick={() => openPlugins(null, "new")}><Icon name="plus" size={18} /></button> : null)}</div> : null}
    {(!narrow || (!s.pluginId && !marketDetail)) ? <PluginNav narrow={narrow} page={s.pluginPage} pluginId={s.pluginId} view={view} /> : null}
    <section className="setmain plugin-main">{s.pluginId ? <PluginDetail id={s.pluginId} /> : marketDetail ? <div className="plugin-content"><button className="plugin-link" onClick={() => setMarketDetail(null)}>{t("返回插件")}</button><div className="plugin-identity"><PluginIcon id={marketDetail.id} name={pluginName(marketDetail.manifest, marketDetail.id)} manifest={marketDetail.manifest} source={marketDetail.source} /><div><div className="plugin-title">{pluginName(marketDetail.manifest, marketDetail.id)}</div><div className="plugin-sub">{sourceName({ id: marketDetail.source ?? "", name: marketDetail.sourceName ?? "" })} · {t("版本 {version}", { version: marketDetail.version })}</div></div></div><div className="plugin-sub">{pluginDescription(marketDetail.manifest, marketDetail.id)}</div>{error && <div className="badline" role="alert">{error}</div>}<div className="plugin-actions"><button className="hob-btn hob-btn-primary" onClick={() => run(async () => { await installPlugin(marketDetail.id, marketDetail.source); setMarketDetail(null); openPlugins(marketDetail.id); })}>{t("安装")}</button></div></div> : <div className="plugin-content">{landing}</div>}</section>
    {sourceDialog && <SourceDialog sources={sources} refresh={refresh} onClose={() => setSourceDialog(false)} />}
  </main>;
}
