// 桌面首页：没打开对话时中间这一块。一条竖线居中：主助手、问候、一句概况、跟主助手说话的输入框。
// 等你确认、进行中、对话、最近任务、定时任务照旧在左栏，这里不重复列。
import { useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { homeGroups } from "../home.ts";
import { Icon } from "../icons.tsx";
import { deriveHomeMood, typingLook, useIdleSleep, useTypingPulse } from "../pet/pet-mood.ts";
import { Avatar } from "../sprites.tsx";
import { select, send, useApp } from "../store.ts";
import { sendName } from "./Chat.tsx";

function greeting(hour = new Date().getHours()): string {
  if (hour < 6) return t("夜深了");
  if (hour < 11) return t("早上好");
  if (hour < 13) return t("中午好");
  if (hour < 18) return t("下午好");
  return t("晚上好");
}

export function Home() {
  const s = useApp();
  const [text, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const primary = s.assistants.find((a) => a.primary) ?? s.assistants[0];
  const g = homeGroups(s);
  const waiting = g.asks.length;
  const summary = [waiting ? t("{n} 件等你确认", { n: waiting }) : "", g.live.length ? t("{n} 件进行中", { n: g.live.length }) : ""].filter(Boolean).join(" · ") || t("现在没有要你处理的事");
  // 在首页说的话发给主助手，发完进它的对话
  const ask = () => {
    const body = text.trim();
    if (!body || !primary) return;
    void select(primary.id);
    setDraft("");
    void send(body);
  };

  const hour = new Date().getHours();
  const isLateNight = hour < 6;
  const typing = useTypingPulse(text);
  const watchingInput = focused || typing;
  const idleAsleep = useIdleSleep(!watchingInput && waiting === 0 && g.live.length === 0, isLateNight ? 20000 : 60000, isLateNight);
  const heroState = deriveHomeMood({ waitingCount: waiting, liveCount: g.live.length, typing: watchingInput, idleAsleep });
  const taEl = ta.current;
  const taStyle = taEl && typeof getComputedStyle === "function" ? getComputedStyle(taEl) : null;
  const taFont = taStyle ? `${taStyle.fontWeight} ${taStyle.fontSize} ${taStyle.fontFamily}` : undefined;
  const taWidth = taEl ? Math.max(180, taEl.clientWidth - (parseFloat(taStyle?.paddingLeft || "0") + parseFloat(taStyle?.paddingRight || "0"))) : 480;
  const heroFocusLook = watchingInput ? typingLook(text, caret, taWidth, taFont) : undefined;

  return (
    <main className="home">
      <div className="home-in">
        {primary ? (
          <Avatar
            sprite={primary.sprite}
            prop={primary.prop}
            size={112}
            free
            live
            interactive
            follow
            ambient
            petState={heroState}
            focusLook={heroFocusLook}
            glow={watchingInput || waiting > 0 || g.live.length > 0}
          />
        ) : null}
        <h1>{greeting(hour)}</h1>
        <p className="home-sum">{summary}</p>
        <div className="comp home-ask">
          <div className="comp-main">
            <textarea
              ref={ta}
              className="ta"
              rows={1}
              value={text}
              placeholder={t("有事跟{assistant}说，它来安排", { assistant: sendName(primary?.name ?? "Hob") })}
              onFocus={(e) => {
                setFocused(true);
                setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
              }}
              onBlur={() => setFocused(false)}
              onChange={(e) => {
                setDraft(e.target.value);
                setCaret(e.currentTarget.selectionStart ?? e.target.value.length);
              }}
              onCompositionUpdate={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  ask();
                }
              }}
            />
            <button className="sendbtn" title={t("发送")} disabled={!text.trim()} onClick={ask}>
              <Icon name="send" size={17} />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
