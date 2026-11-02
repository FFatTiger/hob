// 手机（宽 < 768px）：列表页 + 右栏内容的整页。
import { matches } from "../home.ts";
import { Icon } from "../icons.tsx";
import { focusComposer, newAssistant, openSettings, setQuery, setSearch, useApp } from "../store.ts";
import { HomeSections, pinLayout, Pin } from "./HomeSections.tsx";
import { Panel } from "./Panel.tsx";

export function MobileList() {
  const s = useApp();
  const pins = s.assistants.filter((a) => a.pinned && !a.hidden && matches(a, s.query));
  const layout = pinLayout(pins.length);

  return (
    <>
      <div className="mhead">
        <button className="me" title="设置" onClick={openSettings}>
          <Icon name="user" size={17} />
        </button>
        <span className="sp" />
        {s.search ? (
          <div className="msearch">
            <Icon name="search" size={15} />
            <input autoFocus value={s.query} placeholder="搜索助手" onChange={(e) => setQuery(e.target.value)} />
            <button onClick={() => setSearch(false)} title="关闭搜索">
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : (
          <>
            <button className="ib" title="搜索助手" onClick={() => setSearch(true)}>
              <Icon name="search" size={19} />
            </button>
            <button className="ib" title="创建专属助手" onClick={newAssistant}>
              <Icon name="plus" size={21} />
            </button>
            <button className="ib" title="写新消息" onClick={focusComposer}>
              <Icon name="edit" size={19} />
            </button>
          </>
        )}
      </div>
      <div className={`mpins${layout.cls}`}>
        {pins.map((a) => (
          <Pin key={a.id} a={a} size={layout.size} />
        ))}
      </div>
      <div className="mlist">
        <HomeSections size={36} />
      </div>
    </>
  );
}

export function Sheet({ leaving }: { leaving: boolean }) {
  return (
    <div className={`mfull${leaving ? " leaving" : ""}`}>
      <Panel mobile />
    </div>
  );
}
