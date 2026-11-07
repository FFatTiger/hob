// 助手资料的修改：HTTP 的 PATCH /api/assistants/:id 和 Router 的 update_assistant 工具共用这一份校验与保存，
// 免得两边规则跑偏。工具改之前会把旧档案留一份备份（assistants/<id>/backups/），HTTP 改不备份——界面上每敲一下
// 失焦都会调它，备份会把目录塞满。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assistant } from "../../shared/types.ts";
import { parseSprite } from "../../shared/sprites.ts";
import { assistantDir } from "./config.ts";
import { newId } from "./ids.ts";
import { checkAssistantModels } from "./models.ts";
import type { HobRuntime } from "./runtime.ts";
import { clampDuty } from "./text.ts";

export type AssistantPatch = Partial<Assistant> & { rule?: { id?: unknown; text?: unknown; mode?: unknown } };

export interface UpdateAssistantOptions {
  /** 改之前把旧档案写进 assistants/<id>/backups/，工具用；界面的逐字段保存不用。 */
  backup?: boolean;
}

export type UpdateAssistantResult =
  | {
      ok: true;
      /** 直接回给客户端的 JSON（保持 PATCH 原来的形状） */
      body: Record<string, unknown>;
      previous: Assistant;
      /** 改后的档案；只改了规则时没有 */
      next?: Assistant;
      /** 变了哪些字段，用界面上的叫法 */
      changed: string[];
      backupPath?: string;
    }
  | { ok: false; status: 400 | 404; error: string };

const FIELDS: { key: keyof Assistant; label: string }[] = [
  { key: "name", label: "名字" },
  { key: "duty", label: "职责简介" },
  { key: "dutyLong", label: "详细职责" },
  { key: "instructions", label: "补充说明" },
  { key: "sprite", label: "头像" },
  { key: "pinned", label: "置顶" },
  { key: "hidden", label: "收起" },
  { key: "notify", label: "通知" },
  { key: "models", label: "模型" },
  { key: "abilities", label: "能力" },
  { key: "knowledge", label: "知识库" },
];

/** 旧档案留档：assistants/<id>/backups/profile-<时间>.json，返回文件路径。 */
export function backupAssistantProfile(home: string, assistant: Assistant, at = new Date()): string {
  const dir = join(assistantDir(home, assistant.id), "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  let path = join(dir, `profile-${stamp}.json`);
  // 同一毫秒改两次也不能互相覆盖
  for (let n = 2; existsSync(path); n += 1) path = join(dir, `profile-${stamp}-${n}.json`);
  writeFileSync(path, `${JSON.stringify(assistant, null, 2)}\n`);
  return path;
}

/** 只列出真正变了的字段。 */
export function changedFields(previous: Assistant, next: Assistant): string[] {
  return FIELDS.filter(({ key }) => JSON.stringify(previous[key]) !== JSON.stringify(next[key])).map(({ label }) => label);
}

export async function updateAssistant(
  runtime: HobRuntime,
  id: string,
  body: AssistantPatch,
  options: UpdateAssistantOptions = {},
): Promise<UpdateAssistantResult> {
  const { store, bus, router } = runtime;
  const assistant = store.assistant(id);
  if (!assistant) return { ok: false, status: 404, error: "助手不存在" };

  if (body.rule !== undefined) {
    const edit = body.rule;
    if (!edit || typeof edit !== "object" || (edit.id !== undefined && (typeof edit.id !== "string" || !edit.id))) return { ok: false, status: 400, error: "规则无效。" };
    if ((edit.id === undefined || edit.text !== undefined) && (typeof edit.text !== "string" || !edit.text.trim() || edit.text.trim().length > 1000)) return { ok: false, status: 400, error: "规则内容不能为空或超过 1000 字。" };
    if ((edit.id === undefined || edit.mode !== undefined) && edit.mode !== "ask" && edit.mode !== "allow") return { ok: false, status: 400, error: "规则模式无效。" };
    const rules = store.rules(id);
    const existing = edit.id === undefined ? undefined : rules.find((item) => item.id === edit.id);
    if (edit.id !== undefined && !existing) return { ok: false, status: 404, error: "规则不存在。" };
    const text = typeof edit.text === "string" ? edit.text.trim() : existing!.text;
    if (rules.some((item) => item.id !== edit.id && item.text === text)) return { ok: false, status: 400, error: "规则内容已存在。" };
    const mode = edit.mode === "ask" || edit.mode === "allow" ? edit.mode : existing!.mode;
    const rule = { id: existing?.id ?? newId("r-"), text, mode, changedAt: new Date().toISOString() };
    if (existing) Object.assign(existing, rule);
    else rules.push(rule);
    store.saveRules(id, rules);
    bus.emit({ type: "profile", assistantId: id });
    return { ok: true, body: { ok: true, rule }, previous: assistant, changed: ["规则"] };
  }

  if (body.knowledge !== undefined) {
    if (!Array.isArray(body.knowledge) || body.knowledge.some((id) => typeof id !== "string")) return { ok: false, status: 400, error: "知识库绑定无效。" };
    const collections = (await runtime.knowledge.list()).collections;
    if (body.knowledge.some((id) => !collections.some((item) => item.id === id))) return { ok: false, status: 400, error: "知识库不存在。" };
  }
  if (typeof body.sprite === "string" && body.sprite !== assistant.sprite) {
    const parsed = parseSprite(body.sprite);
    // custom 要有画法数据才收（画法在 prop 字段上，PATCH 不改它）；否则渲染成空手火苗，不如拒绝
    if (!parsed || (parsed.prop === "custom" && !assistant.prop)) return { ok: false, status: 400, error: "头像无效。" };
  }
  let models;
  let abilities;
  try {
    await runtime.models.get();
    ({ models, abilities } = checkAssistantModels(
      { ...(body.models ? { models: body.models } : {}), ...(body.abilities ? { abilities: body.abilities } : {}) },
      runtime.settings.settings.models.roster,
      runtime.models,
    ));
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
  }
  const next: Assistant = {
    ...assistant,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.duty === "string" ? { duty: clampDuty(body.duty) } : {}),
    ...(typeof body.dutyLong === "string" ? { dutyLong: body.dutyLong } : {}),
    ...(typeof body.sprite === "string" ? { sprite: body.sprite } : {}),
    ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
    // 置顶区里的位置：拖动头像换位置后按 0、1、2… 存，取整且不为负
    ...(typeof body.pinOrder === "number" && Number.isFinite(body.pinOrder) ? { pinOrder: Math.max(0, Math.round(body.pinOrder)) } : {}),
    ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
    ...(typeof body.notify === "boolean" ? { notify: body.notify } : {}),
    ...(models ? { models } : {}),
    ...(abilities ? { abilities } : {}),
    ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
    ...(body.knowledge !== undefined ? { knowledge: [...new Set(body.knowledge)] } : {}),
  };
  const changed = changedFields(assistant, next);
  const backupPath = options.backup && changed.length ? backupAssistantProfile(store.home, assistant) : undefined;
  store.saveAssistant(next);
  // 工具说明和注册取决于模型及助手能力，变化后重开会话
  if (models || abilities) router.releaseSessions();
  const summary = router.summary(next);
  bus.emit({ type: "assistant", assistant: summary });
  return { ok: true, body: { assistant: summary }, previous: assistant, next, changed, ...(backupPath ? { backupPath } : {}) };
}
