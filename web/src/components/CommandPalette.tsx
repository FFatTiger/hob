// 全局命令面板（⌘K / Ctrl K，侧栏搜索框与手机首页搜索入口共用）：
// 本地实时过滤助手、群、话题、任务、定时任务与常用命令，并防抖检索历史消息全文。
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../shared/i18n.ts";
import type { HistoryMatch, Theme } from "../../../shared/types.ts";
import { conversations, pinList } from "../home.ts";
import { Icon } from "../icons.tsx";
import { useLeave } from "../motion.ts";
import { Avatar } from "../sprites.tsx";
import {
  closePanelPages,
  goHome,
  jumpToHistory,
  jumpToJob,
  newAssistant,
  openAssistant,
  openAssistantTopic,
  openGroup,
  openKnowledge,
  openPlugins,
  openRoutine,
  openSettings,
  openStars,
  searchHistory,
  select,
  selectGroup,
  setTheme,
  togglePanel,
  toggleSideCollapsed,
  useApp,
  type State,
} from "../store.ts";
import { cronText, fmtWhen } from "../util.ts";
import { GroupCluster } from "./Groups.tsx";
import { JOB_STATUS } from "./status-meta.tsx";

export const CMDK_EVENT = "hob:open-cmdk";

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function cmdkShortcut(): string {
  return isMacPlatform() ? "⌘K" : "Ctrl K";
}

export function triggerCommandPalette() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CMDK_EVENT));
}

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  meta?: string;
  keywords: string;
  icon: ReactNode;
  snippet?: ReactNode;
  run: () => void;
}

export function HighlightSnippet({ text, query }: { text: string; query: string }) {
  const words = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        words.some((word) => word.toLocaleLowerCase() === part.toLocaleLowerCase())
          ? <mark key={index} className="cmdk-hit">{part}</mark>
          : part,
      )}
    </>
  );
}

function matchesWords(words: string[], label: string, keywords: string): boolean {
  if (!words.length) return true;
  const hay = `${label} ${keywords}`.toLocaleLowerCase();
  return words.every((word) => hay.includes(word));
}

