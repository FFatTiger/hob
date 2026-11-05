// /api/files 的取文件规则：路径先解开符号链接，再判断能不能给页面看。
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileKind, isTextKind, mimeOf } from "../../shared/files.ts";
import type { FileKind, JobFileEntry, JobFilesView } from "../../shared/types.ts";

/** 数据目录根上不对页面开放的文件：Hob 自己的凭据和内部状态（连同它们的临时文件、备份）。 */
const DENY_ROOT_FILE = /^(secrets|config|settings|push)\.json/i;
/** 数据目录根上不对页面开放的目录：引擎目录（凭据、bin）和 Lore 连接。 */
const DENY_ROOT_DIRS = new Set(["engine", "lore"]);
/** 备份文件一律不给（凭据的备份也在里面）。 */
const DENY_ANY_FILE = /\.bak/i;

/** 任务工作目录里不对页面开放的：密钥目录、git 内部、.env、私钥。 */
const DENY_WORK_DIRS = /(^|[/\\])\.(ssh|gnupg|aws|git)([/\\]|$)/;
const DENY_WORK_FILE = /^(\.env.*|id_[a-z0-9]+|.*\.(pem|key))$/i;

/** 预览面板最多拉 1 MB 文本。 */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** 任务工作目录里最多列 200 个文件。 */
const MAX_JOB_FILES = 200;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface FileInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  kind: FileKind;
  text: boolean;
  mime: string;
  page?: boolean;
}

export type Lookup = { ok: true; info: FileInfo } | { ok: false; status: 403 | 404; error: string };

function denied(root: string, path: string): boolean {
  const rel = relative(root, path);
  const parts = rel.split(sep);
  if (DENY_ROOT_DIRS.has(parts[0] ?? "")) return true;
  // 根上的凭据文件（含 settings.json.1234.tmp 这种原子写临时文件）
  if (parts.length === 1 && DENY_ROOT_FILE.test(parts[0] ?? "")) return true;
  return DENY_ANY_FILE.test(basename(path));
}

/** 开头几个字节里有没有 NUL 或控制字符：没有就当文本。 */
export function looksText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  let bad = 0;
  for (const byte of head) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) bad += 1;
  }
  return bad <= head.length * 0.01;
}

function headOf(path: string): Uint8Array {
  const buffer = Buffer.alloc(4096);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } catch {
    return new Uint8Array();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 解析一个路径：realpath 后必须在数据目录或某个任务的工作目录里（符号链接指出去就是 403），
 * 凭据和内部状态文件不开放，不是普通文件当 404。
 * 包含数据目录的工作目录（家目录、根目录这类）太宽，不算数。
 */
export function lookupFile(home: string, requested: string, workDirs: string[] = []): Lookup {
  const root = realpathSync(resolve(home));
  let path: string;
  let size: number;
  let modifiedAt: string;
  try {
    path = realpathSync(resolve(requested));
    const stats = statSync(path);
    if (!stats.isFile()) return { ok: false, status: 404, error: "文件不存在" };
    size = stats.size;
    modifiedAt = stats.mtime.toISOString();
  } catch {
    return { ok: false, status: 404, error: "文件不存在" };
  }
  const inHome = path.startsWith(`${root}${sep}`);
  const work = inHome ? undefined : workRoots(root, workDirs).find((dir) => path.startsWith(`${dir}${sep}`));
  if (!inHome && !work) return { ok: false, status: 403, error: "只允许读 Hob 自己的文件" };
  const relativePath = relative(inHome ? root : work!, path);
  if ((inHome && denied(root, path)) || DENY_WORK_DIRS.test(relativePath) || DENY_WORK_FILE.test(basename(path)) || DENY_ANY_FILE.test(basename(path))) {
    return { ok: false, status: 403, error: "这个文件不对页面开放" };
  }
  const name = basename(path);
  const kind = fileKind(name) ?? (looksText(headOf(path)) ? "text" : "other");
  const text = isTextKind(kind);
  return {
    ok: true,
    info: { path, name, size, modifiedAt, kind, text, mime: mimeOf(name), ...(/^(?:pages[/\\][0-9a-f-]{36}|knowledge[/\\]pages[/\\][0-9a-f]{64})\.html$/i.test(relative(root, path)) ? { page: true } : {}) },
  };
}

function workRoots(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of new Set(dirs)) {
    try {
      const real = realpathSync(resolve(dir));
      if (!`${root}${sep}`.startsWith(`${real === sep ? "" : real}${sep}`)) out.push(real);
    } catch {
      // 目录已经删了：不算
    }
  }
  return out;
}

function visibleEntries(dir: string) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) =>
    !entry.isSymbolicLink() && (entry.isFile() || (entry.isDirectory() && !SKIP_DIRS.has(entry.name))));
}

/** 一次只列一层；拒绝越界和符号链接。工作目录还没建出来时当作空的。 */
export function listJobFiles(workDir: string, subdir = ""): JobFilesView {
  const parts = subdir.split(/[\\/]/).filter(Boolean);
  if (isAbsolute(subdir) || parts.some((part) => part === ".." || SKIP_DIRS.has(part))) throw new Error("工作目录路径无效");
  const base = resolve(workDir);
  if (!parts.length && !existsSync(base)) return { files: [], total: 0, fileCount: 0, directoryCount: 0 };
  let dir = base;
  let entries;
  try {
    for (const part of parts) {
      dir = join(dir, part);
      const info = lstatSync(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("不是文件夹");
    }
    entries = visibleEntries(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOENT" ? "这个文件夹已经不在了" : code === "EACCES" ? "没有权限读取这个文件夹" : "工作目录路径无效");
  }
  const all: JobFileEntry[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const common = { path, rel: relative(base, path), name: entry.name };
    try {
      if (entry.isDirectory()) {
        all.push({ ...common, type: "directory", count: visibleEntries(path).length });
      } else {
        const stats = statSync(path);
        all.push({ ...common, type: "file", size: stats.size, modifiedAt: stats.mtime.toISOString(), kind: fileKind(entry.name) ?? (looksText(headOf(path)) ? "text" : "other") });
      }
    } catch {
      // 列的时候刚被删掉或读不了（在跑的任务常有临时文件）：跳过这一项
    }
  }
  all.sort((a, b) => a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.type === "file" && b.type === "file" ? b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  const directoryCount = all.filter((entry) => entry.type === "directory").length;
  return { files: all.slice(0, MAX_JOB_FILES), total: all.length, directoryCount, fileCount: all.length - directoryCount };
}
