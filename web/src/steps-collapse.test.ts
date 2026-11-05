import { describe, expect, it } from "vitest";
import type { JobStep } from "../../shared/types.ts";
import { groupThinking, visibleSteps } from "./steps.ts";

describe("执行过程折叠", () => {
  const steps = (count: number): JobStep[] => Array.from({ length: count }, (_, i) => ({ id: String(i), kind: "tool", at: "2026-11-05", name: "read" }));
  it("最多显示前八步并计算剩余", () => {
    const rows = groupThinking(steps(11)).rows;
    expect(visibleSteps(rows, true, false)).toEqual({ rows: rows.slice(0, 8), remaining: 3 });
    expect(visibleSteps(rows, true, true)).toEqual({ rows, remaining: 0 });
    expect(visibleSteps(rows, false, false)).toEqual({ rows, remaining: 0 });
  });
  it.each([0, 7, 8])("%i 行不折叠", (count) => {
    expect(visibleSteps(groupThinking(steps(count)).rows, true, false).remaining).toBe(0);
  });
  it("先把思考并进步骤再计数", () => {
    const rows = groupThinking([{ id: "think", kind: "thinking", at: "2026-11-05", text: "思考" }, ...steps(9)]).rows;
    expect(rows[0].thinking).toBe("思考");
    expect(visibleSteps(rows, true, false).remaining).toBe(1);
  });
});
