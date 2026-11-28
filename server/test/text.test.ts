import { describe, expect, it } from "vitest";
import { clampDuty } from "../src/text.ts";

describe("clampDuty", () => {
  it("collapses whitespace and keeps short duties unchanged", () => {
    expect(clampDuty("  安全\n  与逆向  ")).toBe("安全 与逆向");
    expect(clampDuty("")).toBe("");
  });

  it("truncates by Unicode code points without splitting surrogate pairs", () => {
    const clamped = clampDuty("1234567🔥extra", 8);
    expect(clamped).toBe("1234567🔥");
    expect(clamped.isWellFormed()).toBe(true);
    expect(clampDuty("🔥🚀✨🎉🌟💡🎯🛠️⚡", 8)).toBe("🔥🚀✨🎉🌟💡🎯🛠");
  });

  it("trims trailing whitespace introduced by truncation", () => {
    expect(clampDuty("abcdefg hijkl", 8)).toBe("abcdefg");
  });
});
