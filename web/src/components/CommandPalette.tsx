// 全局 ⌘K / Ctrl K 命令面板：搜索切换助手、群、话题、任务、页面、主题与配色。
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../shared/i18n.ts";
import { filterPaletteItems, resolveGlobalPaletteKey, resolveInputPaletteKey } from "../command-palette.ts";
import { Icon } from "../icons.tsx";
import { useLeave } from "../motion.ts";
import { PALETTE_SWATCHES, type Palette } from "../palette.ts";
import { Avatar } from "../sprites.tsx";
import {
  collapsePanel,
  expandPanel,
  goHome,
  openAssistant,
  openAssistantTopic,
  openJob,
  openKnowledge,
  openPlugins,
  openSettings,
  openStars,
  select,
  selectGroup,
  setPalette,
  setTheme,
  toggleSideCollapsed,
  useApp,
  type Theme,
} from "../store.ts";
import { GroupCluster } from "./Groups.tsx";

export const CMDK_EVENT = "hob:open-cmdk";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export const CMDK_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";

export function triggerCommandPalette() {
  window.dispatchEvent(new CustomEvent(CMDK_EVENT));
}

interface CommandItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  shortcut?: string;
  keywords: string;
  icon: ReactNode;
  run: () => void;
}

function paletteName(id: Palette): string {
  switch (id) {
    case "default": return t("默认");
    case "ocean": return t("海盐");
    case "forest": return t("森林");
    case "dusk": return t("暮紫");
    case "rose": return t("玫瑰");
  }
}

