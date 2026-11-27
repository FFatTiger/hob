import { t } from "./i18n.ts";

/** 生成「以后直接执行」记下的规则文字（按当前语言）。 */
export function allowAlwaysRuleText(remember: string): string {
  return t("{remember}，直接做，不用先问我。", { remember });
}

/** 生成拆分助手 askFirst 记下的规则文字（已是完整句则原样保留）。 */
export function askFirstRuleText(item: string): string {
  const trimmed = item.trim();
  if (trimmed.endsWith("。") || trimmed.endsWith(".")) return trimmed;
  return t("{item}之前，先问我。", { item: trimmed });
}

/** 判断已有规则是否对应同一件 remember 事项（兼容新旧写法与中英文）。 */
export function matchesRememberRule(ruleText: string, remember: string): boolean {
  return (
    ruleText === remember ||
    ruleText === `直接执行：${remember}` ||
    ruleText === `执行前确认：${remember}` ||
    ruleText === t("{remember}，直接做，不用先问我。", { remember }, "zh-CN") ||
    ruleText === t("{remember}，直接做，不用先问我。", { remember }, "en") ||
    ruleText === t("{item}之前，先问我。", { item: remember }, "zh-CN") ||
    ruleText === t("{item}之前，先问我。", { item: remember }, "en")
  );
}
