// 设置 → 模型「添加模型」和思考档的纯函数：按名字 / ref 过滤，按服务商分组，按模型的档收思考档。界面直接用，测试单独跑。
import type { Assistant, Group, ModelInfo, ThinkingLevel } from "../../shared/types.ts";

/** 思考档从低到高，和引擎的顺序一致（fitThinking 用）。 */
export const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 这个模型能选的思考档（引擎给的）：不会推理的模型只有 off。 */
export function thinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
  return model?.thinkingLevels ?? ["off"];
}

/** 换了模型后原来的档不在新模型的档里：往下取最近的一档；一档都没有才是 off。 */
export function fitThinking(model: ModelInfo | undefined, wants: ThinkingLevel): ThinkingLevel {
  const levels = thinkingLevels(model);
  if (!model || levels.includes(wants)) return wants;
  const rank = THINKING_ORDER.indexOf(wants);
  return [...levels].reverse().find((level) => THINKING_ORDER.indexOf(level) <= rank) ?? "off";
}

/** 模型在界面上的名字：注册表里有名字就用名字，没有就用 ref。 */
export function modelLabel(models: ModelInfo[], ref: string): string {
  return models.find((model) => model.ref === ref)?.name ?? ref;
}

/** 换模型时带上的思考档：名单里给这个模型定的档优先，其次保持当前的档，收成新模型有的档。 */
export function thinkingForSwitch(model: ModelInfo | undefined, rosterThinking: ThinkingLevel | undefined, current: ThinkingLevel): ThinkingLevel {
  return fitThinking(model, rosterThinking ?? current);
}

/** 按名字 / ref 过滤，不区分大小写；空串就是全部。 */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((model) => model.name.toLowerCase().includes(q) || model.ref.toLowerCase().includes(q));
}

/** 按服务商分组，服务商按第一次出现的顺序，组内保持原顺序。 */
export function groupByProvider(models: ModelInfo[]): { provider: string; models: ModelInfo[] }[] {
  const groups: { provider: string; models: ModelInfo[] }[] = [];
  for (const model of models) {
    let group = groups.find((item) => item.provider === model.provider);
    if (!group) {
      group = { provider: model.provider, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/** 模型设置记在哪一层：话题记在所属的群上。 */
export function modelOwner(g: Group | undefined, groups: Group[]): Group | undefined {
  return g?.parentId ? groups.find((item) => item.id === g.parentId) ?? g : g;
}

/** 这一栏自己设过的模型：群用自己的，单聊用助手的，都没设就是空串（跟随）。 */
export function ownModelRef(owner: Group | undefined, assistant: Assistant | undefined): string {
  return owner ? (owner.models?.conversation?.ref ?? "") : (assistant?.models?.conversation?.ref ?? "");
}

/** 这一栏自己设过的思考档：群用自己的，单聊用助手的，都没设就跟全局的。 */
export function ownThinking(owner: Group | undefined, assistant: Assistant | undefined, fallback: ThinkingLevel): ThinkingLevel {
  return (owner ? owner.models?.conversation?.thinking : assistant?.models?.conversation?.thinking) ?? fallback;
}

/** 能选的模型：名单里现在真的可用的那些（服务商删了、没配 Key 的不列）。 */
export function switchableRefs(roster: { ref: string; unavailable?: boolean }[], available: ModelInfo[]): string[] {
  return roster.filter((entry) => !entry.unavailable && available.some((model) => model.ref === entry.ref)).map((entry) => entry.ref);
}

/** 切换菜单的行：第一行是「跟随」，后面按名单顺序列模型。 */
export function switchOptions(refs: string[], models: ModelInfo[], follow: string): { value: string; label: string }[] {
  return [{ value: "", label: follow }, ...refs.map((ref) => ({ value: ref, label: modelLabel(models, ref) }))];
}
