import { homedir } from "node:os";
import { PROP_IDS, PROPS } from "../../shared/sprites.ts";
import type { GeneralSettings, MemoryProvider, ThinkingLevel } from "../../shared/types.ts";
import type { Store } from "./store.ts";
import { cronToChinese } from "./cron-text.ts";
import { memoryPromptLines } from "./memory.ts";
import { nowText } from "./time.ts";

/** 提示词里列的模型：助手能派其中一个。 */
export interface PromptModel {
  name: string;
  ref: string;
  note: string; // 用途说明
  thinking: ThinkingLevel; // 默认思考档
  levels?: ThinkingLevel[]; // 模型可用的思考档
  isDefault: boolean; // 不指定模型时用它
}

/** 派出去的活能做什么（助手设置 → 能力）。 */
export interface Abilities {
  exec: boolean;
  write: boolean;
  image: boolean;
}

/** 提示词里要用的设置：时区、「关于你」、记忆提供者、模型、能力。 */
export interface PromptSettings {
  timezone: string;
  aboutYou: GeneralSettings["aboutYou"];
  memory: MemoryProvider;
  /** 这个助手能派的模型（Router 用） */
  models?: PromptModel[];
  skills?: { name: string; description: string }[];
  thinkingChoice?: "auto" | "fixed";
  /** 任务能做什么（Worker 用） */
  abilities?: Abilities;
}

/** 「关于你」一节：三行里有哪行填了才出哪行，全空就整节不出。 */
function aboutLines(aboutYou: GeneralSettings["aboutYou"]): string[] {
  const lines: string[] = [];
  if (aboutYou.name) lines.push(`- 称呼：${aboutYou.name}`);
  if (aboutYou.language) lines.push(`- 语言：${aboutYou.language}`);
  if (aboutYou.notes) lines.push(`- 其他：${aboutYou.notes}`);
  return lines;
}

function aboutSection(aboutYou: GeneralSettings["aboutYou"]): string[] {
  const lines = aboutLines(aboutYou);
  return lines.length ? ["", "## 关于用户", ...lines] : [];
}

/** 「可以派的模型」：只有一个时整节只一行。 */
function modelsSection(models: PromptModel[], fixed: boolean): string[] {
  if (!models.length) return [];
  const lines = ["", "## 可以派的模型", "聪明、成本、速度都是 0–100：越高越聪明、越贵、越快。按任务难度、可接受的花费和要多快来挑；简单的活别派给又贵又慢的模型。"];
  if (fixed) {
    for (const model of models) {
      lines.push(`- ${model.ref}${model.isDefault ? "（默认）" : ""}${model.note ? ` · ${model.note}` : ""} · 思考档 ${model.thinking}`);
    }
    if (models.length > 1) lines.push("按任务难度和类型选择：start_job 的 model 填括号里的 ref；不确定就不填，使用默认值。");
    return lines;
  }
  if (models.length === 1) {
    const only = models[0];
    lines.push(
      `- ${only.ref}${only.isDefault ? "（默认）" : ""}${only.note ? ` · ${only.note}` : ""} · 思考档默认 ${only.thinking}，可选 ${(only.levels ?? [only.thinking]).join("、")}：start_job 不用填 model，需要更强推理时填 thinking。`,
    );
    return lines;
  }
  for (const model of models) {
    lines.push(
      `- ${model.ref}${model.isDefault ? "（默认）" : ""}${model.note ? ` · ${model.note}` : ""} · 思考档默认 ${model.thinking}，可选 ${(model.levels ?? [model.thinking]).join("、")}`,
    );
  }
  lines.push("按任务难度和类型选择：start_job 的 model 填括号里的 ref，thinking 按需要填；不确定就不填，使用默认值。");
  return lines;
}

/** 「你能做什么」：把助手开关关掉的能力明确写成不能做。 */
function abilitiesSection(abilities: Abilities): string[] {
  const can: string[] = ["读文件（read、grep、find、ls）"];
  const cannot: string[] = [];
  (abilities.exec ? can : cannot).push("执行命令（bash）");
  (abilities.write ? can : cannot).push("改文件（edit、write）");
  (abilities.image ? can : cannot).push("生图（generate_image）");
  const lines = ["", "## 你能做什么", `- 能做：${can.join("、")}`];
  if (cannot.length) {
    lines.push(`- 不能做：${cannot.join("、")}。确需该能力时用 report(stuck) 说明缺少什么，不要勉强完成。`);
  }
  return lines;
}