export function buildLocalPaletteItems(
  s: Pick<State, "assistants" | "assistantTopics" | "groups" | "jobs" | "routines" | "theme" | "page">
    & Partial<Pick<State, "sel" | "gsel" | "groupPrefs" | "approvals" | "sideCollapsed" | "collapsed">>,
  rawQuery: string,
): PaletteItem[] {
  const q = rawQuery.trim().toLocaleLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const assistants = s.assistants ?? [];
  const groups = s.groups ?? [];
  const assistantTopics = s.assistantTopics ?? [];
  const jobs = Object.values(s.jobs ?? {});
  const routines = s.routines ?? [];
  const mac = isMacPlatform();
  const pins = pinList(conversations(assistants, groups, s.groupPrefs ?? {}, s.approvals ?? {}, assistantTopics), "");
  const pinShortcut = new Map<string, string>();
  pins.slice(0, 9).forEach((entry, index) => {
    pinShortcut.set(`${entry.kind}:${entry.id}`, `Alt ${index + 1}`);
  });
  const ensureMain = () => {
    if (s.page !== "main") goHome();
  };
  const ownerOf = (assistantId: string) => assistants.find((a) => a.id === assistantId);
  const out: PaletteItem[] = [];

  const assistantGroup = t("助手");
  for (const a of assistants) {
    if (!searching && a.hidden) continue;
    if (!matchesWords(words, a.name, `${a.duty} ${a.id}`)) continue;
    out.push({
      id: `a:${a.id}`,
      group: assistantGroup,
      label: a.name,
      detail: a.duty,
      meta: pinShortcut.get(`assistant:${a.id}`),
      keywords: `${a.duty} ${a.id}`,
      icon: <Avatar sprite={a.sprite} prop={a.prop} size={28} />,
      run: () => {
        ensureMain();
        void openAssistant(a.id);
      },
    });
  }

  const groupLabel = t("群");
  for (const g of groups) {
    if (g.parentId) continue;
    if (!matchesWords(words, g.name, `${g.purpose} ${g.id}`)) continue;
    out.push({
      id: `g:${g.id}`,
      group: groupLabel,
      label: g.name,
      detail: g.purpose || t("{n} 位成员", { n: g.members.length }),
      meta: pinShortcut.get(`group:${g.id}`),
      keywords: `${g.purpose} ${g.id}`,
      icon: <GroupCluster g={g} assistants={assistants} size={28} />,
      run: () => {
        ensureMain();
        void openGroup(g.id);
      },
    });
  }

  const topicGroup = t("话题");
  for (const g of groups) {
    if (!g.parentId) continue;
    if (!searching && g.closedAt) continue;
    const parent = groups.find((item) => item.id === g.parentId);
    const keywords = `${parent?.name ?? ""} ${g.purpose} ${g.id}`;
    if (!matchesWords(words, g.name, keywords)) continue;
    out.push({
      id: `gt:${g.id}`,
      group: topicGroup,
      label: g.name,
      detail: [parent?.name, g.closedAt ? t("已关闭") : ""].filter(Boolean).join(" · "),
      keywords,
      icon: <span className="cmdk-ico"><Icon name="hash" size={15} /></span>,
      run: () => {
        ensureMain();
        void selectGroup(g.id, true, false, true);
      },
    });
  }
  for (const topic of assistantTopics) {
    if (!searching && topic.closedAt) continue;
    const owner = ownerOf(topic.assistantId);
    const keywords = `${owner?.name ?? ""} ${topic.id}`;
    if (!matchesWords(words, topic.name, keywords)) continue;
    out.push({
      id: `at:${topic.id}`,
      group: topicGroup,
      label: topic.name,
      detail: [owner?.name, topic.closedAt ? t("已关闭") : ""].filter(Boolean).join(" · "),
      keywords,
      icon: <span className="cmdk-ico"><Icon name="hash" size={15} /></span>,
      run: () => {
        ensureMain();
        void openAssistantTopic(topic.assistantId, topic.id, true);
      },
    });
  }

  const jobGroup = t("任务");
  const candidateJobs = searching
    ? [...jobs].sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))
    : jobs.filter((job) => job.status === "running" || job.status === "waiting" || job.status === "queued");
  let jobCount = 0;
  for (const job of candidateJobs) {
    const owner = ownerOf(job.assistantId);
    const statusText = JOB_STATUS[job.status].text;
    const keywords = `${owner?.name ?? ""} ${job.summary ?? ""} ${statusText} ${job.id}`;
    if (!matchesWords(words, job.title, keywords)) continue;
    out.push({
      id: `j:${job.id}`,
      group: jobGroup,
      label: job.title,
      detail: [owner?.name, statusText, job.summary].filter(Boolean).join(" · "),
      keywords,
      icon: <span className="cmdk-ico"><Icon name="tasks" size={15} /></span>,
      run: () => {
        ensureMain();
        void jumpToJob(job.assistantId, job.id);
      },
    });
    jobCount++;
    if (jobCount >= (searching ? 12 : 6)) break;
  }

  const routineGroup = t("定时任务");
  const candidateRoutines = searching ? routines : routines.filter((r) => r.active);
  let routineCount = 0;
  for (const r of candidateRoutines) {
    const owner = ownerOf(r.assistantId);
    const schedule = cronText(r.schedules[0] ?? "");
    const keywords = `${owner?.name ?? ""} ${schedule} ${r.id}`;
    if (!matchesWords(words, r.name, keywords)) continue;
    out.push({
      id: `r:${r.id}`,
      group: routineGroup,
      label: r.name,
      detail: [owner?.name, schedule].filter(Boolean).join(" · "),
      keywords,
      icon: <span className="cmdk-ico"><Icon name="clock" size={15} /></span>,
      run: () => {
        ensureMain();
        closePanelPages();
        if (r.groupId && groups.some((group) => group.id === r.groupId)) void selectGroup(r.groupId, true, false, true);
        else if (r.topicId && assistantTopics.some((topic) => topic.id === r.topicId && topic.assistantId === r.assistantId)) void openAssistantTopic(r.assistantId, r.topicId, true);
        else void select(r.assistantId, true, false, true);
        openRoutine(r.id);
      },
    });
    routineCount++;
    if (routineCount >= (searching ? 12 : 6)) break;
  }

  const inChat = s.page === "main" && Boolean(s.sel || s.gsel);
  const commandGroup = t("命令");
  const commands: Omit<PaletteItem, "group">[] = [
    {
      id: "cmd:home",
      label: t("返回首页"),
      meta: mac ? "⇧⌘H" : "Ctrl Shift H",
      keywords: "home index back",
      icon: <span className="cmdk-ico"><Icon name="home" size={15} /></span>,
      run: () => goHome(),
    },
    ...(inChat ? [
      {
        id: "cmd:toggle-side",
        label: s.sideCollapsed ? t("展开左栏") : t("收起左栏"),
        meta: mac ? "⌘\\" : "Ctrl \\",
        keywords: "sidebar left toggle collapse expand",
        icon: <span className="cmdk-ico"><Icon name="panel" size={15} style={{ transform: "scaleX(-1)" }} /></span>,
        run: () => toggleSideCollapsed(),
      },
      {
        id: "cmd:toggle-panel",
        label: s.collapsed ? t("展开右栏") : t("收起右栏"),
        meta: mac ? "⌘." : "Ctrl .",
        keywords: "panel right toggle collapse expand",
        icon: <span className="cmdk-ico"><Icon name="panel" size={15} /></span>,
        run: () => togglePanel(),
      },
    ] : []),
    ...(pins.length > 0 ? [
      {
        id: "cmd:pins",
        label: t("切换置顶对话"),
        detail: t("跳转到第 1–9 个置顶对话"),
        meta: "Alt 1–9",
        keywords: "pin pinned switch jump alt",
        icon: <span className="cmdk-ico"><Icon name="pin" size={15} /></span>,
        run: () => {
          ensureMain();
          const first = pins[0];
          if (!first) return;
          if (first.kind === "assistant") void openAssistant(first.id);
          else void openGroup(first.id);
        },
      },
    ] : []),
    {
      id: "cmd:new-assistant",
      label: t("新建助手"),
      keywords: "new assistant create",
      icon: <span className="cmdk-ico"><Icon name="plus" size={15} /></span>,
      run: () => {
        ensureMain();
        newAssistant();
      },
    },
    {
      id: "cmd:stars",
      label: t("收藏"),
      keywords: "stars favorite",
      icon: <span className="cmdk-ico"><Icon name="star" size={15} /></span>,
      run: () => openStars(),
    },
    {
      id: "cmd:knowledge",
      label: t("知识库"),
      keywords: "knowledge archive",
      icon: <span className="cmdk-ico"><Icon name="archive" size={15} /></span>,
      run: () => openKnowledge(),
    },
    {
      id: "cmd:plugins",
      label: t("插件"),
      keywords: "plugins",
      icon: <span className="cmdk-ico"><Icon name="plugin" size={15} /></span>,
      run: () => openPlugins(),
    },
    {
      id: "cmd:settings",
      label: t("设置"),
      keywords: "settings preferences",
      icon: <span className="cmdk-ico"><Icon name="gear" size={15} /></span>,
      run: () => openSettings(),
    },
    ...([
      ["system", t("跟随系统")],
      ["light", t("浅色")],
      ["dark", t("深色")],
    ] as [Theme, string][]).map(([key, mode]) => ({
      id: `cmd:theme:${key}`,
      label: t("主题 · {mode}", { mode }),
      meta: s.theme === key ? t("当前") : undefined,
      keywords: `theme ${key} ${mode}`,
      icon: <span className="cmdk-ico"><Icon name="bulb" size={15} /></span>,
      run: () => setTheme(key),
    })),
  ];
  for (const cmd of commands) {
    if (!matchesWords(words, cmd.label, cmd.keywords)) continue;
    out.push({ ...cmd, group: commandGroup });
  }

  return out;
}

