// 话题配置覆盖层：群话题和助手话题共用一套规则合成、配置叠加与恢复跟随逻辑。
import type {
  EffectiveRule,
  GroupReplyMode,
  ModelPick,
  Rule,
  RuleOverrides,
  TopicOverrides,
} from "../../shared/types.ts";
import { newId } from "./ids.ts";

/** 适配器：由群话题或助手话题提供读写上级规则和覆盖层的方法。 */
export interface TopicConfigHost {
  parentRules(): Rule[];
  readOverrides(): TopicOverrides;
  writeOverrides(next: TopicOverrides): void;
  readRuleOverrides(): RuleOverrides;
  writeRuleOverrides(next: RuleOverrides): void;
}

export interface OverridesPatch {
  models?: { conversation?: ModelPick | null; work?: ModelPick | null };
  memberModels?: Record<string, { work?: ModelPick | null } | null>;
  replyMode?: GroupReplyMode | null;
}

const LEGACY_RULE_PREFIX = {
  ask: "执行前确认：",
  allow: "直接执行：",
} as const;

type LegacyRuleMode = keyof typeof LEGACY_RULE_PREFIX;

function isLegacyRuleMode(value: unknown): value is LegacyRuleMode {
  return value === "ask" || value === "allow";
}

function stripLegacyRulePrefix(text: string): string {
  for (const prefix of Object.values(LEGACY_RULE_PREFIX)) {
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return text;
}

/** 旧格式带 mode 的规则就地拼成一行文字；新格式原样保留。 */
export function spliceLegacyRuleText(text: string, mode: unknown): string {
  return isLegacyRuleMode(mode) ? `${LEGACY_RULE_PREFIX[mode]}${text}` : text;
}

export function normalizeRule(raw: unknown): Rule {
  const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawText = typeof entry.text === "string" ? entry.text : "";
  return {
    id: typeof entry.id === "string" ? entry.id : "",
    text: spliceLegacyRuleText(rawText, entry.mode),
    changedAt: typeof entry.changedAt === "string" ? entry.changedAt : "",
  };
}

export function normalizeRules(raw: unknown): Rule[] {
  return Array.isArray(raw) ? raw.map((item) => normalizeRule(item)) : [];
}

/** 读话题规则覆盖层时兼容旧数据的 mode；changed 里只改了 mode 的，用上级原文配上改后的 mode 拼。 */
export function normalizeRuleOverrides(raw: unknown, rawParent: unknown): RuleOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyRuleOverrides();
  const obj = raw as Record<string, unknown>;

  const parentById = new Map<string, { rawText: string; hasLegacyMode: boolean }>();
  if (Array.isArray(rawParent)) {
    for (const item of rawParent) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id === "string" && typeof entry.text === "string") {
        parentById.set(entry.id, { rawText: entry.text, hasLegacyMode: isLegacyRuleMode(entry.mode) });
      }
    }
  }

  const changed: RuleOverrides["changed"] = {};
  if (obj.changed && typeof obj.changed === "object" && !Array.isArray(obj.changed)) {
    for (const [id, value] of Object.entries(obj.changed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const changedAt = typeof entry.changedAt === "string" ? entry.changedAt : "";
      const hasText = typeof entry.text === "string";
      const hasMode = isLegacyRuleMode(entry.mode);
      if (hasText) {
        changed[id] = { text: spliceLegacyRuleText(entry.text as string, entry.mode), changedAt };
      } else if (hasMode) {
        const parent = parentById.get(id);
        if (!parent) continue;
        const baseText = parent.hasLegacyMode ? parent.rawText : stripLegacyRulePrefix(parent.rawText);
        changed[id] = { text: spliceLegacyRuleText(baseText, entry.mode), changedAt };
      }
    }
  }

  return {
    own: normalizeRules(obj.own),
    changed,
    hidden:
      obj.hidden && typeof obj.hidden === "object" && !Array.isArray(obj.hidden)
        ? (obj.hidden as RuleOverrides["hidden"])
        : {},
  };
}

export function emptyRuleOverrides(): RuleOverrides {
  return { own: [], changed: {}, hidden: {} };
}

