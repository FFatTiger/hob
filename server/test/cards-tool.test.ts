import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CardActionRequest } from "../../shared/types.ts";
import { answerCard } from "../src/actions.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob, text } from "./helpers.ts";

const displayMarkdown = `# 供应商报价

| 供应商 |
| --- |
| 甲方 |`;

const interactiveMarkdown = `# 出行偏好

:::form{name=trip}
::input[天数]{name=days required}
::button[按这个排]{submit}
:::`;

const EXPECTED_SEND_CARD_DESCRIPTION = `**说明**：在对话里发一张卡片，用于放让用户填写、选择或点按钮的交互组件，或放气泡里排不好的简单展示内容（一张表、几个并排的数字、一个短清单）。卡片里有能操作的东西时，这一轮在这里结束，用户操作完，结果会作为系统消息回到对话；只有展示内容的卡片不结束这一轮。你发的卡片不能有密码框：密码、密钥这类值要用插件的卡片收，不经过你。

**参数**
- \`markdown\`：卡片内容。普通的 Markdown 照常写（小标题、列表、表格、代码块、链接），另外有这些写法：
  - 卡片标题：第一行写 \`# 标题\`；紧跟着的一行普通文字是副标题，可以不写。
  - 单独一行 \`---\` 是分割线；单独一行 \`![说明](https://…)\` 是图片。
  - 分栏：单独一行 \`::: columns\` 开始，单独一行 \`:::\` 结束，栏和栏之间单独一行 \`+++\`。手机上会竖着排。各栏宽度不一样时写 \`::: columns{weights="2 1"}\`。
  - 折叠：\`<details><summary>标题</summary>\` 开始，\`</details>\` 结束，中间是默认收起的内容；写成 \`<details open>\` 默认展开。
  - 能操作的组件一行一个，写成 \`::组件[文字]{属性}\`，属性之间用空格隔开，带空格的值加引号：
    - \`::input[标签]{name=… placeholder="…" default="…" required}\`：输入框，一行字。加 \`type=multiline\` 是一段话，\`type=number\` 是数字，可以加 \`min=\`、\`max=\`。
    - \`::select[标签]{name=… options="选项1|选项2|选项3" default="选项1" required}\`：单选。\`::multiselect\` 是多选，\`default\` 里几个默认选中的也用 \`|\` 隔开。
    - \`::date[标签]{name=… required}\`、\`::time[标签]{…}\`、\`::datetime[标签]{…}\`：日期、时间、日期和时间。
    - \`::checkbox[文字]{name=… checked}\`：开关，写 \`checked\` 默认打开。
    - \`::button[文字]{primary}\`：按钮，\`primary\` 是主按钮，\`danger\` 是危险操作。写 \`url=https://…\` 是打开网址；在表单里写 \`submit\` 是提交表单；其余的点了就算一次操作。
  - 表单：单独一行 \`:::form{name=…}\` 开始，单独一行 \`:::\` 结束，里面的输入在点 \`submit\` 按钮时一起交回。表单里的每个输入都要有不重复的 \`name\`。`;

function tool(hob: ReturnType<typeof makeHob>, groupId?: string) {
  return buildRouterTools(hob.runtime, "hob", groupId ? { groupId } : undefined).find((entry) => entry.name === "send_card")!;
}

