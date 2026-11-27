import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devTeamGroup, devTeamRoles } from "../src/dev-team.ts";
import { defaultSettings, SettingsStore } from "../src/settings.ts";
import { Store } from "../src/store.ts";

const homes: string[] = [];
function home(): string {
  const value = mkdtempSync(join(tmpdir(), "hob-i18n-"));
  homes.push(value);
  return value;
}
afterEach(() => {
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("locale-dependent defaults", () => {
  it("waits for the first locale before creating defaults and creates them once", () => {
    const value = home();
    const store = new Store(value);
    store.init();
    store.ensurePrimary();
    expect(store.globalRules()).toEqual([]);

    store.initializeDefaults("en");
    expect(store.globalRules()).toHaveLength(7);
    expect(store.globalRules().every((rule) => /^(Ask me before |Past|Before|Read)/.test(rule.text))).toBe(true);
    expect(store.assistant("hob")?.duty).toBe("Main assistant");

    store.initializeDefaults("zh-CN");
    expect(store.assistant("hob")?.duty).toBe("Main assistant");
    expect(devTeamGroup("en").name).toBe("Agile team");
    expect(devTeamRoles("en").map((role) => role.name)).toEqual(["Product owner", "Architect", "Developer", "QA", "Release"]);
  });

  it("writes natural-sentence default rules into rules.json for zh-CN and en", () => {
    const zhHome = home();
    const zhStore = new Store(zhHome);
    zhStore.init("zh-CN");
    const zhSaved = JSON.parse(readFileSync(join(zhHome, "rules.json"), "utf8")) as { text: string }[];
    expect(zhSaved.map((r) => r.text)).toEqual([
      "删除或覆盖文件、数据和备份之前，先问我。",
      "对外发消息、发邮件、发布内容，或者付费、充值、改计费之前，先问我。",
      "停止或重启别人正在用的服务和设备之前，先问我。",
      "改网络、防火墙、登录方式这类可能让我连不上的设置之前，先问我。",
      "过去的记录是线索不是现状：动手前先核实实际状态。",
      "改配置、改数据前先留好退路（备份或记下原值）；改完用实际效果验证，不只看命令返回。",
      "凭据（密码、密钥、令牌、Cookie）只在用的时候读取，不回显，不写进文件和报告，也不存起来。",
    ]);

    const enHome = home();
    const enStore = new Store(enHome);
    enStore.init("en");
    const enSaved = JSON.parse(readFileSync(join(enHome, "rules.json"), "utf8")) as { text: string }[];
    expect(enSaved.map((r) => r.text)).toEqual([
      "Ask me before deleting or overwriting files, data or backups.",
      "Ask me before sending messages or emails, publishing content, or paying, topping up or changing billing.",
      "Ask me before stopping or restarting services or devices that others are using.",
      "Ask me before changing network, firewall or sign-in settings that could cut off my access.",
      "Past records are leads, not the current state: check the actual state before acting.",
      "Before changing configuration or data, keep a way back (a backup or the original values); afterwards, verify the actual effect, not just the command's output.",
      "Read credentials (passwords, keys, tokens, cookies) only when you use them; don't echo them, write them into files or reports, or store them.",
    ]);
  });

  it("adds Chinese to an old settings file that already has seeded content", () => {
    const value = home();
    mkdirSync(join(value, "system"), { recursive: true });
    writeFileSync(join(value, "system", "seeded.json"), JSON.stringify({ devTeam: true }));
    writeFileSync(join(value, "system", "settings.json"), JSON.stringify({ revision: 1, settings: defaultSettings("UTC") }));
    const settings = new SettingsStore(value);
    expect(settings.settings.general.locale).toBe("zh-CN");
    const saved = JSON.parse(readFileSync(join(value, "system", "settings.json"), "utf8")) as { settings: { general: { locale?: string } } };
    expect(saved.settings.general.locale).toBe("zh-CN");
  });

  it("does not assign a locale to a new settings file", () => {
    const value = home();
    const settings = new SettingsStore(value);
    expect(settings.settings.general.locale).toBeUndefined();
  });
});
