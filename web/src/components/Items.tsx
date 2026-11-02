// 对话条目的渲染：气泡、选择题、任务卡、草稿卡、文件卡、灰字提示。
import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Approval, ApprovalOption, Delegation, Draft, Item, Job } from "../../../shared/types.ts";
import { isImagePath } from "../../../shared/media.ts";
import { visibleLiveCards } from "../page-live.ts";
import { renderMarkdown } from "../markdown.ts";
import { Avatar } from "../sprites.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { fileIcon } from "../file-icons.ts";
import { isFresh, useLeave } from "../motion.ts";
import { copyText } from "../clipboard.ts";
import {
  answer,
  createDraft,
  fileUrl,
  focusComposer,
  jumpToDelegation,
  jumpToHandback,
  openFilePreview,
  openLivePreview,
  openJob,
  replyJob,
  retryDelegation,
  select,
  setNotice,
  setQuote,
  setText,
  stopJob,
  useApp,
} from "../store.ts";
import { fmtDuration, fmtElapsed, fmtWhen, isToday, needDivider } from "../util.ts";
import { jobReason } from "../steps.ts";
import { menuPosition, messageMenu, moveSwipe, swipeReply, type SwipeState } from "../message-menu.ts";

/* ---------------- markdown ---------------- */

/* ---------------- 单项 ---------------- */

const NOTE_ICON: Record<"memory" | "rule" | "routine" | "split" | "info", IconName> = {
  memory: "mem",
  rule: "rule",
  routine: "clock",
  split: "split",
  info: "info",
};

function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .trim();
}

/** 触屏没有悬停：用长按菜单代替悬停工具行。 */
function useNoHover(): boolean {
  const [no, setNo] = useState(() => window.matchMedia("(hover: none)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(hover: none)");
    const sync = () => setNo(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return no;
}

/** 气泡下方的一行工具：回复（引用摘要）/ 复制（原文）。 */
function Tools({
  text,
  itemId,
  menu = false,
  close,
}: {
  text: string;
  itemId: string;
  menu?: boolean;
  close?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    if (!(await copyText(text))) {
      setNotice("复制失败：浏览器不允许写入剪贴板");
      return;
    }
    if (menu) { close?.(); return; }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`tools${menu ? " menu" : ""}`}>
      <button
        title="回复"
        aria-label="回复"
        onClick={() => {
          setQuote({ itemId, text: plain(text).slice(0, 60) });
          focusComposer();
          close?.();
        }}
      >
        <Icon name="reply" size={16} />{menu ? "回复" : null}
      </button>
      <button
        className={copied ? "copied" : ""}
        title={copied ? "已复制" : "复制"}
        aria-label={copied ? "已复制" : "复制"}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} size={16} />{menu ? "复制" : null}
      </button>
    </div>
  );
}

function MessagePopup({ anchor, text, itemId, close }: { anchor: RefObject<HTMLDivElement | null>; text: string; itemId: string; close: () => void }) {
  const [layout, setLayout] = useState<{ bubble: DOMRect; area: DOMRect } | null>(null);
  const clone = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bubble = anchor.current;
    const area = bubble?.closest(".mmsgs, .msgs");
    if (bubble && area) setLayout({ bubble: bubble.getBoundingClientRect(), area: area.getBoundingClientRect() });
  }, [anchor]);
  useLayoutEffect(() => {
    if (!layout || !clone.current || !anchor.current) return;
    clone.current.replaceChildren(anchor.current.cloneNode(true));
  }, [anchor, layout]);
  if (!layout) return null;
  const { bubble, area } = layout;
  const position = menuPosition(bubble, area);
  return createPortal(
    <div className="message-popup" onPointerDown={(event) => event.stopPropagation()}>
      <div className="message-shade" style={{ left: area.left, top: area.top, width: area.width, height: area.height }} onPointerDown={close} />
      <div ref={clone} className="message-popup-bubble" style={{ left: bubble.left, top: bubble.top, width: bubble.width }} />
      <div className="message-popup-menu" style={position}>
        <Tools text={text} itemId={itemId} menu close={close} />
      </div>
    </div>,
    document.body,
  );
}