/** Router 的系统提示词：每轮现读 store，所以改了规矩/补充说明下一轮就生效。 */
export function buildSystemPrompt(store: Store, assistantId: string, settings: PromptSettings): string {
  const assistant = store.assistant(assistantId);
  if (!assistant) throw new Error(`助手不存在：${assistantId}`);
  const rules = store.rules(assistantId);
  const routines = store.routines().filter((routine) => routine.assistantId === assistantId);
  const others = store.assistants().filter((item) => item.id !== assistantId && !item.hidden);

  const lines: string[] = [
    `你是「${assistant.name}」，用户的${assistant.primary ? "主助手" : "助手"}。`,
    `职责：${assistant.duty}`,
    ...(assistant.dutyLong?.trim() ? [`详细职责：${assistant.dutyLong.trim()}`] : []),
    `现在时间：${nowText(settings.timezone)}`,
  ];

  lines.push(...aboutSection(settings.aboutYou));
  lines.push(...modelsSection(settings.models ?? [], settings.thinkingChoice === "fixed"));
  if (settings.skills?.length) {
    lines.push("", "## 任务可用的技能", ...settings.skills.map((skill) => `- ${skill.name}：${skill.description}`));
  }

  if (rules.length) {
    lines.push("", "## 你的规则");
    for (const rule of rules) lines.push(`- ${rule.mode === "ask" ? "执行前确认" : "直接执行"}：${rule.text}`);
  }
  if (assistant.instructions.trim()) {
    lines.push("", "## 补充说明", assistant.instructions.trim());
  }
  const memory = memoryPromptLines(settings.memory);
  if (memory.length) lines.push("", ...memory);
  if (routines.length) {
    lines.push("", "## 你的定时");
    for (const routine of routines) {
      const when = routine.schedules.map(cronToChinese).join("、");
      lines.push(`- ${routine.name} · ${when}${routine.active ? "" : "（暂停）"}：${routine.instruction}`);
    }
  }
  if (assistant.primary && others.length) {
    lines.push("", "## 其他助手");
    for (const other of others) {
      const ask = store.rules(other.id).filter((rule) => rule.mode === "ask").map((rule) => rule.text);
      lines.push(`- ${other.name}（${other.id}）：${other.duty}${other.dutyLong?.trim() ? `。详细职责：${other.dutyLong.trim()}` : ""}${ask.length ? `。执行前要确认：${ask.join("；")}` : ""}`);
    }
    lines.push("转交前先对照详细职责挑最合适的助手；没有合适的就自己派任务，或者提议创建新助手。");
  }

  if (!assistant.primary) {
    lines.push("", "## 转来的事", "带「转自 Hob」的消息是主助手替用户转来的，等同于用户本人的要求：照着去做，需要执行就直接 start_job，不要只回复计划；做完不用另外给 Hob 发消息，结果会自动回到 Hob。", "", "## 不归你管的事", "主助手 Hob 负责在各助手之间分派。用户的要求明显超出你的职责时，调用 hand_back_to_hob 交回 Hob，不要硬做；在你职责内的事照常自己做。");
  }

  lines.push(
    "",
    "## 工作方式",
    "- 说要做的事，就在同一条消息里调用对应工具去做；不要只描述计划然后停下等用户催。只有规则要求确认或操作不可逆时才停下来问。",
    "- 用简洁、规范的书面中文回复，直接给出结论，不要复述步骤、不要罗列清单。",
    "- 你不能亲自执行任何操作：没有 bash、read、edit、write 这些工具（联网搜索除外）。需要执行任务时调用 start_job 交给后台任务，任务完成后会有事件回到这里。",
    "- 需要最新信息或核对事实时，直接用 web_search / web_fetch 查，不必为此派任务；要多步调研、写文件或跑命令时再用 start_job。",
    "- 任务本身就是带完整工具的编码 agent：写代码、改项目、查文件都是普通任务，用 start_job 的 cwd 指定任务的工作目录。",
    "- 只有规则标为「执行前确认」，或者操作不可逆（发送、删除、付费）时，才用 ask_user 请用户确认。",
    "- 会产生卡片的工具（start_job、ask_user、propose_assistant）：先在同一条消息里写一句话（要做什么、等用户确认什么），再调用工具。这些工具会返回“本轮到此结束”：卡片已经出现在对话里，内容齐全，调用完立即结束这一轮，不要再补任何文字（“草稿卡在上面了”“点创建就成”这类话都是重复的废话）。",
    "- 用 ask_user 时，如果同类操作以后很可能还会遇到（日常的常规操作；发布、删除、付费这类不可逆的事除外），第三个选项写“以后同类操作直接执行，无需确认”（always），并填一句很短的 ruleText，如“清理临时目录”。",
    "- 用户说“以后”“别再”这类要求时，用 set_rule 记入规则，不要只做口头承诺。",
    ...(assistant.primary
      ? [
          "- 用户要早报、日报，或者问“昨晚/今天都做了什么”时，先调 overview 看各助手这段时间的日志和任务，再照实写一两句汇总，不要凭印象编造。",
        ]
      : []),
  );

  if (assistant.primary) {
    lines.push(
      "- 同类任务在对话中反复出现（同一件事被要求 3 次以上），就用 propose_assistant 提议创建专属助手。",
      "- propose_assistant 的 duty 是左栏头像下面那行小字：最多 8 个字，如「线上和机器」「模型和 agent」；更详细的职责写在 dutyLong（草稿卡里的「职责」行）。",
      `- propose_assistant 的 sprite 按职责选：${PROP_IDS.filter((id) => id !== "hob")
        .map((id) => `${id} ${PROPS[id].label}`)
        .join("，")}；hob 那个火苗是主助手专用的，不要用。`,
      "- 库里没有贴合职责的道具时，可以自己画一件：sprite 填 custom，prop_art 给出 art、pal、dx 画一件 16×16 的像素道具；画得不合适会返回原因，照着改好重发就行。",
      "- 有更合适的助手时用 message_assistant 把任务转过去。",
    );
  }
  lines.push("- 用户问你在做什么、有什么在运行，可依据任务事件回答，不要编造进度。");
  lines.push(
    "- 最后重申：start_job、ask_user、propose_assistant 返回“本轮到此结束”后，你说的下一个字都是多余的，直接结束回合。",
  );
  return lines.join("\n");
}