function messageResultIcon(
  row: HistoryMatch,
  assistants: State["assistants"],
  groups: State["groups"],
  assistantTopics: State["assistantTopics"],
): ReactNode {
  if (row.conversation.kind === "group") {
    const group = groups.find((g) => g.id === row.conversation.id);
    const speaker = row.speaker !== "user" ? assistants.find((a) => a.id === row.speaker) : undefined;
    if (speaker) return <Avatar sprite={speaker.sprite} prop={speaker.prop} size={28} />;
    if (group) return <GroupCluster g={group} assistants={assistants} size={28} />;
    return <span className="cmdk-ico"><Icon name="hash" size={15} /></span>;
  }
  const topic = row.conversation.kind === "topic"
    ? assistantTopics.find((item) => item.id === row.conversation.id)
    : undefined;
  const assistant = assistants.find((a) => a.id === (topic?.assistantId ?? row.conversation.id));
  if (assistant) return <Avatar sprite={assistant.sprite} prop={assistant.prop} size={28} />;
  return <span className="cmdk-ico"><Icon name="user" size={15} /></span>;
}

interface MessageSearchState {
  query: string;
  loading: boolean;
  rows: HistoryMatch[];
  error?: string;
}

export function CommandPalette() {
  const s = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [msgState, setMsgState] = useState<MessageSearchState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const leave = useLeave(open, 165);

  const openPalette = () => {
    setQuery("");
    setActive(0);
    setMsgState(null);
    setOpen(true);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        setOpen((prev) => {
          const next = !prev;
          if (next) {
            setQuery("");
            setActive(0);
            setMsgState(null);
          }
          return next;
        });
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onCustom = () => openPalette();
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

  const trimmed = query.trim();
  const searchMessages = open && [...trimmed].length >= 2;

  useEffect(() => {
    if (!searchMessages) {
      setMsgState(null);
      return;
    }
    let live = true;
    setMsgState({ query: trimmed, loading: true, rows: [] });
    const timer = window.setTimeout(() => {
      void searchHistory(trimmed)
        .then((data) => {
          if (live) setMsgState({ query: trimmed, loading: false, rows: data.results });
        })
        .catch((error: unknown) => {
          if (live) setMsgState({ query: trimmed, loading: false, rows: [], error: error instanceof Error ? error.message : String(error) });
        });
    }, 260);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [searchMessages, trimmed]);

  const localItems = useMemo(
    () => (leave.mounted ? buildLocalPaletteItems(s, query) : []),
    [leave.mounted, s.assistants, s.assistantTopics, s.groups, s.groupPrefs, s.approvals, s.jobs, s.routines, s.theme, s.page, s.sel, s.gsel, s.sideCollapsed, s.collapsed, query],
  );

  const messageItems = useMemo<PaletteItem[]>(() => {
    if (!leave.mounted || !searchMessages || !msgState || msgState.query !== trimmed || msgState.loading || msgState.error) {
      return [];
    }
    const msgGroup = t("消息");
    const sorted = [...msgState.rows].sort((a, b) => Number(b.starred) - Number(a.starred) || b.at.localeCompare(a.at));
    return sorted.map((row) => ({
      id: `m:${row.conversation.kind}:${row.conversation.id}:${row.itemId}`,
      group: msgGroup,
      label: row.conversationName,
      meta: fmtWhen(row.at),
      keywords: "",
      icon: messageResultIcon(row, s.assistants ?? [], s.groups ?? [], s.assistantTopics ?? []),
      snippet: (
        <span className="cmdk-snippet">
          {row.starred ? "★ " : ""}
          <HighlightSnippet text={row.snippet} query={trimmed} />
        </span>
      ),
      run: () => void jumpToHistory(row.conversation, row.itemId),
    }));
  }, [leave.mounted, searchMessages, msgState, trimmed, s.assistants, s.groups, s.assistantTopics]);

  const items = useMemo(() => {
    if (!messageItems.length) return localItems;
    const cmdGroup = t("命令");
    const firstCmd = localItems.findIndex((item) => item.group === cmdGroup);
    if (firstCmd === -1) return [...localItems, ...messageItems];
    return [...localItems.slice(0, firstCmd), ...messageItems, ...localItems.slice(firstCmd)];
  }, [localItems, messageItems]);

  const clamped = items.length ? Math.min(active, items.length - 1) : 0;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelectorAll<HTMLElement>("[role='option']")[clamped]?.scrollIntoView?.({ block: "nearest" });
  }, [clamped, open]);

  if (!leave.mounted) return null;

  const execute = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  const currentMsg = searchMessages && msgState?.query === trimmed ? msgState : null;
  const msgHeading = t("消息");
  const showMsgStatus = Boolean(currentMsg && (currentMsg.loading || currentMsg.error || (currentMsg.rows.length === 0 && localItems.length > 0)));
  const hasAnyRows = items.length > 0 || showMsgStatus;

  let lastGroup = "";
  const renderRow = (item: PaletteItem, idx: number) => {
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
          <span className="cmdk-main">
            <span className="cmdk-title">
              <span className="cmdk-label">{item.label}</span>
              {item.meta ? <span className="cmdk-meta">{item.meta}</span> : null}
            </span>
            {item.snippet ?? (item.detail ? <span className="cmdk-detail">{item.detail}</span> : null)}
          </span>
        </button>
      </Fragment>
    );
  };

  const cmdIdx = items.findIndex((item) => item.group === t("命令"));
  const beforeCmd = cmdIdx === -1 ? items : items.slice(0, cmdIdx);
  const cmdItems = cmdIdx === -1 ? [] : items.slice(cmdIdx);

  return createPortal(
    <div
      className={`cmdk-mask${leave.leaving ? " leaving" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("快速跳转")}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="cmdk-card">
        <div className="cmdk-head">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            placeholder={t("搜索助手、群、话题、任务、定时任务或消息…")}
            aria-controls="cmdk-listbox"
            aria-activedescendant={items[clamped] ? `cmdk-opt-${clamped}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                execute(items[clamped]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="hob-icon-btn cmdk-clear"
              title={t("清除搜索")}
              aria-label={t("清除搜索")}
              onClick={() => {
                setQuery("");
                setActive(0);
                inputRef.current?.focus();
              }}
            >
              <Icon name="close" size={14} />
            </button>
          ) : null}
          <kbd className="cmdk-esc">ESC</kbd>
          <button type="button" className="cmdk-cancel" onClick={() => setOpen(false)}>
            {t("取消")}
          </button>
        </div>
        <div id="cmdk-listbox" className="cmdk-list" ref={listRef} role="listbox">
          {hasAnyRows ? (
            <>
              {beforeCmd.map((item, idx) => renderRow(item, idx))}
              {showMsgStatus && currentMsg ? (
                <>
                  {lastGroup !== msgHeading ? <div className="cmdk-group" role="presentation">{msgHeading}</div> : null}
                  {(() => { lastGroup = msgHeading; return null; })()}
                  <div className={`cmdk-status${currentMsg.error ? " bad" : ""}`} role="status">
                    {currentMsg.loading
                      ? t("正在搜索消息…")
                      : currentMsg.error
                        ? t("搜索失败：{error}", { error: currentMsg.error })
                        : t("没有找到包含「{query}」的消息", { query: trimmed })}
                  </div>
                </>
              ) : null}
              {cmdItems.map((item, idx) => renderRow(item, beforeCmd.length + idx))}
            </>
          ) : (
            <div className="cmdk-empty">{t("没有匹配的结果")}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
