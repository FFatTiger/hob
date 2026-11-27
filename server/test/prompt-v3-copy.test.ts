import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { assistantJobResultEvent, sedimentMessage } from "../src/jobs.ts";
import { saveAssistantSkill } from "../src/assistant-skills.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { registerAskTool, registerImageTool, registerReportTool } from "../src/worker-tools.ts";
import { DesktopToolSession } from "../src/desktop-tools.ts";
import { makeHob } from "./helpers.ts";

// 定稿只在开发仓库里（.scratch 不随公开版发布），没有就跳过逐字对照
const DOC = ".scratch/v2/design-prompts-v3.md";
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
const section = (start: string, end: string) => doc.split(start)[1]!.split(end)[0]!;
// 定稿里的【…】是给人看的注释（比如群里的写法），不进提示词：对照前按行去掉
const strip = (text: string) => text.split("\n").map((line) => line.replace(/\s*【[^】]*】\s*$/, "")).join("\n");
const line = (text: string, name: string) => text.split("\n").find((item) => item.startsWith(`**${name}**`))!.split("：").slice(1).join("：");

describe.skipIf(!doc)("第三版逐字对照", () => {
  it("助手和任务的固定段落与定稿完全一致", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      store.saveJob({ id: "t", assistantId: "hob", title: "测试", instruction: "", status: "done", createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const options = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const routerSource = section("## 一、助手的系统提示词\n\n```\n", "\n```\n");
      const core = strip(`你的回复显示在聊天气泡里${routerSource.split("你的回复显示在聊天气泡里")[1]!.split("## 技能")[0]}`)
        .trim()
        .replace(
          "放进气泡里读起来像在翻报告。",
          "放进气泡里读起来像在翻报告。聊天页面保持简洁是很重要的事：卡片占对话里一大块屏幕，内容一多用户就得在聊天里翻文档，而多数结论本来几句话就能说清。所以做完事的汇报、结论、分析和解释，通常在气泡里先说结论、几句话回复；内容多到需要完整材料时，写成文件用 send_file 交付，气泡里交代结论。send_card 用来做文字做不了的交互（让用户选、填、确认、点按钮），也适合替代气泡里容易乱掉的简单展示排版——像一张小表、几个并排的数字、一个短清单。大段分析和长报告不适合往卡片里塞，内容是不是简单到扫一眼就能看清，由你判断。发了卡片，卡片本身就是这次的回复，里面的内容用户已经看到；如果外面再总结结论、复述要点，或者写一句「已发在上面卡片里」，用户要多读一遍，两处有出入时也不知道信哪边。卡片之外只写卡片里没有、又需要现在告诉用户的话（比如顺带回答的另一个问题、或需要用户拍板/接下来要办的事）；没有这样的话就不写，直接结束这一轮。\n\n用户的消息可以用 react 点一个表情回应，就像同事在聊天软件里回别人的消息：对方拍板了一个决定、认可了你的做法、道谢、分享了好消息、开了个玩笑，点一个表情就是在说「收到，我懂你的意思」，比打一句客套话轻，也让对话有来有回。拍板的消息常常顺带交代了下一步，点个表情表示收到，再接着把事办了。拿不准时想一想：如果这是两个人在聊天软件里，对方看到这条消息会不会顺手点个表情？会，就点；对方只是在交代一件事、问一个问题，或者正为出了错着急，就用文字把事情办好。表情是回复之外的互动，该说的话照常用文字说；它可以和这一轮要调的其他工具一起调用。",
        )
        .replace(
          "用户说以后某类事直接执行或者需要确认，用 set_rule 记成规则。",
          "用户说以后某类事要怎么做（直接做、先问他，或者照什么要求做），用 set_rule 记成一条规则，照他的原意写成一句话。",
        )
        .replace(
          "你自己能执行命令、读取和修改文件，也能把事情交给后台任务。几步就能做完、现在就清楚每一步怎么做的事，自己做，用户马上能拿到结果；派任务一来一回至少要几十秒。要边做边摸索、步骤多、输出长、要运行很久的事，交给任务：你每做一步都要把整段对话重读一遍，过程也会留在对话里，任务在自己的会话里做，不占你的对话，你还能同时照看好几件事。自己做到一半发现比预想的麻烦，就交给任务，把已经查到的写进交接说明。",
          "你自己能执行命令、读取和修改文件，也能把事情交给后台任务。动手前先估一下这件事大概要几步、要多久：步骤清楚、很快能拿到结果的，自己做，用户立刻就能得到答复；派任务一来一回至少要几十秒。反过来，需要边查边试、反复验证、输出很长或者单次运行就比较久的事，交给后台任务更合适——你在对话里连续做时，用户那边只能干等、看不到中间进展、新消息也插不进来，每多一步你还要重读整段对话、把过程塞满上下文；交给任务后，任务卡上会实时显示它在做什么，用户随时能接着跟你聊别的事，你也能同时照看其他事。要是起初以为很快能办完、做到一半发现还要继续摸索，或者就算摸清了情况、接下来处理和验证还要好几步才能收尾，就把已经查到的情况和路径写进交接说明，转给后台任务接着做。",
        );
      const router = buildSystemPrompt(store, "hob", options);
      expect(router.slice(router.indexOf("你的回复显示在聊天气泡里"), router.indexOf("## 技能")).trim()).toBe(core);
      const workerSource = section("## 二、任务的系统提示词\n\n```\n", "\n```\n");
      // 定稿写的是没指定 cwd 的那句；指定了 cwd 的说法见 prompt.test.ts
      const workerCore = workerSource.split("技能是做某一类事的做法。要做的事对得上哪份")[0]!.trim().replaceAll("{助手}", "Hob").replace("{目录}", homedir());
      expect(buildWorkerPrompt(store, "t", options).startsWith(workerCore)).toBe(true);
      // 任务带着技能时那句，和定稿一字不差
      const taskSkillLine = workerSource.split("\n").find((item) => item.startsWith("技能是做某一类事的做法。要做的事对得上哪份"))!;
      expect(buildWorkerPrompt(store, "t", { ...options, taskSkills: true })).toContain(strip(taskSkillLine).replace("{助手}", "Hob"));
    } finally { hob.close(); }
  });

  it("助手、任务和云桌面的工具说明与定稿逐字一致", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      const assistant = store.assistant("hob")!;
      store.saveAssistant({ ...assistant, id: "other", primary: false });
      hob.runtime.settings.setImage(hob.runtime.settings.get().revision, { source: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "fake" });
      hob.runtime.settings.setSearch(hob.runtime.settings.get().revision, [{ name: "searxng", enabled: true }]);
      const routerSource = section("## 三、助手的工具", "## 四、任务的工具");
      const workerSource = section("## 四、任务的工具", "## 五、沉淀时发给任务的话");
      const router = buildRouterTools(hob.runtime, "hob");
      for (const name of ["check_job", "delete_skill", "read", "start_job", "reply_job", "stop_job", "ask_user", "set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "send_file", "set_avatar", "generate_image", "overview", "create_assistant", "message_assistant", "search_knowledge", "find_knowledge", "web_search", "web_fetch"]) {
        const expected = name === "create_assistant"
          ? "创建一个专属助手，创建后对话里出一张助手卡。"
          : name === "ask_user"
            ? "在对话里出一张提问卡，用户答完，答案会回到对话。问题可以是选择题（2 到 3 个选项），也可以是填空题（一行字、一段话、数字、日期、时间）。"
            : name === "set_rule"
              ? "记下用户定的一条规则。text 写成一行完整的话，照用户的原意写：要怎么做、什么情况下先问他，单独读这一行也明白该怎么做，比如「发布公众号前先问我」「BUG 修好、验证通过后直接合并 PR」。"
              : line(routerSource, name);
        expect(router.find((tool) => tool.name === name)?.description, name).toBe(expected);
      }
      expect(router.find((tool) => tool.name === "show_page")?.description.startsWith(`${line(routerSource, "show_page")}\n`)).toBe(true);
      const secondary = buildRouterTools(hob.runtime, "other");
      expect(secondary.find((tool) => tool.name === "hand_back")?.description).toBe(line(routerSource, "hand_back"));
      const worker = [registerReportTool(hob.runtime, "t"), registerAskTool(hob.runtime, "t"), registerImageTool(hob.runtime, "t")];
      for (const tool of worker) expect(tool.description, tool.name).toBe(line(workerSource, tool.name));
      const outcomeSource = workerSource.split("\n").find((item) => item.startsWith("- `outcome`："))!.split("：").slice(1).join("：");
      expect(worker[0]!.parameters.properties.outcome.description).toBe(outcomeSource);
      const desktop = new DesktopToolSession(hob.runtime, "hob", true, "任务").tools();
      for (const tool of desktop) expect(tool.description, tool.name).toBe(line(workerSource, tool.name));
      for (const tool of [...router, ...secondary, ...worker, ...desktop]) expect(tool.promptSnippet, tool.name).toBeUndefined();
    } finally { hob.close(); }
  });

  it("结果里的沉淀提醒与定稿逐字一致", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = "这个任务没用到技能。可以用 review_job 让它回顾一遍，把能复用的做法沉淀下来，有没有值得沉淀的由它判断。";
      const usedBase = "这个任务用了技能「报告整理」。可以用 review_job 让它回顾一遍，有没有值得沉淀的由它判断：技能里没写到的做法、写错的地方，它会补进对应的那份；是另一类事的做法，它会新建一份。";
      const job = { id: "t-copy", assistantId: "hob", title: "整理报告", instruction: "", status: "done" as const, createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], summary: "好了" };
      hob.runtime.store.saveJob(job);
      expect(assistantJobResultEvent(hob.home, job).split("\n")[2]).toBe(base);
      saveAssistantSkill(hob.home, "hob", { name: "report-guide", title: "报告整理", description: "整理报告", content: "步骤" }, job.id);
      expect(assistantJobResultEvent(hob.home, job).split("\n")[2]).toBe(base);
      // 用到了技能：也提醒，并且写出标题
      const usedJob = { ...job, id: "t-copy-2", skillsUsed: ["report-guide"] };
      hob.runtime.store.saveJob(usedJob);
      expect(assistantJobResultEvent(hob.home, usedJob).split("\n")[2]).toBe(usedBase);
    } finally { hob.close(); }
  });

  it("沉淀时发给任务的话，前四段与定稿逐字一致", () => {
    // 票 154 把第五段起的写法换了，定稿还没替换，这里只对前四段
    const source = section("## 五、沉淀时发给任务的话\n\n```\n", "\n```\n");
    const head = source.split("\n\n").slice(0, 4).join("\n\n");
    const sent = sedimentMessage({ assistantName: "Hob" });
    expect(sent.startsWith(`${head}\n\n`)).toBe(true);
    expect(sent).toContain("存好以后调用 report");
  });
});
