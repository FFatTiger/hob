import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answerCard } from "../src/actions.ts";
import { pluginToolDisplayNames, pluginToolsForAssistant } from "../src/plugin-host.ts";
import { searchPluginsTool } from "../src/search-plugins.ts";
import { visibleSkills } from "../src/skills.ts";
import { call, makeHob, text } from "./helpers.ts";

const hobs: ReturnType<typeof makeHob>[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const hob of hobs.splice(0)) {
    await hob.runtime.plugins.close();
    hob.close();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fakeOpsctl = fileURLToPath(new URL("./fixtures/fake-opsctl-mcp.mjs", import.meta.url));

async function setupOpskatHob(config: Record<string, unknown> = {}) {
  const hob = makeHob({}, { memory: "off" });
  hobs.push(hob);
  const host = hob.runtime.plugins;
  expect(host.store.catalog().map((item) => item.id)).toContain("opskat");
  host.store.install("opskat");
  host.store.saveConfig("opskat", { OPSCTL_PATH: fakeOpsctl, APPROVAL_MODE: "hob_card", TOOLSET: "core", ...config });
  await host.start();
  return hob;
}

function findButton(card: any, label: string): any {
  const walk = (elements: any[]): any => {
    for (const el of elements ?? []) {
      if (el.tag === "button" && el.text === label) return el;
      if (el.elements) {
        const found = walk(el.elements);
        if (found) return found;
      }
      if (el.columns) {
        for (const col of el.columns) {
          const found = walk(col.elements);
          if (found) return found;
        }
      }
    }
    return undefined;
  };
  return walk(card.body.elements);
}

describe("built-in OpsKat plugin with out-of-band IPC approval control plane", () => {
  it("exposes 8 direct core tools and keeps 8 core tools direct in full mode (18 total)", async () => {
    const hob = await setupOpskatHob();
    const host = hob.runtime.plugins;
    const tools = pluginToolsForAssistant(host, "hob");
    const names = tools.map((tool) => tool.name);

    expect(tools.length).toBe(8);
    expect(tools.every((tool) => tool.exposure === "direct")).toBe(true);
    expect(names).toContain("opskat_exec");
    expect(names).toContain("opskat_batch_exec");
    expect(names).toContain("opskat_request_permission");
    expect(names).toContain("opskat_get_task");
    expect(names).not.toContain("opskat_list_audit");
    expect(names).not.toContain("opskat__approval_resolve");
    expect(names).not.toContain("opskat_opskat_card_callback");
    expect(pluginToolDisplayNames(host)).not.toHaveProperty("opskat_opskat_card_callback");

    // Full toolset (18 tools): 8 core tools stay direct, 10 secondary tools (including list_audit) are deferred
    host.store.saveConfig("opskat", { TOOLSET: "full" });
    await host.reload("opskat");
    const fullTools = pluginToolsForAssistant(host, "hob");
    expect(fullTools.length).toBe(18);
    expect(fullTools.filter((tool) => tool.exposure === "direct").length).toBe(8);
    expect(fullTools.filter((tool) => tool.exposure === "deferred").length).toBe(10);
    expect(fullTools.find((tool) => tool.name === "opskat_exec")?.exposure).toBe("direct");
    expect(fullTools.find((tool) => tool.name === "opskat_list_audit")?.exposure).toBe("deferred");
    expect(fullTools.find((tool) => tool.name === "opskat_put_asset")?.exposure).toBe("deferred");
  });

  it("suppresses conflicting local opsctl skill and supports Chinese search_plugins queries", async () => {
    const hob = await setupOpskatHob();
    const fakeHome = mkdtempSync(join(tmpdir(), "hob-opskat-home-"));
    tempDirs.push(fakeHome);
    mkdirSync(join(fakeHome, ".agents/skills/opsctl"), { recursive: true });
    mkdirSync(join(fakeHome, ".agents/skills/other-skill"), { recursive: true });
    writeFileSync(join(fakeHome, ".agents/skills/opsctl/SKILL.md"), "---\nname: opsctl\ndescription: CLI skill\n---\n");
    writeFileSync(join(fakeHome, ".agents/skills/other-skill/SKILL.md"), "---\nname: other-skill\ndescription: Other\n---\n");

    const skills = visibleSkills(hob.runtime, "hob", undefined, fakeHome);
    expect(skills.map((s) => s.name)).not.toContain("opsctl");
    expect(skills.map((s) => s.name)).toContain("other-skill");

    const searchTool = searchPluginsTool(hob.runtime.plugins, "hob");
    const result = await searchTool.execute("c1", { query: "运维 审批" });
    expect(result.content[0]?.text).toContain("OpsKat");
  });

  it("fetches approval details out-of-band, hides permanent button by default, and leaks zero approval payload into router.jsonl", async () => {
    const hob = await setupOpskatHob();

    // Interactive plugin card sets terminate:true, so no follow-up assistant text is generated after showing the card.
    hob.faux.setResponses([call("opskat_exec", { asset: "1", command: "review-reject systemctl restart nginx" }), text("不应该说这句废话")]);
    await hob.runtime.router.send("hob", { text: "重启 nginx" });
    await hob.runtime.router.waitIdle("hob");

    const routerBeforeClick = readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8");
    expect(routerBeforeClick).not.toContain("不应该说这句废话");
    // Reference-Passing security check: internal policy/review details must NEVER enter router.jsonl or LLM context!
    expect(routerBeforeClick).not.toContain("禁止生产删库");
    expect(routerBeforeClick).not.toContain("allowed_decisions");

    // Human-facing card (fetched over out-of-band IPC) DOES show review rule & buttons (without allow_permanent by default)
    const record = hob.runtime.store.cards()[0]!;
    expect(record.owner).toMatchObject({ type: "plugin", pluginId: "opskat" });
    expect(record.plugin?.callbackTool).toBe("opskat_card_callback");
    expect(JSON.stringify(record.card)).toContain("禁止生产删库");
    const allowBtn = findButton(record.card, "本次允许");
    const denyBtn = findButton(record.card, "拒绝");
    expect(allowBtn?.name).toMatch(/^opskat:apr:allow:apr_/);
    expect(denyBtn?.name).toMatch(/^opskat:apr:deny:apr_/);
    expect(findButton(record.card, "记住 24 小时")).toBeTruthy();
    expect(findButton(record.card, "永久允许")).toBeUndefined();

    hob.faux.setResponses([text("已重启完成")]);
    const allowResp = await answerCard(hob.runtime, record.id, {
      action: { tag: "button", name: allowBtn.name },
      button_text: "本次允许",
    });
    expect(allowResp.status).toBe(200);
    await hob.runtime.router.waitIdle("hob");

    const updated = hob.runtime.store.card(record.id)!;
    expect(findButton(updated.card, "本次允许")).toBeUndefined();
    expect(JSON.stringify(updated.card)).toContain("已允许 · 执行完成");
    const routerLog = readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8");
    expect(routerLog).toContain("ran(allow): review-reject systemctl restart nginx -> allowed ok");

    // Deny flow
    hob.faux.setResponses([call("opskat_exec", { asset: "1", command: "rm -rf /tmp/x" })]);
    await hob.runtime.router.send("hob", { text: "清理目录" });
    await hob.runtime.router.waitIdle("hob");
    const denyCard = hob.runtime.store.cards().find((c) => c.id !== record.id)!;
    const denyAction = findButton(denyCard.card, "拒绝");

    hob.faux.setResponses([text("已停止")]);
    const denyResp = await answerCard(hob.runtime, denyCard.id, {
      action: { tag: "button", name: denyAction.name },
      button_text: "拒绝",
    });
    expect(denyResp.status).toBe(200);
    await hob.runtime.router.waitIdle("hob");
    expect(JSON.stringify(hob.runtime.store.card(denyCard.id)!.card)).toContain("已拒绝");
  });

  it("shows allow_permanent only when ALLOW_PERMANENT=true and keeps card open with toast when shadowed", async () => {
    const hob = await setupOpskatHob({ ALLOW_PERMANENT: true });
    hob.faux.setResponses([call("opskat_exec", { asset: "1", command: "shadow-perm cmd" })]);
    await hob.runtime.router.send("hob", { text: "运行 shadow-perm" });
    await hob.runtime.router.waitIdle("hob");

    const record = hob.runtime.store.cards()[0]!;
    const permBtn = findButton(record.card, "永久允许");
    const allowBtn = findButton(record.card, "本次允许");
    expect(permBtn).toBeTruthy();

    const failed = await answerCard(hob.runtime, record.id, {
      action: { tag: "button", name: permBtn.name },
      button_text: "永久允许",
    });
    expect(failed.status).toBe(200);
    const afterFail = hob.runtime.store.card(record.id)!;
    expect(afterFail.feedback?.toast?.type).toBe("error");
    expect(afterFail.feedback?.toast?.content).toContain("shadowed by deny");
    expect(findButton(afterFail.card, "本次允许")).toBeTruthy();

    hob.faux.setResponses([text("执行完成")]);
    const retried = await answerCard(hob.runtime, record.id, {
      action: { tag: "button", name: allowBtn.name },
      button_text: "本次允许",
    });
    expect(retried.status).toBe(200);
    await hob.runtime.router.waitIdle("hob");
    expect(JSON.stringify(hob.runtime.store.card(record.id)!.card)).toContain("已允许 · 执行完成");
  });

  it("morphs approval card into MFA password card over out-of-band IPC and scrubs MFA secret even with whitespace", async () => {
    const hob = await setupOpskatHob();
    hob.faux.setResponses([call("opskat_exec", { asset: "1", command: "need-mfa deploy" })]);
    await hob.runtime.router.send("hob", { text: "部署" });
    await hob.runtime.router.waitIdle("hob");

    const record = hob.runtime.store.cards()[0]!;
    const allowBtn = findButton(record.card, "本次允许");

    const morphed = await answerCard(hob.runtime, record.id, {
      action: { tag: "button", name: allowBtn.name },
      button_text: "本次允许",
    });
    expect(morphed.status).toBe(200);
    const mfaCard = hob.runtime.store.card(record.id)!;
    expect(mfaCard.card.header?.title).toContain("两步验证");
    const submitBtn = findButton(mfaCard.card, "提交验证");
    expect(submitBtn?.name).toMatch(/^opskat:mfa:allow:apr_mfa_/);

    const emptySubmit = await answerCard(hob.runtime, record.id, {
      action: { tag: "button", name: submitBtn.name },
      form_value: { mfa_0: "" },
      button_text: "提交验证",
    });
    expect(emptySubmit.status).toBe(200);
    expect(hob.runtime.store.card(record.id)!.feedback?.errors?.mfa_0).toBe("请输入验证码");

    const totp = "987654-secret-totp";
    hob.faux.setResponses([text("MFA 验证通过")]);
    const submitted = await answerCard(hob.runtime, record.id, {
      action: { tag: "button", name: submitBtn.name },
      form_value: { mfa_0: ` ${totp} ` },
      button_text: "提交验证",
    });
    expect(submitted.status).toBe(200);
    await hob.runtime.router.waitIdle("hob");

    const cardsJson = readFileSync(join(hob.home, "assistants/hob/cards.json"), "utf8");
    const routerLog = readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8");
    expect(cardsJson).not.toContain(totp);
    expect(routerLog).not.toContain(totp);
    expect(routerLog).toContain("ssh verified with code=*** and allowed ok");
  });

  it("handles get_task PauseRef, local_tool cp card, batch_exec, and single-line grant unredacted", async () => {
    const hob = await setupOpskatHob({ ALLOW_LOCAL_DIRS: "/tmp/safe,/var/tmp" });

    // 1. Slow command -> running -> opskat_get_task returns PauseRef -> server fetches MFA payload out-of-band
    hob.faux.setResponses([call("opskat_exec", { asset: "1", command: "slow-mfa migrate" })]);
    await hob.runtime.router.send("hob", { text: "执行慢迁移" });
    await hob.runtime.router.waitIdle("hob");
    const slowCard = hob.runtime.store.cards()[0]!;
    const allowSlow = findButton(slowCard.card, "本次允许");

    hob.faux.setResponses([text("等待任务")]);
    await answerCard(hob.runtime, slowCard.id, {
      action: { tag: "button", name: allowSlow.name },
      button_text: "本次允许",
    });
    await hob.runtime.router.waitIdle("hob");
    const logAfterRunning = readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8");
    const match = /task_id=\\"(tsk_\d+)\\"/.exec(logAfterRunning);
    const taskId = match?.[1] ?? "";
    expect(taskId).toMatch(/^tsk_\d+$/);

    hob.faux.setResponses([call("opskat_get_task", { task_id: taskId })]);
    await hob.runtime.router.send("hob", { text: "查看任务状态" });
    await hob.runtime.router.waitIdle("hob");
    const mfaFromGetTask = hob.runtime.store.cards().find((c) => c.id !== slowCard.id)!;
    const mfaSubmit = findButton(mfaFromGetTask.card, "提交验证");
    expect(mfaSubmit?.name).toMatch(/^opskat:mfa:allow:apr_mfa_/);
    expect(mfaSubmit?.name).not.toContain("undefined");

    hob.faux.setResponses([text("任务已验证完成")]);
    await answerCard(hob.runtime, mfaFromGetTask.id, {
      action: { tag: "button", name: mfaSubmit.name },
      form_value: { mfa_0: "654321" },
      button_text: "提交验证",
    });
    await hob.runtime.router.waitIdle("hob");
    expect(JSON.stringify(hob.runtime.store.card(mfaFromGetTask.id)!.card)).toContain("已验证 · 执行完成");

    // 2. cp local_tool card + ALLOW_LOCAL_DIRS passthrough
    hob.faux.setResponses([call("opskat_cp", { src: "web-01:/etc/hosts", dst: "/tmp/safe/hosts" })]);
    await hob.runtime.router.send("hob", { text: "下载 hosts" });
    await hob.runtime.router.waitIdle("hob");
    const cpCard = hob.runtime.store.cards().at(-1)!;
    expect(cpCard.card.header?.title).toContain("本机文件写入审批");
    expect(JSON.stringify(cpCard.card)).toContain("/tmp/safe/hosts");
    const allowCp = findButton(cpCard.card, "本次允许");
    hob.faux.setResponses([text("下载完成")]);
    await answerCard(hob.runtime, cpCard.id, {
      action: { tag: "button", name: allowCp.name },
      button_text: "本次允许",
    });
    await hob.runtime.router.waitIdle("hob");
    expect(readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8")).toContain("cp local write ok (dirs=/tmp/safe,/var/tmp)");

    // 3. Single-line grant card: output must NOT be redacted to ***
    hob.faux.setResponses([call("opskat_request_permission", { items: "[]", reason: "status check" })]);
    await hob.runtime.router.send("hob", { text: "申请单条权限" });
    await hob.runtime.router.waitIdle("hob");
    const grantCard = hob.runtime.store.cards().at(-1)!;
    const approveGrant = findButton(grantCard.card, "批准授权");

    hob.faux.setResponses([text("单条权限已批")]);
    await answerCard(hob.runtime, grantCard.id, {
      action: { tag: "button", name: approveGrant.name },
      form_value: { grant_0: "systemctl status nginx" },
      button_text: "批准授权",
    });
    await hob.runtime.router.waitIdle("hob");
    expect(readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8")).toContain("grant approved: systemctl status nginx");

    // 4. batch_exec card
    hob.faux.setResponses([call("opskat_batch_exec", { commands: "[]" })]);
    await hob.runtime.router.send("hob", { text: "批量执行" });
    await hob.runtime.router.waitIdle("hob");
    const batchCard = hob.runtime.store.cards().at(-1)!;
    const allowBatch = findButton(batchCard.card, "全部允许");
    expect(allowBatch).toBeTruthy();

    hob.faux.setResponses([text("批量完成")]);
    await answerCard(hob.runtime, batchCard.id, {
      action: { tag: "button", name: allowBatch.name },
      button_text: "全部允许",
    });
    await hob.runtime.router.waitIdle("hob");
    expect(JSON.stringify(hob.runtime.store.card(batchCard.id)!.card)).toContain("已允许 · 执行完成");
  });

  it("surfaces OpsKat approval card from background job and resumes job after user clicks", async () => {
    const hob = await setupOpskatHob();
    const job = await hob.runtime.jobs.start("hob", { title: "后台重启 nginx", instruction: "执行重启" });

    hob.faux.setResponses([
      call("opskat_exec", { asset: "1", command: "systemctl restart nginx" }),
      call("report", { outcome: "done", result: "后台任务已通过审批卡片执行完成" }),
      text("后台任务已完成"),
    ]);

    let card: any;
    for (let i = 0; i < 60; i++) {
      card = hob.runtime.store.cards().find((c) => c.owner.type === "plugin" && c.owner.jobId === job.id);
      if (card) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(card).toBeTruthy();
    expect(hob.runtime.store.job(job.id)?.status).toBe("waiting");

    const allowBtn = findButton(card.card, "本次允许");
    const resp = await answerCard(hob.runtime, card.id, {
      action: { tag: "button", name: allowBtn.name },
      button_text: "本次允许",
    });
    expect(resp.status).toBe(200);

    for (let i = 0; i < 60; i++) {
      if (hob.runtime.store.job(job.id)?.status === "done") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(hob.runtime.store.job(job.id)?.status).toBe("done");
    expect(hob.runtime.store.job(job.id)?.summary).toContain("后台任务已通过审批卡片执行完成");
  });
});