/** 清理上级已删除的规则在 changed / hidden 里的孤儿记录。 */
function pruneRuleOverrides(parent: Rule[], overrides: RuleOverrides): RuleOverrides {
  const parentIds = new Set(parent.map((rule) => rule.id));
  const changed = Object.fromEntries(Object.entries(overrides.changed).filter(([id]) => parentIds.has(id)));
  const hidden = Object.fromEntries(Object.entries(overrides.hidden).filter(([id]) => parentIds.has(id)));
  return { own: [...overrides.own], changed, hidden };
}

/** 把上级规则与话题覆盖层合成实际生效的规则列表（忽略孤儿条目）。 */
export function effectiveRules(parent: Rule[], overrides: RuleOverrides): EffectiveRule[] {
  const out: EffectiveRule[] = [];
  for (const rule of parent) {
    if (Object.prototype.hasOwnProperty.call(overrides.hidden, rule.id)) continue;
    const changed = Object.prototype.hasOwnProperty.call(overrides.changed, rule.id)
      ? overrides.changed[rule.id]
      : undefined;
    if (changed) {
      out.push({
        id: rule.id,
        text: changed.text,
        changedAt: changed.changedAt,
        from: "parent",
        changed: true,
      });
    } else {
      out.push({ ...rule, from: "parent" });
    }
  }
  for (const rule of overrides.own) {
    out.push({ ...rule, from: "topic" });
  }
  return out;
}

/** 被当前话题停用的上级规则（供配置界面展示与恢复跟随）。 */
export function hiddenRules(parent: Rule[], overrides: RuleOverrides): Rule[] {
  return parent.filter((rule) => Object.prototype.hasOwnProperty.call(overrides.hidden, rule.id));
}

export interface LayerableConfig {
  models?: { conversation?: ModelPick; work?: ModelPick };
  memberModels?: Record<string, { work?: ModelPick }>;
  replyMode?: GroupReplyMode;
}

/** 把话题自己的 overrides 逐项叠在上级配置之上；不修改入参对象。 */
export function layerOverrides<T extends LayerableConfig>(parent: T, overrides: TopicOverrides): T {
  const hasModels = Boolean(
    parent.models?.conversation ||
      parent.models?.work ||
      overrides.models?.conversation ||
      overrides.models?.work,
  );
  const models = hasModels
    ? {
        ...(parent.models?.conversation ? { conversation: parent.models.conversation } : {}),
        ...(parent.models?.work ? { work: parent.models.work } : {}),
        ...(overrides.models?.conversation ? { conversation: overrides.models.conversation } : {}),
        ...(overrides.models?.work ? { work: overrides.models.work } : {}),
      }
    : undefined;

  const memberModels: Record<string, { work?: ModelPick }> = {};
  for (const [aid, entry] of Object.entries(parent.memberModels ?? {})) {
    if (entry?.work) memberModels[aid] = { work: entry.work };
  }
  for (const [aid, entry] of Object.entries(overrides.memberModels ?? {})) {
    if (entry?.work) memberModels[aid] = { work: entry.work };
  }
  const hasMemberModels = Object.keys(memberModels).length > 0;

  const replyMode = overrides.replyMode ?? parent.replyMode;

  const out: LayerableConfig = { ...parent };
  if (models) out.models = models;
  else delete out.models;
  if (hasMemberModels) out.memberModels = memberModels;
  else delete out.memberModels;
  if (replyMode !== undefined) out.replyMode = replyMode;
  else delete out.replyMode;
  return out as T;
}

