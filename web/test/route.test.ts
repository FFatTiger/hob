import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "../src/route.ts";

describe("地址 hash", () => {
  it("当前页面写成 hash，读回来是同一页", () => {
    const chat = routeHash({ page: "main", section: null, sel: "ops 2", mobile: "chat" }, true);
    expect(chat).toBe("#/chat/ops%202");
    expect(parseRoute(chat)).toEqual({ sel: "ops 2", settings: false, section: null });
    const models = routeHash({ page: "settings", section: "models", sel: "hob", mobile: "list" }, false);
    expect(parseRoute(models)).toEqual({ sel: null, settings: true, section: "models" });
  });

  it("手机首页列表没有 hash，桌面总带当前助手", () => {
    expect(routeHash({ page: "main", section: null, sel: "ops", mobile: "list" }, true)).toBe("");
    expect(routeHash({ page: "main", section: null, sel: "ops", mobile: "list" }, false)).toBe("#/chat/ops");
  });

  it("认不出的 hash 不改任何东西", () => {
    expect(parseRoute("#/settings/nope")).toEqual({ sel: null, settings: true, section: null });
    for (const h of ["", "#", "#/chat", "#/x/y", "#ops", "#/chat/%E0"]) expect(parseRoute(h)).toEqual({ sel: null, settings: false, section: null });
  });
});