export function CommandPalette() {
  const s = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const leave = useLeave(open, 165);

  const openPalette = () => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    setOpen(true);
  };

  const closePalette = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      const target = previousFocusRef.current;
      previousFocusRef.current = null;
      if (target && target.isConnected) {
        requestAnimationFrame(() => target.focus());
      }
    } else {
      previousFocusRef.current = null;
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const hasOtherModal = Boolean(
        document.querySelector('[aria-modal="true"]:not([data-cmdk="true"])'),
      );
      const action = resolveGlobalPaletteKey(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.isComposing },
        { open, hasOtherModal },
      );
      if (action === "toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (open) closePalette(true);
        else openPalette();
      } else if (action === "close") {
        event.preventDefault();
        event.stopPropagation();
        closePalette(true);
      }
    };
    const onCustom = () => {
      if (document.querySelector('[aria-modal="true"]:not([data-cmdk="true"])')) return;
      openPalette();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(CMDK_EVENT, onCustom);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(CMDK_EVENT, onCustom);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focusInput = () => inputRef.current?.focus();
    const raf = requestAnimationFrame(focusInput);
    const timer = window.setTimeout(focusInput, 0);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    if (!leave.mounted) return [];
    const list: CommandItem[] = [];
    const assistants = s.assistants ?? [];
    const assistantTopics = s.assistantTopics ?? [];
    const groups = s.groups ?? [];
    const jobs = Object.values(s.jobs ?? {});

    const convGroup = t("对话");
    for (const a of assistants) {
      if (a.hidden) continue;
      list.push({
        id: `a:${a.id}`,
        group: convGroup,
        label: a.name,
        detail: a.duty,
        keywords: `${a.name} ${a.duty} ${a.id}`,
        icon: <Avatar sprite={a.sprite} prop={a.prop} size={24} />,
        run: () => void openAssistant(a.id),
      });
    }
    for (const topic of assistantTopics) {
      if (topic.closedAt) continue;
      const parent = assistants.find((item) => item.id === topic.assistantId);
      if (!parent || parent.hidden) continue;
      list.push({
        id: `at:${topic.id}`,
        group: convGroup,
        label: topic.name,
        detail: parent.name,
        keywords: `${topic.name} ${parent.name} ${topic.id}`,
        icon: <span className="cmdk-hash"><Icon name="hash" size={14} /></span>,
        run: () => void openAssistantTopic(topic.assistantId, topic.id),
      });
    }
    for (const g of groups) {
      if (g.closedAt) continue;
      const parent = g.parentId ? groups.find((item) => item.id === g.parentId) : undefined;
      list.push({
        id: `g:${g.id}`,
        group: convGroup,
        label: g.name,
        detail: parent ? parent.name : g.purpose,
        keywords: `${g.name} ${g.purpose} ${parent?.name ?? ""}`,
        icon: parent ? <span className="cmdk-hash"><Icon name="hash" size={14} /></span> : <GroupCluster g={g} assistants={assistants} size={24} />,
        run: () => void selectGroup(g.id),
      });
    }

    const jobGroup = t("任务");
    const activeJobs = jobs
      .filter((job) => job.status === "running" || job.status === "waiting" || job.status === "queued")
      .slice(0, 6);
    for (const job of activeJobs) {
      list.push({
        id: `j:${job.id}`,
        group: jobGroup,
        label: job.title,
        detail: job.summary || undefined,
        keywords: `${job.title} ${job.summary ?? ""}`,
        icon: <span className="cmdk-ico"><Icon name="tasks" size={15} /></span>,
        run: () => {
          const openTarget = async () => {
            if (job.groupId && groups.some((item) => item.id === job.groupId)) {
              await selectGroup(job.groupId, true, false, true);
            } else if (job.topicId && assistantTopics.some((item) => item.id === job.topicId && item.assistantId === job.assistantId)) {
              await openAssistantTopic(job.assistantId, job.topicId);
            } else if (assistants.some((item) => item.id === job.assistantId)) {
              await select(job.assistantId);
            } else {
              goHome();
            }
            openJob(job.id);
          };
          void openTarget();
        },
      });
    }

    const navGroup = t("导航");
    const inChat = s.page === "main" && Boolean(s.sel || s.gsel);
    list.push(
      { id: "nav:home", group: navGroup, label: t("首页"), shortcut: IS_MAC ? "⇧⌘H" : "Ctrl Shift H", keywords: "home", icon: <span className="cmdk-ico"><Icon name="home" size={15} /></span>, run: () => goHome() },
      ...(inChat ? [
        { id: "nav:side", group: navGroup, label: s.sideCollapsed ? t("展开左栏") : t("收起左栏"), shortcut: IS_MAC ? "⌘\\" : "Ctrl \\", keywords: "sidebar left panel collapse expand", icon: <span className="cmdk-ico"><Icon name="panel" size={15} /></span>, run: () => toggleSideCollapsed() },
        { id: "nav:panel", group: navGroup, label: s.collapsed ? t("展开右栏") : t("收起右栏"), shortcut: IS_MAC ? "⌘." : "Ctrl .", keywords: "inspector right panel collapse expand", icon: <span className="cmdk-ico"><Icon name="panel" size={15} /></span>, run: () => (s.collapsed ? expandPanel() : collapsePanel()) },
      ] : []),
      { id: "nav:stars", group: navGroup, label: t("收藏"), keywords: "stars favorite", icon: <span className="cmdk-ico"><Icon name="star" size={15} /></span>, run: () => openStars() },
      { id: "nav:plugins", group: navGroup, label: t("插件"), keywords: "plugins", icon: <span className="cmdk-ico"><Icon name="plugin" size={15} /></span>, run: () => openPlugins() },
      { id: "nav:knowledge", group: navGroup, label: t("知识库"), keywords: "knowledge", icon: <span className="cmdk-ico"><Icon name="archive" size={15} /></span>, run: () => openKnowledge() },
      { id: "nav:settings", group: navGroup, label: t("设置"), keywords: "settings", icon: <span className="cmdk-ico"><Icon name="gear" size={15} /></span>, run: () => openSettings() },
    );

    const themeGroup = t("主题");
    const themes: [Theme, string][] = [["system", t("跟随系统")], ["light", t("浅色")], ["dark", t("深色")]];
    for (const [key, label] of themes) {
      list.push({
        id: `theme:${key}`,
        group: themeGroup,
        label: `${t("主题")} · ${label}`,
        keywords: `theme ${key} ${label}`,
        icon: <span className="cmdk-ico"><Icon name="bulb" size={15} /></span>,
        run: () => setTheme(key),
      });
    }
    const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    for (const swatch of PALETTE_SWATCHES) {
      const name = paletteName(swatch.id);
      list.push({
        id: `palette:${swatch.id}`,
        group: themeGroup,
        label: `${t("配色")} · ${name}`,
        keywords: `palette ${swatch.id} ${name}`,
        icon: <span className="cmdk-swatch" style={{ background: dark ? swatch.dark : swatch.light }} />,
        run: () => setPalette(swatch.id),
      });
    }
    return list;
  }, [leave.mounted, s.assistants, s.assistantTopics, s.groups, s.jobs, s.theme, s.page, s.sel, s.gsel, s.sideCollapsed, s.collapsed]);

  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query]);
  const clamped = filtered.length ? Math.min(active, filtered.length - 1) : 0;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelectorAll<HTMLElement>("[role='option']")[clamped]?.scrollIntoView?.({ block: "nearest" });
  }, [clamped, open]);

  if (!leave.mounted) return null;

  const execute = (item: CommandItem | undefined) => {
    if (!item) return;
    closePalette(false);
    item.run();
  };

  let lastGroup = "";
  return createPortal(
    <div
      className={`cmdk-mask${leave.leaving ? " leaving" : ""}`}
      role="dialog"
      aria-modal="true"
      data-cmdk="true"
      aria-label={t("快速跳转")}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closePalette(true);
      }}
    >
      <div className="cmdk-card">
        <div className="cmdk-head">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            placeholder={t("搜索助手、群、话题、任务或切换主题…")}
            aria-controls="cmdk-listbox"
            aria-activedescendant={filtered[clamped] ? `cmdk-opt-${clamped}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              const action = resolveInputPaletteKey(
                { key: event.key, isComposing: event.nativeEvent.isComposing },
                clamped,
                filtered.length,
              );
              if (!action) return;
              event.preventDefault();
              if (action.kind === "move") {
                setActive(action.index);
              } else if (action.kind === "execute") {
                execute(filtered[clamped]);
              } else if (action.kind === "close") {
                event.stopPropagation();
                closePalette(true);
              }
            }}
          />
          <kbd className="cmdk-esc">ESC</kbd>
        </div>
        <div id="cmdk-listbox" className="cmdk-list" ref={listRef} role="listbox">
          {filtered.length ? filtered.map((item, idx) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <Fragment key={item.id}>
                {showGroup ? <div className="cmdk-group" role="presentation">{item.group}</div> : null}
                <button
                  id={`cmdk-opt-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={idx === clamped}
                  className={`cmdk-row${idx === clamped ? " on" : ""}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => execute(item)}
                >
                  {item.icon}
                  <span className={`cmdk-label${item.detail ? " has-detail" : ""}`}>{item.label}</span>
                  {item.detail ? <small className="cmdk-detail">{item.detail}</small> : null}
                  {item.shortcut ? <kbd className="cmdk-kbd">{item.shortcut}</kbd> : null}
                </button>
              </Fragment>
            );
          }) : <div className="cmdk-empty">{t("没有匹配的结果")}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