/** 在话题层新增或修改一条规则：上级规则改写进 changed，新规则写进 own。 */
export function setTopicRule(
  host: TopicConfigHost,
  input: { id?: string; text: string },
): EffectiveRule {
  const parent = host.parentRules();
  const next = pruneRuleOverrides(parent, host.readRuleOverrides());
  const now = new Date().toISOString();
  const text = input.text.trim();
  if (!text) throw new Error("规则无效。");

  if (input.id !== undefined) {
    const parentRule = parent.find((rule) => rule.id === input.id);
    if (parentRule) {
      delete next.hidden[parentRule.id];
      if (text === parentRule.text) {
        delete next.changed[parentRule.id];
        host.writeRuleOverrides(next);
        return { ...parentRule, from: "parent" };
      }
      next.changed[parentRule.id] = { text, changedAt: now };
      host.writeRuleOverrides(next);
      return { id: parentRule.id, text, changedAt: now, from: "parent", changed: true };
    }
    const ownIdx = next.own.findIndex((rule) => rule.id === input.id);
    if (ownIdx === -1) throw new Error("规则不存在。");
    const cur = next.own[ownIdx]!;
    const updated: Rule = {
      id: cur.id,
      text,
      changedAt: now,
    };
    next.own[ownIdx] = updated;
    host.writeRuleOverrides(next);
    return { ...updated, from: "topic" };
  }

  // 曾被本话题停用的同名上级规则：重新启用，避免恢复跟随时出现重复条
  const hiddenParent = parent.find(
    (rule) => rule.text === text && Object.prototype.hasOwnProperty.call(next.hidden, rule.id),
  );
  if (hiddenParent) {
    delete next.hidden[hiddenParent.id];
    delete next.changed[hiddenParent.id];
    host.writeRuleOverrides(next);
    return { ...hiddenParent, from: "parent" };
  }

  const ownIdx = next.own.findIndex((rule) => rule.text === text);
  if (ownIdx !== -1) {
    const updated: Rule = { id: next.own[ownIdx]!.id, text, changedAt: now };
    next.own[ownIdx] = updated;
    host.writeRuleOverrides(next);
    return { ...updated, from: "topic" };
  }

  const created: Rule = { id: newId("r-"), text, changedAt: now };
  next.own.push(created);
  host.writeRuleOverrides(next);
  return { ...created, from: "topic" };
}

/** 在话题层删除一条规则：本话题自己的直接移除；上级的记进 hidden。 */
export function deleteTopicRule(host: TopicConfigHost, id: string): void {
  const parent = host.parentRules();
  const next = pruneRuleOverrides(parent, host.readRuleOverrides());

  const ownIdx = next.own.findIndex((rule) => rule.id === id);
  if (ownIdx !== -1) {
    next.own.splice(ownIdx, 1);
    host.writeRuleOverrides(next);
    return;
  }

  const parentRule = parent.find((rule) => rule.id === id);
  if (!parentRule || Object.prototype.hasOwnProperty.call(next.hidden, id)) {
    throw new Error("规则不存在。");
  }
  delete next.changed[id];
  next.hidden[id] = new Date().toISOString();
  host.writeRuleOverrides(next);
}

/** 去掉对某条上级规则的 changed / hidden，使其恢复跟随上级。 */
export function resetTopicRule(host: TopicConfigHost, id: string): void {
  const parent = host.parentRules();
  const next = pruneRuleOverrides(parent, host.readRuleOverrides());
  if (next.own.some((rule) => rule.id === id)) {
    throw new Error("本话题新增的规则不能恢复跟随。");
  }
  if (!parent.some((rule) => rule.id === id)) {
    throw new Error("规则不存在。");
  }
  delete next.changed[id];
  delete next.hidden[id];
  host.writeRuleOverrides(next);
}

/** 更新话题自己的模型、成员任务模型和回应方式覆盖；传 null 表示恢复跟随。 */
export function patchOverrides(host: TopicConfigHost, patch: OverridesPatch): TopicOverrides {
  const cur = host.readOverrides();
  const next: TopicOverrides = {
    ...(cur.models ? { models: { ...cur.models } } : {}),
    ...(cur.memberModels ? { memberModels: { ...cur.memberModels } } : {}),
    ...(cur.replyMode !== undefined ? { replyMode: cur.replyMode } : {}),
  };

  if ("replyMode" in patch) {
    if (patch.replyMode === null) delete next.replyMode;
    else if (patch.replyMode !== undefined) next.replyMode = patch.replyMode;
  }

  if (patch.models !== undefined) {
    const models = { ...next.models };
    for (const key of ["conversation", "work"] as const) {
      if (!(key in patch.models)) continue;
      if (patch.models[key] === null) delete models[key];
      else if (patch.models[key] !== undefined) models[key] = patch.models[key]!;
    }
    if (models.conversation || models.work) next.models = models;
    else delete next.models;
  }

  if (patch.memberModels !== undefined) {
    const memberModels = { ...next.memberModels };
    for (const [aid, entry] of Object.entries(patch.memberModels)) {
      if (entry === null) {
        delete memberModels[aid];
        continue;
      }
      if (!entry || !("work" in entry)) continue;
      if (entry.work === null) delete memberModels[aid];
      else if (entry.work !== undefined) memberModels[aid] = { work: entry.work };
    }
    if (Object.keys(memberModels).length) next.memberModels = memberModels;
    else delete next.memberModels;
  }

  host.writeOverrides(next);
  return next;
}
