import { t } from "../../shared/i18n.ts";

export function groupThinkingText(name: string, activity?: { label?: string } | null): string {
  return activity?.label ? t("{name} · {label}", { name, label: activity.label }) : t("{name} 正在思考…", { name });
}
