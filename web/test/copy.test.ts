import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 界面文字规范见 docs/copy.md：用户能看到的文字一律用书面中文，口语词不再出现。
const BANNED = ["干活", "派活", "拍板", "卡住", "没动静", "试一张", "先问你", "直接做"];
// 状态词全站统一成这七个，旧的写法不许再出现。
const OLD_STATUS = ["等你批"];

const ROOT = join(import.meta.dirname, "..", "..");
const WEB_SRC = join(ROOT, "web", "src");
const SERVER_SRC = join(ROOT, "server", "src");


/** 某个目录下全部 .ts / .tsx 源文件。 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** 这些文件里出现不能出现的词，逐条列出来。 */
function hits(files: string[], words: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      for (const word of words) {
        if (line.includes(word)) found.push(`${relative(ROOT, file)}: ${word} → ${line.trim().slice(0, 60)}`);
      }
    }
  }
  return found;
}

describe("界面文字", () => {
  it("前端不再出现口语词", () => {
    expect(hits(sources(WEB_SRC), BANNED)).toEqual([]);
  });

  it("服务端的提示行、状态、推送、接口错误不再出现口语词", () => {
    expect(hits(sources(SERVER_SRC), BANNED)).toEqual([]);
  });

  it("状态词的旧写法已经清掉", () => {
    expect(hits([...sources(WEB_SRC), ...sources(SERVER_SRC)], OLD_STATUS)).toEqual([]);
  });
});
