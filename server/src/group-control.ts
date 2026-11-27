export type GroupControlAction = "pause" | "resume";

const PAUSE = /^(?:先?暂停(?:一下|吧)?|先?停(?:一下|下|一停|住|吧)?|先?别说了?|打住|pause|stop|hold on|wait(?: a sec)?)[。！!.~～…]*$/i;
const RESUME = /^(?:继续(?:吧|呀)?|接着(?:来|说|走|继续)吧?|恢复吧?|往下走|resume|continue|go on|proceed)[。！!.~～…]*$/i;

export function detectGroupControl(text: string): GroupControlAction | null {
  const trimmed = text.trim();
  if (!trimmed || [...trimmed].length > 30 || /[?？@]/.test(trimmed)) return null;
  if (PAUSE.test(trimmed)) return "pause";
  if (RESUME.test(trimmed)) return "resume";
  return null;
}
