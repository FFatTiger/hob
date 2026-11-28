import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../shared/i18n.ts";
import type { LocalMemoryEntry, LocalMemoryView, ScratchpadEntry } from "../../shared/types.ts";
import { memoryDir } from "./config.ts";

export const MAX_MEMORY_BYTES = 512 * 1024;

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_FILE_REGEX = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** 与 pi-memory 一致的记忆条目元数据注释行格式。 */
const MEMORY_ENTRY_META_COMMENT_REGEX =
  /^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const MEMORY_ENTRY_META_CAPTURE =
  /^<!-- (?:last updated: |HANDOFF )?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([^\]\r\n]+)\] -->$/;

const SCRATCHPAD_ITEM_REGEX = /^- \[([ xX])\] (.+)$/;
const SCRATCHPAD_META_COMMENT_REGEX = /^<!-- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

export function isValidDailyDate(date: string): boolean {
  if (!DAILY_DATE_REGEX.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function assertSafePath(path: string, expectDir: boolean): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(t("记忆目录或文件不能是符号链接"));
  if (expectDir && !stat.isDirectory()) throw new Error(t("记忆目录无效"));
  if (!expectDir && !stat.isFile()) throw new Error(t("记忆文件无效"));
  return true;
}

function readSafeFile(filePath: string): string | null {
  if (!assertSafePath(filePath, false)) return null;
  const stat = lstatSync(filePath);
  if (stat.size > MAX_MEMORY_BYTES) throw new Error(t("记忆文件不能超过 512 KiB"));
  return readFileSync(filePath, "utf8");
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
}

function parseMemoryBlocks(content: string, prefix: "lt" | "dy"): LocalMemoryEntry[] {
  const normalized = normalizeNewlines(content);
  const rawBlocks: Array<{ raw: string; metaLine?: string; text: string }> = [];
  let currentLines: string[] = [];
  let currentIsStamped = false;

  const flush = () => {
    const joined = currentLines.join("\n").trim();
    if (!joined) return;
    if (currentIsStamped) {
      const metaLine = currentLines[0]!;
      const body = currentLines.slice(1).join("\n").trim();
      if (!body) return;
      rawBlocks.push({ raw: `${metaLine}\n${body}`, metaLine, text: body });
    } else {
      for (const paragraph of joined.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (trimmed) rawBlocks.push({ raw: trimmed, text: trimmed });
      }
    }
  };

  for (const line of normalized.split("\n")) {
    if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
      flush();
      currentLines = [line];
      currentIsStamped = true;
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return rawBlocks.map((block, index) => {
    const metaMatch = block.metaLine ? MEMORY_ENTRY_META_CAPTURE.exec(block.metaLine) : null;
    return {
      id: `${prefix}-${index}-${shortHash(block.raw)}`,
      text: block.text,
      ...(metaMatch ? { updatedAt: metaMatch[1], source: metaMatch[2] } : {}),
    };
  });
}

function parseScratchpadLines(content: string): ScratchpadEntry[] {
  const lines = normalizeNewlines(content).split("\n");
  const entries: ScratchpadEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = SCRATCHPAD_ITEM_REGEX.exec(line);
    if (!match) continue;
    const prev = i > 0 ? lines[i - 1]! : "";
    const metaMatch = SCRATCHPAD_META_COMMENT_REGEX.exec(prev);
    entries.push({
      id: `sp-${i}-${shortHash(line)}`,
      done: match[1]!.toLowerCase() === "x",
      text: match[2]!,
      ...(metaMatch ? { updatedAt: metaMatch[1] } : {}),
    });
  }
  return entries;
}

function listDailyDates(dir: string): string[] {
  const dailyDir = join(dir, "daily");
  if (!assertSafePath(dailyDir, true)) return [];
  const dates: string[] = [];
  for (const entry of readdirSync(dailyDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const match = DAILY_FILE_REGEX.exec(entry.name);
    if (!match) continue;
    const date = match[1]!;
    if (isValidDailyDate(date)) dates.push(date);
  }
  return dates.sort((a, b) => b.localeCompare(a));
}

export function readLocalMemory(home: string, requestedDate?: string): LocalMemoryView {
  if (requestedDate !== undefined && !isValidDailyDate(requestedDate)) {
    throw new Error(t("日期格式无效，应为 YYYY-MM-DD"));
  }
  const dir = memoryDir(home);
  if (!assertSafePath(dir, true)) {
    return {
      longTerm: [],
      scratchpad: [],
      dailyDates: [],
      ...(requestedDate ? { dailyDate: requestedDate } : {}),
      daily: [],
    };
  }

  const memoryContent = readSafeFile(join(dir, "MEMORY.md"));
  const longTerm = memoryContent ? parseMemoryBlocks(memoryContent, "lt") : [];

  const scratchpadContent = readSafeFile(join(dir, "SCRATCHPAD.md"));
  const scratchpad = scratchpadContent ? parseScratchpadLines(scratchpadContent) : [];

  const dailyDates = listDailyDates(dir);
  const dailyDate = requestedDate ?? dailyDates[0];
  let daily: LocalMemoryEntry[] = [];
  if (dailyDate) {
    const dailyDir = join(dir, "daily");
    if (assertSafePath(dailyDir, true)) {
      const dailyContent = readSafeFile(join(dailyDir, `${dailyDate}.md`));
      if (dailyContent) daily = parseMemoryBlocks(dailyContent, "dy");
    }
  }

  return {
    longTerm,
    scratchpad,
    dailyDates,
    ...(dailyDate ? { dailyDate } : {}),
    daily,
  };
}