function jumpToQuote(event: React.MouseEvent<HTMLElement>, itemId: string) {
  const list = event.currentTarget.closest(".col");
  const target = [...(list?.querySelectorAll<HTMLElement>(".message-row[data-item-id]") ?? [])].find((row) => row.dataset.itemId === itemId);
  const bubble = target?.querySelector<HTMLElement>(".hov.msg > .u, .hov.msg > .b");
  if (!bubble) return;
  bubble.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  bubble.classList.remove("quote-flash");
  void bubble.offsetWidth;
  bubble.classList.add("quote-flash");
  window.setTimeout(() => bubble.classList.remove("quote-flash"), 1100);
}

/** 每条消息工具行的状态。 */
type ToolsState = { open: boolean; start?: (event: React.PointerEvent) => void; close: () => void; touch: boolean; distance: number; ready: boolean };

const STATUS: Record<Job["status"], { text: string; icon: IconName; cls: string }> = {
  running: { text: "进行中", icon: "spin", cls: "spin" },
  queued: { text: "排队中", icon: "clock", cls: "" },
  waiting: { text: "待确认", icon: "pause", cls: "" },
  done: { text: "已完成", icon: "check", cls: "" },
  stuck: { text: "受阻", icon: "close", cls: "" },
  failed: { text: "失败", icon: "close", cls: "" },
  stopped: { text: "已停止", icon: "stop", cls: "" },
};

/** 结束了的任务用了多久；没开始跑就结束的（排队时被停）不显示。 */
function took(job: Job): string | undefined {
  const ms = job.durationMs ?? (job.startedAt && job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined);
  return ms === undefined ? undefined : fmtDuration(ms);
}

