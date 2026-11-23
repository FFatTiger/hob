import { describe, expect, it, vi } from "vitest";
vi.mock("../store.ts", () => ({ deletePluginLogin: vi.fn(), loadPluginLoginSecret: vi.fn(), savePluginLogin: vi.fn() }));
import { parseLoginCsv } from "./PluginLogins.tsx";

describe("password vault CSV import", () => {
  it("recognizes Bitwarden, Chrome, and 1Password headers in memory", () => {
    expect(parseLoginCsv("name,login_uri,login_username,login_password,folder\n论坛,https://forum.example,lin@example.com,secret,工作")).toEqual([{ name: "论坛", uri: "https://forum.example", username: "lin@example.com", password: "secret", folder: "工作" }]);
    expect(parseLoginCsv("\ufeffname,url,username,password\n商城,https://shop.example,buyer@example.com,shop-secret")).toEqual([{ name: "商城", uri: "https://shop.example", username: "buyer@example.com", password: "shop-secret" }]);
    expect(parseLoginCsv("Title,Url,Username,Password\n文档,https://docs.example,writer@example.com,doc-secret")).toEqual([{ name: "文档", uri: "https://docs.example", username: "writer@example.com", password: "doc-secret" }]);
  });

  it("handles quoted commas and skips rows without a password", () => {
    expect(parseLoginCsv("name,url,username,password\n\"带,逗号\",https://example.test,user,secret\n空密码,https://empty.test,user,")).toEqual([{ name: "带,逗号", uri: "https://example.test", username: "user", password: "secret" }]);
  });
});
