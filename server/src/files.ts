// /api/files 的取文件规则：路径先解开符号链接，再判断能不能给页面看。
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileKind, isTextKind, mimeOf } from "../../shared/files.ts";
import type { FileKind, JobFileEntry, JobFilesView } from "../../shared/types.ts";

/** 数据目录根上不对页面开放的文件：Hob 自己的凭据和内部状态（连同它们的临时文件、备份）。 */
const DENY_ROOT_FILE = /^(secrets|config|settings|push)\.json/i;
/** 数据目录根上不对页面开放的目录：引擎目录（凭据、bin）和 Lore 连接。 */
const DENY_ROOT_DIRS = new Set(["engine", "lore"]);
/** 备份文件一律不给（凭据的备份也在里面）。 */
const DENY_ANY_FILE = /\.bak/i;

/** 预览面板最多拉 1 MB 文本。 */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** 任务工作目录里最多列 200 个文件。 */
const MAX_JOB_FILES = 200;
/** 递归太深的目录不进去（产出文件不该有这么深）。 */
const MAX_DEPTH = 8;
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
 * 解析一个路径：realpath 后必须还在数据目录里（符号链接指出去就是 403），
 * 凭据和内部状态文件不开放，不是普通文件当 404。
 */
export function lookupFile(home: string, requested: string): Lookup {
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
  if (!path.startsWith(`${root}${sep}`)) return { ok: false, status: 403, error: "只允许读 Hob 自己的文件" };
  if (denied(root, path)) return { ok: false, status: 403, error: "这个文件不对页面开放" };
  const name = basename(path);
  const kind = fileKind(name) ?? (looksText(headOf(path)) ? "text" : "other");
  const text = isTextKind(kind);
  return {
    ok: true,
    info: { path, name, size, modifiedAt, kind, text, mime: mimeOf(name), ...(/^pages[/\\][0-9a-f-]{36}\.html$/i.test(relative(root, path)) ? { page: true } : {}) },
  };
}

function walk(dir: string, base: string, depth: number, out: JobFileEntry[]): boolean {
  if (depth > MAX_DEPTH) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    // 符号链接不跟：可能指到目录外面，也可能绕成环
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (walk(path, base, depth + 1, out)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    out.push({
      path,
      rel: relative(base, path),
      name: entry.name,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      kind: fileKind(entry.name) ?? (looksText(headOf(path)) ? "text" : "other"),
    });
    if (out.length >= MAX_JOB_FILES + 1) return true;
  }
  return false;
}

/** 任务工作目录里的文件：递归、修改时间倒序、最多 200 个，跳过 node_modules 和 .git。 */
export function listJobFiles(workDir: string): JobFilesView {
  const all: JobFileEntry[] = [];
  walk(workDir, workDir, 0, all);
  all.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { files: all.slice(0, MAX_JOB_FILES), hasMore: all.length > MAX_JOB_FILES };
}
