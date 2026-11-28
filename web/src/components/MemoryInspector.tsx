import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { t } from "../../../shared/i18n.ts";
import type { LocalMemoryEntry, LocalMemoryView, MemoryProvider } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { loadLocalMemory } from "../store.ts";
import { Disclosure } from "./Disclosure.tsx";
import { Empty } from "./Empty.tsx";
import { Group } from "./SettingsParts.tsx";

type MemoryTab = "long_term" | "scratchpad" | "daily";

function sourceLabel(source?: string): string | null {
  if (!source) return null;
  return source === "user" ? t("用户") : t("助手");
}

export function MemoryInspector({ provider, loreUrl }: { provider: MemoryProvider; loreUrl: string | null }) {
  const [view, setView] = useState<LocalMemoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<MemoryTab>("long_term");
  const [query, setQuery] = useState("");
  const [loreDisclosureOpen, setLoreDisclosureOpen] = useState(false);

  const refresh = async (date?: string) => {
    setLoading(true);
    setError(null);
    const result = await loadLocalMemory(date);
    setLoading(false);
    if (result.ok) setView(result.view);
    else setError(result.error);
  };

  useEffect(() => {
    void refresh();
  }, [provider]);

  const hasLocalEntries = Boolean(
    view && (view.longTerm.length > 0 || view.scratchpad.length > 0 || view.dailyDates.length > 0),
  );

  const needle = query.trim().toLowerCase();
  const filteredLongTerm = useMemo(() => {
    const list = view?.longTerm ?? [];
    if (!needle) return list;
    return list.filter((entry) => entry.text.toLowerCase().includes(needle));
  }, [view, needle]);

  const filteredScratchpad = useMemo(() => {
    const list = view?.scratchpad ?? [];
    if (!needle) return list;
    return list.filter((entry) => entry.text.toLowerCase().includes(needle));
  }, [view, needle]);

  const filteredDaily = useMemo(() => {
    const list = view?.daily ?? [];
    if (!needle) return list;
    return list.filter((entry) => entry.text.toLowerCase().includes(needle));
  }, [view, needle]);

  const tabs: { key: MemoryTab; label: string; count: number }[] = [
    { key: "long_term", label: t("长期记忆"), count: needle ? filteredLongTerm.length : (view?.longTerm.length ?? 0) },
    { key: "scratchpad", label: t("备忘清单"), count: needle ? filteredScratchpad.length : (view?.scratchpad.length ?? 0) },
    { key: "daily", label: t("每日记录"), count: needle && tab === "daily" ? filteredDaily.length : (view?.dailyDates.length ?? 0) },
  ];

  const renderMemoryCard = (entry: LocalMemoryEntry) => {
    const who = sourceLabel(entry.source);
    const meta = [who, entry.updatedAt].filter(Boolean).join(" · ");
    return (
      <div className="group-card mem-card" key={entry.id}>
        <div className="mem-text">{entry.text}</div>
        {meta ? (
          <div className="mem-foot">
            <span className="mem-meta">{meta}</span>
          </div>
        ) : null}
      </div>
    );
  };

  const inspectorBody = (
    <div className="mem-inspector">
      <div className="mem-head">
        <div className="mem-head-text">
          <div className="lbl">{t("我的记忆")}</div>
          <div className="note">{t("只读查看助手保存在本机的长期记忆、备忘清单和每日记录。")}</div>
        </div>
        <button
          type="button"
          className="hob-icon-btn"
          title={t("刷新记忆")}
          aria-label={t("刷新记忆")}
          disabled={loading}
          onClick={() => void refresh(tab === "daily" ? view?.dailyDate : undefined)}
        >
          <Icon name="retry" size={15} className={loading ? "spin" : undefined} />
        </button>
      </div>

      <div className="mem-toolbar">
        <div
          className="seg"
          role="tablist"
          aria-label={t("我的记忆")}
          style={{ "--seg-count": tabs.length, "--seg-index": Math.max(0, tabs.findIndex((item) => item.key === tab)) } as CSSProperties}
        >
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={tab === item.key ? "on" : undefined}
              onClick={() => setTab(item.key)}
            >
              {item.label}
              {item.count > 0 ? <span className="seg-count">{item.count}</span> : null}
            </button>
          ))}
        </div>

        <div className="mem-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            placeholder={t("搜索记忆内容…")}
            aria-label={t("搜索记忆内容…")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="mem-search-clear"
              title={t("清空搜索")}
              aria-label={t("清空搜索")}
              onClick={() => setQuery("")}
            >
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="badline" role="alert">{error}</div> : null}

      {loading && !view ? (
        <Empty>{t("正在读取本地记忆…")}</Empty>
      ) : tab === "long_term" ? (
        <div className="mem-pane">
          {filteredLongTerm.length > 0 ? (
            <div className="mem-list">
              {filteredLongTerm.map(renderMemoryCard)}
            </div>
          ) : (
            <Empty>{needle ? t("没有找到匹配的长期记忆") : t("还没有长期记忆，可以在对话中让助手记住。")}</Empty>
          )}
        </div>
      ) : tab === "scratchpad" ? (
        <div className="mem-pane">
          {filteredScratchpad.length > 0 ? (
            <div className="group-card mem-checklist">
              {filteredScratchpad.map((item) => (
                <div className={`mem-check-row${item.done ? " done" : ""}`} key={item.id}>
                  <span
                    className={`mem-check-box${item.done ? " on" : ""}`}
                    aria-hidden="true"
                  >
                    {item.done ? <Icon name="check" size={12} w={2.4} /> : null}
                  </span>
                  <div className="mem-check-main">
                    <span className="mem-check-text">{item.text}</span>
                    {item.updatedAt ? <span className="mem-meta">{item.updatedAt}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{needle ? t("没有找到匹配的备忘项") : t("备忘清单是空的。")}</Empty>
          )}
        </div>
      ) : (
        <div className="mem-pane">
          {view && view.dailyDates.length > 0 ? (
            <>
              <div className="mem-dates" role="tablist" aria-label={t("选择日期")}>
                {view.dailyDates.map((date) => (
                  <button
                    key={date}
                    type="button"
                    role="tab"
                    aria-selected={view.dailyDate === date}
                    className={`mem-date-pill${view.dailyDate === date ? " on" : ""}`}
                    disabled={loading}
                    onClick={() => void refresh(date)}
                  >
                    {date}
                  </button>
                ))}
              </div>
              {needle && view.dailyDates.length > 1 ? (
                <div className="note">{t("搜索仅筛选当前所选日期（{date}）的记录。", { date: view.dailyDate ?? "" })}</div>
              ) : null}
              {filteredDaily.length > 0 ? (
                <div className="mem-list">
                  {filteredDaily.map(renderMemoryCard)}
                </div>
              ) : (
                <Empty>{needle ? t("这一天没有匹配的记录") : t("这一天没有记录")}</Empty>
              )}
            </>
          ) : (
            <Empty>{t("还没有每日记录。助手按天记下的流水会出现在这里。")}</Empty>
          )}
        </div>
      )}
    </div>
  );

  const safeLoreUrl = loreUrl && /^https?:\/\//i.test(loreUrl.trim()) ? loreUrl.trim() : null;

  if (provider === "lore") {
    return (
      <Group>
        <div className="group-card mem-lore-card">
          <div className="mem-lore-body">
            <strong>{t("记忆由 Lore 托管")}</strong>
            <div className="note">{t("当前长期记忆保存在 Lore 服务中，你可以在 Lore 控制台浏览和整理全部节点。")}</div>
          </div>
          {safeLoreUrl ? (
            <a className="hob-btn" href={safeLoreUrl} target="_blank" rel="noreferrer">
              {t("在 Lore 中查看")}
              <Icon name="out" size={13} />
            </a>
          ) : null}
        </div>
        {hasLocalEntries ? (
          <Disclosure
            className="mem-local-disclosure"
            label={t("查看本机已有的本地记忆")}
            count={(view?.longTerm.length ?? 0) + (view?.scratchpad.length ?? 0)}
            open={loreDisclosureOpen}
            onToggle={() => setLoreDisclosureOpen((value) => !value)}
          >
            {inspectorBody}
          </Disclosure>
        ) : null}
      </Group>
    );
  }

  if (provider === "off") {
    if (!hasLocalEntries) return null;
    return (
      <Group>
        <div className="note">{t("记忆功能当前已关闭，以下为此前保存在本机的记录。")}</div>
        {inspectorBody}
      </Group>
    );
  }

  return <Group>{inspectorBody}</Group>;
}
