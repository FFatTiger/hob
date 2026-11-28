import { isAbsolute, relative } from "node:path";

/** 左栏头像下的小字：去掉多余空白，超过 max 个字符按 Unicode 码点截断（不劈开代理对，不补省略号）。 */
export function clampDuty(value: string, max = 8): string {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : chars.join("");
}

/** 活动流里的路径：在工作目录下的就显示相对路径。 */
export function showPath(path: string, cwd: string): string {
  if (!path || !cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** 模型服务的报错压成一句：「my-proxy API error (429): {"message":"…"}」→「模型服务返回 429：…」。 */
export function briefModelError(raw: string | undefined): string {
  if (!raw) return "模型服务出错";
  const code = raw.match(/\((\d{3})\)/)?.[1];
  const detail = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? raw.replace(/\s+/g, " ");
  const short = detail.length > 120 ? `${detail.slice(0, 119)}…` : detail;
  return code ? `模型服务返回 ${code}：${short}` : short;
}