describe("send_card", () => {
  it("accepts markdown parameter only and matches issue 264 copy verbatim", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const sendCard = tool(hob);
      expect(Object.keys(sendCard.parameters.properties)).toEqual(["markdown"]);
      expect(sendCard.parameters.properties.markdown.description).toBe("卡片内容，Markdown");
      expect(sendCard.description).toBe(EXPECTED_SEND_CARD_DESCRIPTION);

      const prompt = buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai",
        aboutYou: { name: "", language: "", notes: "" },
        memory: "off",
      });
      expect(prompt).toContain(
        "标题、嵌套的列表、成片的加粗和代码格式是文档的写法，放进气泡里读起来像在翻报告。聊天页面保持简洁是很重要的事：卡片占对话里一大块屏幕，内容一多用户就得在聊天里翻文档，而多数结论本来几句话就能说清。所以做完事的汇报、结论、分析和解释，通常在气泡里先说结论、几句话回复；内容多到需要完整材料时，写成文件用 send_file 交付，气泡里交代结论。send_card 用来做文字做不了的交互（让用户选、填、确认、点按钮），也适合替代气泡里容易乱掉的简单展示排版——像一张小表、几个并排的数字、一个短清单。大段分析和长报告不适合往卡片里塞，内容是不是简单到扫一眼就能看清，由你判断。发了卡片，卡片本身就是这次的回复，里面的内容用户已经看到；如果外面再总结结论、复述要点，或者写一句「已发在上面卡片里」，用户要多读一遍，两处有出入时也不知道信哪边。卡片之外只写卡片里没有、又需要现在告诉用户的话（比如顺带回答的另一个问题、或需要用户拍板/接下来要办的事）；没有这样的话就不写，直接结束这一轮。",
      );
      expect(prompt).toContain(
        "send_card 用来做文字做不了的交互（让用户选、填、确认、点按钮），也用来替代 Markdown 做简单的展示排版（一张表、几个并排的数字、一个短清单），让气泡里保持好读。发了卡片就是这次的回复，外面不重复卡片里有的内容，没有别的话就直接结束这一轮。做完事的汇报、结论、分析和解释通常在气泡里几句话回复；需要交付完整材料时，写成文件用 send_file 发送，气泡里说清结论。",
      );
    } finally { hob.close(); }
  });

  it("shows display cards without ending the turn and interactive cards with terminate", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const shown = await tool(hob).execute("call", { markdown: displayMarkdown }) as { content: { text: string }[]; terminate?: boolean };
      expect(shown).toMatchObject({ content: [{ text: "卡片已显示给用户，里面的内容用户已经看到。" }] });
      expect(shown.terminate).toBeUndefined();
      const sent = await tool(hob).execute("call-2", { markdown: interactiveMarkdown }) as { content: { text: string }[]; terminate?: boolean };
      expect(sent).toMatchObject({ content: [{ text: "卡片已显示给用户，用户操作完结果会回到对话。" }], terminate: true });
      expect(hob.runtime.store.cards()).toHaveLength(2);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "card")).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("sends cards with auto-fixed warnings and appends 注意 to the reply", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const displayWarn = await tool(hob).execute("call-warn-display", {
        markdown: "::: columns\n左栏\n+++\n\n+++\n右栏",
      }) as { content: { text: string }[]; terminate?: boolean; isError?: boolean };
      expect(displayWarn.isError).toBeUndefined();
      expect(displayWarn.terminate).toBeUndefined();
      expect(displayWarn.content[0]!.text).toContain("卡片已显示给用户，里面的内容用户已经看到。注意：");
      expect(displayWarn.content[0]!.text).toContain("分栏没有用 ::: 闭合");
      expect(displayWarn.content[0]!.text).toContain("分栏里有空栏");

      const formWarn = await tool(hob).execute("call-warn-form", {
        markdown: ":::form\n::input[姓名]\n:::",
      }) as { content: { text: string }[]; terminate?: boolean; isError?: boolean };
      expect(formWarn.isError).toBeUndefined();
      expect(formWarn.terminate).toBe(true);
      expect(formWarn.content[0]!.text).toContain("卡片已显示给用户，用户操作完结果会回到对话。注意：");
      expect(formWarn.content[0]!.text).toContain("表单没写 name");
      expect(formWarn.content[0]!.text).toContain("表单里没有 submit 按钮");
      expect(hob.runtime.store.cards()).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("rejects translation errors, validation failures, and assistant password fields without sending", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const unknown = await tool(hob).execute("call-unknown", { markdown: "::number[人数]{name=people}" }) as { content: { text: string }[]; isError?: boolean };
      expect(unknown).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("::input[…]{type=number}") }],
      });

      const missingOptions = await tool(hob).execute("call-select", { markdown: "::select[时长]{name=len}" }) as { content: { text: string }[]; isError?: boolean };
      expect(missingOptions).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('写成 options="选项1|选项2"') }],
      });

      const badRange = await tool(hob).execute("call-range", { markdown: "::input[人数]{name=people type=number min=10 max=5}" }) as { content: { text: string }[]; isError?: boolean };
      expect(badRange).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("min 不能大于 max") }],
      });

      const password = await tool(hob).execute("call-pwd", { markdown: "::input[密码]{name=pwd type=password}" }) as { content: { text: string }[]; isError?: boolean };
      expect(password).toMatchObject({
        isError: true,
        content: [{ text: "你发的卡片不能有 input_type 为 password 的输入框：密码这类值要交给插件的卡片，不经过你。" }],
      });

      const empty = await tool(hob).execute("call-empty", { markdown: "   " }) as { content: { text: string }[]; isError?: boolean };
      expect(empty).toMatchObject({ isError: true, content: [{ text: "卡片内容不能为空。" }] });

      expect(hob.runtime.store.cards()).toEqual([]);
    } finally { hob.close(); }
  });

  it("does not prepend old card history to later user messages", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await tool(hob).execute("call", { markdown: interactiveMarkdown });
      hob.faux.setResponses([text("收到。")]);
      await hob.runtime.router.send("hob", { text: "继续处理" });
      await hob.runtime.router.waitIdle("hob");
      const entries = readFileSync(hob.runtime.store.routerFile("hob"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const prompts = entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").map((entry) => JSON.stringify(entry.message.content));
      expect(prompts.at(-1)).toContain("继续处理");
      expect(prompts.at(-1)).not.toContain("卡片「出行偏好」");
    } finally { hob.close(); }
  });

  it("locks an assistant card and sends the exact event message back", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await tool(hob).execute("call", { markdown: interactiveMarkdown });
      const record = hob.runtime.store.cards()[0]!;
      hob.faux.setResponses([text("收到偏好，我开始排了。")]);
      const request: CardActionRequest = { action: { tag: "button" }, button_text: "按这个排", form_value: { days: "3" } };
      const response = await answerCard(hob.runtime, record.id, request);
      expect(response.status).toBe(200);
      expect(hob.runtime.store.card(record.id)).toMatchObject({ status: "done", result: { buttonText: "按这个排", fields: { days: "3" } } });
      await hob.runtime.router.waitIdle("hob");
      const transcript = readFileSync(hob.runtime.store.routerFile("hob"), "utf8");
      expect(transcript).toContain("[hob-event] 用户在卡片「出行偏好」上点了「按这个排」，填写的内容：");
      expect(transcript).toContain("- 天数：3");
    } finally { hob.close(); }
  });
});
