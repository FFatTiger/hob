const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function time(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function weekday(token: string): string | undefined {
  const map: Record<string, string> = { "0": "日", "7": "日", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六" };
  return map[token];
}

/**
 * cron 转中文：覆盖常见的每天 / 每周 / 每月 / 每隔几分钟，认不出的原样返回。
 * 只处理 5 段表达式（分 时 日 月 周）。
 */
export function cronToChinese(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, dow] = parts;
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? time(hour, minute) : undefined;

  if (minute.startsWith("*/") && hour === "*" && day === "*" && month === "*" && dow === "*") {
    return `每 ${minute.slice(2)} 分钟`;
  }
  if (minute === "0" && hour === "*" && day === "*" && month === "*" && dow === "*") return "每小时整点";
  if (!at) return expression;

  if (day === "L" && month === "*" && dow === "*") return `每月最后一天 ${at}`;
  if (/^\d+$/.test(day) && month === "*" && dow === "*") return `每月 ${day} 日 ${at}`;
  if (day === "*" && month === "*") {
    if (dow === "*") return `每天 ${at}`;
    if (/^\d+$/.test(dow)) {
      const name = weekday(dow);
      return name ? `每周${name} ${at}` : expression;
    }
    const range = dow.match(/^(\d)-(\d)$/);
    if (range) {
      const from = weekday(range[1]);
      const to = weekday(range[2]);
      if (from && to) return `每周${from}到${to} ${at}`;
    }
    const list = dow.split(",");
    if (list.length > 1 && list.every((item) => /^\d$/.test(item))) {
      const names = list.map((item) => WEEKDAYS[Number(item) % 7]);
      return `每周${names.join("、")} ${at}`;
    }
  }
  return expression;
}
