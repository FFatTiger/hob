import { homedir } from "node:os";
import type { GeneralSettings, MemoryProvider, ThinkingLevel } from "../../shared/types.ts";
import type { Store } from "./store.ts";
import { cronToChinese } from "./cron-text.ts";
import { memoryPromptLines } from "./memory.ts";

export interface PromptModel {
  name: string;
  ref: string;
  note: string;
  thinking: ThinkingLevel;
  levels?: ThinkingLevel[];
  isDefault: boolean;
}

export interface Abilities {
  exec: boolean;
  write: boolean;
  image: boolean;
}

export interface PromptSettings {
  timezone: string;
  aboutYou: GeneralSettings["aboutYou"];
  memory: MemoryProvider;
  models?: PromptModel[];
  skills?: { name: string; description: string }[];
  assistantSkills?: { name: string; title: string; description: string; version: number; updatedAt: string }[];
  assistantSkillsDir?: string;
  knowledgeNames?: string[];
  thinkingChoice?: "auto" | "fixed";
  abilities?: Abilities;
}

function aboutSection(aboutYou: GeneralSettings["aboutYou"]): string[] {
  const lines: string[] = [];
  if (aboutYou.name) lines.push(`- 称呼：${aboutYou.name}`);
  if (aboutYou.language) lines.push(`- 语言：${aboutYou.language}`);
  if (aboutYou.notes) lines.push(`- 其他：${aboutYou.notes}`);
  return lines.length ? ["", "## 用户", ...lines] : [];
}

export function buildSystemPrompt(store: Store, assistantId: string, settings: PromptSettings): string {
  const assistant = store.assistant(assistantId);
  if (!assistant) throw new Error(`助手不存在：${assistantId}`);
  const rules = store.rules(assistantId);
  const routines = store.routines().filter((routine) => routine.assistantId === assistantId);
  const others = store.assistants().filter((item) => item.id !== assistantId && !item.hidden);
  const lines = assistant.primary ? [
    `你是「${assistant.name}」，用户的主助手。`,
    "你和用户在一对一的对话里合作，用户的每条消息都是对你说的。",
  ] : [
    `你是「${assistant.name}」，用户的助手，负责${assistant.duty}。`,
    ...(assistant.dutyLong?.trim() ? [`详细职责：${assistant.dutyLong.trim()}`] : []),
    "你和用户在一对一的对话里合作。主助手 Hob 会把归你管的事转给你：转来的消息带着用户的原话，等同用户本人的要求，结果会自动回到 Hob。",
  ];
  lines.push(
    "用简洁、规范的书面中文回复，先给结论。",
    "", "## 你手里有什么",
    "你能直接看：文件和图片、任务的过程和结果、产出、网页、记忆。",
    "跑命令、改文件、操作设备这些动手的事交给后台任务。任务是你手上的活，在自己的会话和目录里做，做完把完整结果交给你；对用户负责的是你。",
    "任务做完还能接着做，补充和纠正交给原来那个任务，它接得上之前的上下文。",
  );
  if (settings.assistantSkills?.length) {
    lines.push(`你的技能是做同类事的做法，派活时可以让任务照着做。文件在 ${settings.assistantSkillsDir}/<名字>/SKILL.md：`);
    const format = new Intl.DateTimeFormat("sv-SE", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    for (const skill of settings.assistantSkills) lines.push(`- ${skill.name}「${skill.title}」· 第 ${skill.version} 版 · ${format.format(new Date(skill.updatedAt)).slice(5)} 更新：${skill.description}`);
  }
  if (settings.knowledgeNames?.length) lines.push(`能查的知识库：${settings.knowledgeNames.join("、")}。问到可能写在这些库里的内容，先用 search_knowledge 查。`);
  if (settings.skills?.length) lines.push(`任务能用的技能：${settings.skills.map((skill) => skill.name).join("、")}`);
  lines.push(...aboutSection(settings.aboutYou));
  if (rules.length) {
    lines.push("", "## 用户定的规则");
    for (const rule of rules) lines.push(`- ${rule.mode === "ask" ? "执行前确认" : "直接执行"}：${rule.text}`);
  }
  if (assistant.instructions.trim()) lines.push("", "## 补充说明", assistant.instructions.trim());
  const memory = memoryPromptLines(settings.memory);
  if (memory.length) lines.push("", ...memory);
  if (routines.length) {
    lines.push("", "## 定时");
    for (const routine of routines) {
      const when = routine.schedules.map(cronToChinese).join("、");
      lines.push(`- ${routine.name} · ${when}${routine.active ? "" : "（暂停）"}：${routine.instruction}`);
    }
  }
  if (assistant.primary && others.length) {
    lines.push("", "## 其他助手");
    for (const other of others) lines.push(`- ${other.name}（${other.id}）：${other.duty}。${other.dutyLong?.trim() ?? ""}`);
  }
  return lines.join("\n");
}

export function buildWorkerPrompt(store: Store, jobId: string, settings: PromptSettings): string {
  const job = store.job(jobId);
  if (!job) throw new Error(`任务不存在：${jobId}`);
  const assistant = store.assistant(job.assistantId);
  const name = assistant?.name ?? job.assistantId;
  const askFirst = store.rules(job.assistantId).filter((rule) => rule.mode === "ask");
  const lines = [
    `你是「${name}」助手派出的后台任务，在自己的会话里把交给你的事做完。`,
    `工作目录：${job.cwd ?? homedir()}。产出放在这里；读取不限目录。`,
    `交给你的消息里有用户的原话、最近的对话、附件和「${name}」的备注。`,
    `做完调用 report：result 写完整结果，包括结论、数据、链接和文件路径。它会交给「${name}」，由它告诉用户。`,
    "之后用户可能还会找你补充、纠正或追问，这些都会发到这个会话里；接着做完，再调用 report。",
  ];
  if (settings.knowledgeNames?.length) lines.push(`能查的知识库：${settings.knowledgeNames.join("、")}。问到可能写在这些库里的内容，先用 search_knowledge 查。`);
  if (settings.abilities) {
    const cannot = [
      ...(!settings.abilities.exec ? ["执行命令（bash）"] : []),
      ...(!settings.abilities.write ? ["改文件（edit、write）"] : []),
      ...(!settings.abilities.image ? ["生图（generate_image）"] : []),
    ];
    if (cannot.length) lines.push(`不能做：${cannot.join("、")}。`);
  }
  lines.push(...aboutSection(settings.aboutYou));
  if (askFirst.length) {
    lines.push("", "## 这些事执行前用 ask_user 问用户");
    for (const rule of askFirst) lines.push(`- ${rule.text}`);
  }
  if (assistant?.instructions.trim()) lines.push("", "## 补充说明", assistant.instructions.trim());
  const memory = memoryPromptLines(settings.memory);
  if (memory.length) lines.push("", ...memory);
  return lines.join("\n");
}