/** Worker 的系统提示词：所属助手、要问的事、补充说明、任务说明、必须 report 收尾。 */
export function buildWorkerPrompt(store: Store, jobId: string, settings: PromptSettings): string {
  const job = store.job(jobId);
  if (!job) throw new Error(`任务不存在：${jobId}`);
  const assistant = store.assistant(job.assistantId);
  const askFirst = store.rules(job.assistantId).filter((rule) => rule.mode === "ask");
  const lines: string[] = [
    `你在后台执行「${assistant?.name ?? job.assistantId}」的任务。`,
    `职责：${assistant?.duty ?? ""}`,
    `现在时间：${nowText(settings.timezone)}`,
  ];
  lines.push(...aboutSection(settings.aboutYou));
  if (settings.abilities) lines.push(...abilitiesSection(settings.abilities));
  if (askFirst.length) {
    lines.push("", "## 这些事执行前必须用 ask_user 询问用户");
    for (const rule of askFirst) lines.push(`- ${rule.text}`);
  }
  if (assistant?.instructions.trim()) {
    lines.push("", "## 补充说明", assistant.instructions.trim());
  }
  const memory = memoryPromptLines(settings.memory);
  if (memory.length) lines.push("", ...memory);
  if (assistant?.primary) {
    lines.push(
      "",
      "## 早报",
      "- 用户要早报、日报或汇总“昨晚/今天都做了什么”时，先调 overview(sinceHours) 拿各助手这段时间的日志和任务，再照实写汇总。",
    );
  }
  lines.push(
    "",
    `## 任务：${job.title}`,
    job.instruction,
    ...(job.inputs?.length ? ["", "## 你收到的文件", ...job.inputs.map((file) => `- ${file}`)] : []),
    "",
    `工作目录：${job.cwd ?? homedir()}`,
    "",
    "## 要求",
    "- 产出文件只写在工作目录里：新建的文件、下载的内容、导出的结果都放在这个目录，不要写到用户主目录或其他位置。",
    "- 读取不受目录限制：可读取任何位置的文件作参考，只是不要写入这些位置。",
    "- 要给用户看的文件放进 report 的 files（绝对路径，文件本身在工作目录里）。",
    "- 完成后必须调用 report 提交结果（outcome：已完成 / 受阻 / 待确认），不调用视为未完成。",
    "- summary 用中文写给用户：一两句结论 + 关键数字，不要罗列过程。",
    "- 受阻时调用 report(stuck) 说明受阻原因；要做不该做的、无法撤回的事就调用 ask_user。",
  );
  return lines.join("\n");
}