function JobCard({ job, fresh }: { job: Job; fresh: boolean }) {
  const s = useApp(); // 活动流／状态在 store 里更新，这里跟着重渲染
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [swapped, setSwapped] = useState(false); // 状态刚变过：图标播淡出／弹一下
  const reply = useLeave(replying, 200);
  const st = STATUS[job.status];
  const done = job.status === "done";
  const running = job.status === "running";
  const canReply = running || job.status === "waiting";
  const bad = job.status === "stuck" || job.status === "failed";
  const reason = jobReason(job);
  const owner = s.assistants.find((a) => a.id === job.assistantId);

  // 状态变了才播，历史里的卡片不播
  const before = useRef(job.status);
  useEffect(() => {
    if (before.current === job.status) return;
    before.current = job.status;
    setSwapped(true);
    const timer = window.setTimeout(() => setSwapped(false), 400);
    return () => window.clearTimeout(timer);
  }, [job.status]);

  return (
    <div className={`hov${fresh ? " enter" : ""}`} id={`job-${job.id}`}>
      <div
        className="b jobcard"
        role="button"
        tabIndex={0}
        onClick={() => openJob(job.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") openJob(job.id);
        }}
      >
        <div className="tt">
          {owner ? <span className="jav"><Avatar sprite={owner.sprite} prop={owner.prop} size={28} /></span> : null}
          <span className="jt">{job.title}</span>
          <span className={`st${done ? " done" : ""}`}>
            <span className="stico">
              <Icon name="spin" size={14} w={2} className={`spin stspin${running ? "" : " off"}`} />
              {running ? null : (
                <Icon
                  name={st.icon}
                  size={14}
                  w={2}
                  className={`stic${done ? " pop" : ""}${swapped ? " anim" : ""}`}
                />
              )}
            </span>
            {st.text}
            {running ? ` · ${fmtElapsed(job.startedAt ?? job.createdAt)}` : took(job) ? ` · 用时 ${took(job)}` : null}
          </span>
        </div>
        {reason ? <div className={`meta${bad ? " bad" : ""}`}>{reason}</div> : null}
        {canReply || running ? (
          <div className="acts">
            {canReply ? (
              <button
                className={`btn job-reply${replying ? " selected" : ""}`}
                aria-pressed={replying}
                onClick={(event) => {
                  event.stopPropagation();
                  setReplying((value) => !value);
                }}
              >
                <Icon name="edit" size={14} />
                补充要求
              </button>
            ) : null}
            {running ? (
              <button
                className="btn job-stop"
                onClick={(event) => {
                  event.stopPropagation();
                  void stopJob(job.id);
                }}
              >
                <Icon name="stop" size={14} />
                停止
              </button>
            ) : null}
          </div>
        ) : null}
        {reply.mounted ? (
          <div className={`replywrap${reply.leaving ? " leaving" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="replyclip">
              <div className="replybox">
                <input
                  autoFocus
                  value={text}
                  placeholder="补充说明或更正方向"
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && text.trim()) {
                      void replyJob(job.id, text.trim());
                      setText("");
                      setReplying(false);
                    }
                    if (event.key === "Escape") setReplying(false);
                  }}
                />
                <button
                  className="pbtn solid"
                  onClick={() => {
                    if (text.trim()) void replyJob(job.id, text.trim());
                    setText("");
                    setReplying(false);
                  }}
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  const s = useApp();
  const created = draft.status === "created" && draft.createdAssistantId;
  // 建好以后：头像跟着新助手走（可能是自画的道具），细节收起来，留职责和「查看」
  const made = created ? s.assistants.find((a) => a.id === draft.createdAssistantId) : undefined;
  const prop = made?.prop ?? draft.prop;
  // 建出来的助手并回 Hob 了：点过去也没这人了，就说明一下
  const merged = Boolean(created) && !made;
  return (
    <div className="draft">
        <div className="top">
          <Avatar sprite={made?.sprite ?? draft.sprite} prop={prop} size={46} />
          <div>
            <div className="dn">{draft.name}</div>
            <div className="ds">{draft.status === "created" ? "新助手 · 已创建" : "新助手 · 草稿"}</div>
          </div>
        </div>
        <div className="kv">
          <span className="k">职责</span>
          <span>{draft.dutyLong}</span>
        </div>
        <div className={`expand${created ? "" : " open"}`} inert={Boolean(created)}>
          <div>
            <div className="kv">
              <span className="k">定时任务</span>
              <span className={draft.routinesText ? undefined : "none"}>{draft.routinesText || "没有"}</span>
            </div>
            <div className="kv">
              <span className="k">执行前确认</span>
              <span className={draft.askFirst.length ? undefined : "none"}>{draft.askFirst.join(" · ") || "没有"}</span>
            </div>
            <div className="kv">
              <span className="k">补充说明</span>
              {draft.instructions.length ? (
                // 每条一行：条目自己带句号，再用「；」接起来会变成「。；」
                <span>
                  {draft.instructions.map((line, i) => (
                    <span className="line" key={i}>
                      {line}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="none">没有</span>
              )}
            </div>
            <div className="kv">
              <span className="k">迁移</span>
              <span>{draft.carry.conversations} 段对话</span>
            </div>
          </div>
        </div>
        <div className="acts swap" style={{ marginTop: 12 }}>
          <div className={created ? "off" : undefined}>
            <button className="btn solid" onClick={() => void createDraft(draft.id)}>
              创建
            </button>
            <button
              className="btn"
              style={{ background: "var(--bubble)" }}
              onClick={() => {
                setText("请修改草稿：");
                focusComposer();
              }}
            >
              修改草稿
            </button>
          </div>
          <div className={created ? undefined : "off"}>
            <button className="btn solid" disabled={merged} onClick={() => void select(draft.createdAssistantId!)}>
              {merged ? "已并回 Hob" : "已创建 · 查看"}
            </button>
          </div>
        </div>
    </div>
  );
}

function DelegationCard({ delegation, fresh }: { delegation: Delegation; fresh: boolean }) {
  const s = useApp();
  const [expanded, setExpanded] = useState(false);
  const target = s.assistants.find((a) => a.id === delegation.to);
  const name = target?.name ?? delegation.to;
  const labels: Record<Delegation["status"], string> = { running: "进行中", waiting: "等你确认", done: "已完成", stuck: "受阻", interrupted: "已中断", returned: "已退回" };
  const approvals = Object.values(s.approvals).filter((approval) => approval.status === "pending" && ((delegation.approvalIds ?? []).includes(approval.id) || Boolean(approval.jobId && delegation.jobIds.includes(approval.jobId))));
  return (
    <div className={`hov${fresh ? " enter" : ""}`} id={`delegation-${delegation.id}`}>
      <div className="b jobcard delegation-card">
        <div className="tt">
          {target ? <Avatar sprite={target.sprite} prop={target.prop} size={20} /> : null}
          <span>交给「{name}」</span>
          <span className={`st${delegation.status === "done" ? " done" : ""}${delegation.status === "stuck" || delegation.status === "interrupted" || delegation.status === "returned" ? " bad" : ""}`}>
            <Icon name={delegation.status === "running" ? "spin" : delegation.status === "done" ? "check" : delegation.status === "waiting" ? "pause" : "close"} className={delegation.status === "running" ? "spin" : ""} size={14} />
            {labels[delegation.status]}
          </span>
        </div>
        <button className={`delegation-text${expanded ? " expanded" : ""}`} onClick={() => setExpanded(!expanded)} title={expanded ? "收起" : "查看全文"}>{delegation.text}</button>
        {delegation.status === "returned" && delegation.reply ? <div className="note">{delegation.reply}</div> : null}
        {delegation.jobIds.map((id) => {
          const job = s.jobs[id];
          return job ? <button className="delegation-job" key={id} onClick={() => openJob(id)}><span>{job.title}</span><span>{STATUS[job.status].text}</span></button> : null;
        })}
        {approvals.map((approval) => <QuestionCard key={approval.id} approval={approval} fresh={false} />)}
        <div className="delegation-actions">
          <button onClick={() => void jumpToDelegation(delegation.to, delegation.id, true)}>去「{name}」看看 →</button>
          {delegation.status === "interrupted" ? <button onClick={() => void retryDelegation(delegation.id)}>重新转交</button> : null}
        </div>
      </div>
    </div>
  );
}

function QuestionCard({ approval, fresh }: { approval: Approval; fresh: boolean }) {
  const chosen = approval.options.find((o) => o.key === approval.chosen);
  const done = approval.status === "answered" && chosen ? approval.chosen : undefined;
  // 刚点的那个选项：先亮一下，其余收起来，再出勾
  const [picked, setPicked] = useState<ApprovalOption["key"] | null>(null);
  const [text, setText] = useState("");
  const active = picked ?? done;
  const animated = picked !== null;
  // 用户没选选项、自己写的那句：和选了选项一样，卡片就到这里
  const reply = approval.status === "answered" ? approval.answerText : undefined;
  const typed = text.trim();
  const send = () => {
    if (typed) void answer(approval.id, { text: typed });
  };

  return (
    <div className={`b q${fresh ? " enter" : ""}`}>
      <div className="qt">{approval.title}</div>
      {approval.detail ? <div className="qs">{approval.detail}</div> : null}
      <div className="opts">
        {reply ? (
          <div className="opt chosen">
            <span className="key">
              <Icon name="user" size={12} />
            </span>
            {reply}
            <span className="ck">
              <Icon name="check" size={16} />
            </span>
          </div>
        ) : active && !animated ? (
          <div className="opt chosen">
            <span className="key">{active}</span>
            {approval.options.find((o) => o.key === active)?.label}
            <span className="ck">
              <Icon name="check" size={16} />
            </span>
          </div>
        ) : (
          approval.options.map((o) => {
            const sel = o.key === active;
            return (
              <div className={`optrow${animated && !sel ? " away" : ""}`} key={o.key}>
                <div className="optclip">
                  <button
                    className={`opt${sel ? " chosen" : ""}`}
                    disabled={animated}
                    onClick={() => {
                      setPicked(o.key);
                      void answer(approval.id, { key: o.key });
                    }}
                  >
                    <span className="key">{o.key}</span>
                    {o.label}
                    {sel && animated ? (
                      <span className="ck">
                        <Icon name="check" size={16} />
                      </span>
                    ) : null}
                  </button>
                </div>
              </div>
            );
          })
        )}
        {reply || animated || active ? null : (
          <div className="other">
            <input
              value={text}
              placeholder="其他想法…"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
              }}
            />
            {typed ? (
              <button className="ib other-send" title="发送" onClick={send}>
                <Icon name="send" size={16} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function FileCard({ name, path, meta, fresh }: { name: string; path: string; meta?: string; fresh: boolean }) {
  return (
    <button className={`att filecard${fresh ? " enter" : ""}`} onClick={() => openFilePreview(path, name)}>
      <span className="ico">
        <Icon name={fileIcon(path)} size={18} />
      </span>
      <span>
        <span className="n" style={{ display: "block" }}>
          {name}
        </span>
        {meta ? <span className="m">{meta}</span> : null}
      </span>
    </button>
  );
}

/** 图片条目：缩略图，点开文件预览（预览里再点可以放大）。 */
function ImageCard({ name, path, fresh }: { name: string; path: string; fresh: boolean }) {
  return (
    <button className={`imgcard${fresh ? " enter" : ""}`} onClick={() => openFilePreview(path)} title={name}>
      <img src={fileUrl(path)} alt={name} loading="lazy" />
    </button>
  );
}

/**
 * 折行的气泡收到最长那一行：浏览器按最大宽度折行，折完盒子还是最大宽度，右边会空出一截。
 * 量出每行文字的最右端，把 max-width 收到那里；每行都放得下，折行位置不变，变了就退回去。
 * 行内元素按元素框量（带上 code 的内边距）。字体晚到会改字宽，到了再量一次。key 为空不收（流式中、带卡片）。
 */
function useFit<T extends HTMLElement>(key: string | undefined) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.maxWidth = "";
    if (key === undefined) return;
    let live = true;
    const fit = () => {
      if (!live) return;
      el.style.maxWidth = "";
      const box = el.getBoundingClientRect();
      if (!box.width) return;
      let right = 0;
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let rects: DOMRectList;
        if (node instanceof Element) {
          if (getComputedStyle(node).display !== "inline") continue;
          rects = node.getClientRects();
        } else {
          range.selectNodeContents(node);
          rects = range.getClientRects();
        }
        for (const rect of rects) right = Math.max(right, rect.right);
      }
      if (!right) return;
      const width = Math.ceil(right - box.left + parseFloat(getComputedStyle(el).paddingRight));
      if (width >= box.width - 1) return;
      el.style.maxWidth = `${width}px`;
      if (el.getBoundingClientRect().height > box.height + 0.5) el.style.maxWidth = "";
    };
    fit();
    void document.fonts.ready.then(fit);
    return () => {
      live = false;
    };
  }, [key]);
  return ref;
}

function ItemView({
  item,
  inlineDraft,
  fresh,
  tools,
}: {
  item: Item;
  inlineDraft?: Draft;
  fresh: boolean;
  tools: ToolsState;
}) {
  const s = useApp();
  const enter = fresh ? " enter" : "";
  // 只收用户气泡：助手这边折行的气泡要和任务卡、提问卡一样宽，右边缘才齐
  const bubble = useFit<HTMLDivElement>(item.kind === "user" ? item.text : undefined);
  const preventMenu = tools.touch ? (event: React.MouseEvent) => event.preventDefault() : undefined;
  const swipeStyle = tools.distance ? { transform: `translateX(-${Math.min(64, tools.distance * 0.8)}px)`, transition: "none" } : undefined;
  const progress = Math.min(1, tools.distance / 48);
  const swipeIcon = tools.distance > 0 ? <span className={`swipe-reply${tools.ready ? " ready" : ""}`} style={{ opacity: progress, transform: `scale(${progress})` }}><span className="swipe-reply-inner"><Icon name="reply" size={18} /></span></span> : null;

  if (item.kind === "user") {
    return (
      <div className="message-row right" id={item.from ? `forward-${item.from.delegationId}` : undefined} data-item-id={item.id} onPointerDown={tools.start} onContextMenu={preventMenu}>
        {swipeIcon}
        <div className={`hov right msg${fresh ? " enter-right" : ""}`}>
        <div className="u" ref={bubble} style={swipeStyle}>
          {item.from ? <button className="forward-label" onClick={() => void (item.from!.assistantId === "hob" ? jumpToDelegation(item.from!.assistantId, item.from!.delegationId, false) : jumpToHandback(item.from!.assistantId, item.from!.delegationId, false))}>{(() => { const sender = s.assistants.find((a) => a.id === item.from!.assistantId); return sender ? <Avatar sprite={sender.sprite} prop={sender.prop} size={16} /> : null; })()}转自 {item.from.assistantId === "hob" ? item.from.name : `「${item.from.name}」`}</button> : null}
          {item.quote ? <button className="quote" onClick={(event) => jumpToQuote(event, item.quote!.itemId)}>{item.quote.text}</button> : null}
          {item.text}
          {item.files?.length
            ? item.files.map((f) => (
                <button className="ufile" key={f} onClick={() => openFilePreview(f)}>
                  <Icon name="doc" size={13} />
                  {f.split("/").pop()}
                </button>
              ))
            : null}
        </div>
        <Tools text={item.text} itemId={item.id} />
        </div>
        {tools.open ? <MessagePopup anchor={bubble} text={item.text} itemId={item.id} close={tools.close} /> : null}
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <>
        {item.routine ? (
          <div className={`tag${fresh ? " enter-fade" : ""}`}>
            <Icon name="clock" size={13} />
            {item.routine.name}
          </div>
        ) : null}
        <div className="message-row" data-item-id={item.id} onPointerDown={tools.start} onContextMenu={preventMenu}>
          {swipeIcon}
          <div className={`hov msg${enter}`}>
          <div className={`b${inlineDraft ? " wide" : ""}`} ref={bubble} style={swipeStyle}>
            <div
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(item.text) + (item.streaming ? '<span class="cur"></span>' : ""),
              }}
            />
            {inlineDraft ? <DraftCard draft={inlineDraft} /> : null}
          </div>
          <Tools text={item.text} itemId={item.id} />
          </div>
          {tools.open ? <MessagePopup anchor={bubble} text={item.text} itemId={item.id} close={tools.close} /> : null}
        </div>
      </>
    );
  }

  if (item.kind === "note") {
    return (
      <div className={`sys${fresh ? " enter-fade" : ""}`} id={item.handbackId ? `handback-${item.handbackId}` : undefined}>
        {item.icon !== "split" ? <Icon name={NOTE_ICON[item.icon]} size={14} /> : null}
        {item.handbackId ? <button onClick={() => void jumpToHandback("hob", item.handbackId!, true)}>{item.text}</button> : item.text}
      </div>
    );
  }

  if (item.kind === "question") {
    const ap = s.approvals[item.approvalId];
    return ap ? <QuestionCard approval={ap} fresh={fresh} /> : null;
  }

  if (item.kind === "job") {
    const job = s.jobs[item.jobId];
    return job ? <JobCard job={job} fresh={fresh} /> : null;
  }

  if (item.kind === "draft") {
    const draft = s.drafts[item.draftId];
    return draft ? (
      <div className={`b wide${enter}`}>
        <DraftCard draft={draft} />
      </div>
    ) : null;
  }

  if (item.kind === "delegation") {
    const delegation = s.delegations[item.delegationId];
    return delegation ? <DelegationCard delegation={delegation} fresh={fresh} /> : null;
  }

  return isImagePath(item.path) ? (
    <ImageCard path={item.path} name={item.name} fresh={fresh} />
  ) : (
    <FileCard path={item.path} name={item.name} meta={item.meta} fresh={fresh} />
  );
}

/** 同一次回复里的几条贴着（只有气泡自己的 4px），换一方说话或开新的一组（lead）才拉开。 */
function opensGroup(prev: Item | undefined, cur: Item): boolean {
  if (!prev) return false;
  return (prev.kind === "user") !== (cur.kind === "user") || Boolean(cur.lead);
}

export function ItemList({ items }: { items: Item[] }) {
  const s = useApp();
  const touch = useNoHover();
  const [openId, dispatchMenu] = useReducer(messageMenu, null);
  const press = useRef<{ timer: number; pointerId: number; id: string; text: string; swipe: SwipeState; ready: boolean } | null>(null);
  const [swipe, setSwipe] = useState<{ id: string; distance: number; ready: boolean } | null>(null);
  useEffect(() => {
    const cancel = () => {
      if (press.current) window.clearTimeout(press.current.timer);
      press.current = null;
      setSwipe(null);
    };
    const down = (event: PointerEvent) => {
      dispatchMenu({ type: "outside", inside: event.target instanceof Element && Boolean(event.target.closest(".tools.menu")) });
    };
    const move = (event: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      p.swipe = moveSwipe(p.swipe, event.clientX, event.clientY);
      if (Math.hypot(event.clientX - p.swipe.x, event.clientY - p.swipe.y) > 10) window.clearTimeout(p.timer);
      if (p.swipe.direction === "vertical") { cancel(); return; }
      if (p.swipe.direction !== "horizontal") return;
      window.clearTimeout(p.timer);
      const ready = swipeReply(p.swipe);
      if (ready && !p.ready) navigator.vibrate?.(10);
      p.ready = ready;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        if (ready) {
          setQuote({ itemId: p.id, text: plain(p.text).slice(0, 60) });
          focusComposer();
          cancel();
        }
        return;
      }
      setSwipe({ id: p.id, distance: p.swipe.distance, ready });
    };
    const up = (event: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      if (swipeReply(p.swipe)) {
        setQuote({ itemId: p.id, text: plain(p.text).slice(0, 60) });
        focusComposer();
      }
      cancel();
    };
    const scroll = () => { cancel(); dispatchMenu({ type: "close" }); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("scroll", scroll, true);
    };
  }, []);
  const rows: ReactNode[] = [];
  if (items.length && !isToday(items[0].at) && items[0].kind !== "note") {
    rows.push(
      <div className="div" key="first-div">
        {fmtWhen(items[0].at)}
      </div>,
    );
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prev = items[i - 1];
    const next = items[i + 1];
    const fresh = isFresh(item.id);
    const inline = item.kind === "assistant" && next?.kind === "draft" ? s.drafts[next.draftId] : undefined;
    const tools: ToolsState = {
      open: touch && openId === item.id,
      touch,
      distance: swipe?.id === item.id ? swipe.distance : 0,
      ready: swipe?.id === item.id && swipe.ready,
      close: () => dispatchMenu({ type: "close" }),
      start: touch ? (event) => {
        if (event.pointerType !== "touch" || (item.kind !== "user" && item.kind !== "assistant") || (event.target as Element).closest("a,button,input,textarea,select,[contenteditable],.draft")) return;
        if (press.current) window.clearTimeout(press.current.timer);
        const { clientX: x, clientY: y, pointerId } = event;
        const timer = window.setTimeout(() => {
          press.current = null;
          dispatchMenu({ type: "open", id: item.id });
        }, 500);
        press.current = { timer, pointerId, id: item.id, text: item.text, swipe: { x, y, direction: "pending", distance: 0 }, ready: false };
      } : undefined,
    };
    if (inline) i++;
    rows.push(
      <Fragment key={item.id}>
        {needDivider(prev?.at, item.at) ? (
          <div className={`div${fresh ? " enter-fade" : ""}`}>{fmtWhen(item.at)}</div>
        ) : opensGroup(prev, item) ? (
          <div className="g" />
        ) : null}
        <ItemView item={item} inlineDraft={inline} fresh={fresh} tools={tools} />
      </Fragment>,
    );
  }
  for (const page of visibleLiveCards(Object.values(s.livePages), s.sel)) {
    rows.push(<button key={page.callId} className={`att filecard${page.state === "failed" ? " bad" : ""}`} onClick={() => openLivePreview(page.callId)}>
      <span className="ico"><Icon name={page.state === "writing" ? "spin" : "close"} className={page.state === "writing" ? "spin" : ""} size={18} /></span>
      <span><span className="n" style={{ display: "block" }}>{page.title || "正在写页面…"}</span><span className="m">{page.state === "failed" ? `生成失败：${page.error}` : "生成中"}</span></span>
    </button>);
  }
  return <>{rows}</>;
}
