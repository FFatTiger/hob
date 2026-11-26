import { describe, expect, it } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import "../src/i18n/en/index.ts";
import { desktopUserWhere, panelDesk } from "../src/panel-stack.ts";

const groups = [
  { id: "g", name: "网站项目", ownerId: "po", members: ["dev", "po", "qa"] },
  { id: "t", name: "深色模式", parentId: "g", ownerId: "po", members: ["dev", "po", "qa"] },
  { id: "t2", name: "登录重构", parentId: "g", ownerId: "po", members: ["dev", "po", "qa"] },
  { id: "g2", name: "运维群", ownerId: "dev", members: ["dev"] },
];
const assistants = [
  { id: "po", name: "产品" },
  { id: "dev", name: "开发" },
  { id: "qa", name: "测试" },
  { id: "solo", name: "个人助理" },
];
const profiles = { po: "s-po", dev: "s-dev", qa: "s-qa", solo: "s-solo" };
const screens = (...running: string[]) => ["s-po", "s-dev", "s-qa", "s-solo"].map((id) => ({ id, running: running.includes(id) }));

describe("panelDesk：右栏云桌面按会话呈现", () => {
  it("单聊：本会话在用才内嵌小屏，别处在用和没人用分别返回 elsewhere / idle", () => {
    expect(panelDesk([], "solo", null, groups, {
      screens: screens("s-solo"),
      profiles,
      users: { "s-solo": [{ assistantId: "solo", jobId: "j-1", place: {} }] },
    })).toEqual({
      aid: "solo", screenId: "s-solo", running: true, status: "active", watch: ["s-solo"], activeWatch: ["s-solo"],
    });

    expect(panelDesk([], "solo", null, groups, {
      screens: screens("s-solo"),
      profiles,
      users: { "s-solo": [{ assistantId: "solo", jobId: "j-2", place: { groupId: "t" } }] },
    })).toEqual({
      aid: "solo", screenId: "s-solo", running: false, status: "elsewhere",
      usedBy: { assistantId: "solo", jobId: "j-2", place: { groupId: "t" } },
      watch: ["s-solo"], activeWatch: [],
    });

    expect(panelDesk([], "solo", null, groups, {
      screens: screens("s-solo"),
      profiles,
      users: {},
    })).toEqual({
      aid: "solo", screenId: "s-solo", running: false, status: "idle", watch: ["s-solo"], activeWatch: [],
    });

    expect(panelDesk([], "solo", null, groups, {
      screens: [],
      profiles,
      users: {},
    })).toEqual({
      aid: "solo", screenId: "s-solo", running: false, status: "off", watch: ["s-solo"], activeWatch: [],
    });
  });

  it("群话题：先挑正被本话题用着的屏幕；别处在用时显示别处；没人用时显示空闲", () => {
    // 群主屏幕在 t2 用，qa 屏幕在当前话题 t 用 → 选中 qa
    expect(panelDesk([], null, "t", groups, {
      screens: screens("s-po", "s-qa"),
      profiles,
      users: {
        "s-po": [{ assistantId: "po", place: { groupId: "t2" } }],
        "s-qa": [{ assistantId: "qa", jobId: "j-qa", place: { groupId: "t" } }],
      },
    })).toMatchObject({ aid: "qa", screenId: "s-qa", running: true, status: "active", activeWatch: ["s-qa"], watch: ["s-po", "s-dev", "s-qa"] });

    // 本话题没人用，dev 屏幕在单聊用 → elsewhere
    expect(panelDesk([], null, "t", groups, {
      screens: screens("s-dev"),
      profiles,
      users: { "s-dev": [{ assistantId: "dev", place: {} }] },
    })).toMatchObject({ aid: "dev", screenId: "s-dev", running: false, status: "elsewhere", usedBy: { assistantId: "dev", place: {} }, activeWatch: [] });

    // 即使有屏幕处于运行态但没人占用 → idle（不内嵌小屏）
    expect(panelDesk([], null, "t", groups, {
      screens: screens("s-qa"),
      profiles,
      users: {},
    })).toMatchObject({ aid: "qa", screenId: "s-qa", running: false, status: "idle", activeWatch: [] });

    expect(panelDesk([], null, "t", groups, {
      screens: screens(),
      profiles,
      users: {},
    })).toMatchObject({ aid: "po", screenId: "s-po", running: false, status: "idle", activeWatch: [] });
  });

  it("群综合汇总本群及名下话题；其他群或单聊的占用视为别处", () => {
    expect(panelDesk([], null, "g", groups, {
      screens: screens("s-qa"),
      profiles,
      users: { "s-qa": [{ assistantId: "qa", place: { groupId: "t" } }] },
    })).toMatchObject({ aid: "qa", running: true, status: "active", activeWatch: ["s-qa"] });

    expect(panelDesk([], null, "g", groups, {
      screens: screens("s-dev"),
      profiles,
      users: { "s-dev": [{ assistantId: "dev", place: { groupId: "g2" } }] },
    })).toMatchObject({ aid: "dev", running: false, status: "elsewhere", usedBy: { assistantId: "dev", place: { groupId: "g2" } }, activeWatch: [] });
  });

  it("群里推进了成员页：只看那个成员，但仍按当前群/话题判断", () => {
    expect(panelDesk([{ kind: "member", id: "dev" }], null, "t", groups, {
      screens: screens("s-qa", "s-dev"),
      profiles,
      users: {
        "s-qa": [{ assistantId: "qa", place: { groupId: "t" } }],
        "s-dev": [{ assistantId: "dev", place: { groupId: "t2" } }],
      },
    })).toMatchObject({ aid: "dev", screenId: "s-dev", running: false, status: "elsewhere", usedBy: { assistantId: "dev", place: { groupId: "t2" } } });
  });

  it("助手话题通过 place.topicId 判断本会话或别处", () => {
    expect(panelDesk([], "solo", null, groups, {
      screens: screens("s-solo"),
      profiles,
      users: { "s-solo": [{ assistantId: "solo", place: { topicId: "tp-1" } }] },
    }, { topicId: "tp-1" })).toMatchObject({ status: "active", running: true });

    expect(panelDesk([], "solo", null, groups, {
      screens: screens("s-solo"),
      profiles,
      users: { "s-solo": [{ assistantId: "solo", place: {} }] },
    }, { topicId: "tp-1" })).toMatchObject({ status: "elsewhere", running: false });
  });

  it("desktopUserWhere 按当前会话格式化「正在用」来源名称（中英文）", () => {
    setLocale("zh-CN");
    expect(desktopUserWhere({ assistantId: "dev", place: { groupId: "t2" } }, groups, assistants, "t")).toBe("登录重构");
    expect(desktopUserWhere({ assistantId: "dev", place: { groupId: "g" } }, groups, assistants, "t")).toBe("综合");
    expect(desktopUserWhere({ assistantId: "dev", place: { groupId: "t2" } }, groups, assistants, null)).toBe("网站项目 · 登录重构");
    expect(desktopUserWhere({ assistantId: "dev", place: { groupId: "g2" } }, groups, assistants, "t")).toBe("运维群");
    expect(desktopUserWhere({ assistantId: "dev", place: {} }, groups, assistants, "t")).toBe("开发 · 单聊");
    expect(desktopUserWhere({ assistantId: "solo", place: { topicId: "tp-1" } }, groups, assistants, null, [{ id: "tp-1", name: "下月搬家" }])).toBe("下月搬家");

    setLocale("en");
    expect(desktopUserWhere({ assistantId: "dev", place: { groupId: "g" } }, groups, assistants, "t")).toBe("General");
    expect(desktopUserWhere({ assistantId: "dev", place: {} }, groups, assistants, "t")).toBe("开发 · Direct chat");
    setLocale("zh-CN");
  });
});
