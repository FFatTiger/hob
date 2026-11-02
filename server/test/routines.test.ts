import { describe, expect, it } from "vitest";
import { call, makeHob, text } from "./helpers.ts";

describe("定时", () => {
  it("创建、改时间即时生效、立即跑一次并记 runs", async () => {
    const hob = makeHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "每日简报",
        instruction: "看看今天的新闻",
        schedules: ["0 9 * * *"],
      });
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(1);

      const updated = hob.runtime.routines.update(routine.id, { schedules: ["0 9 * * *", "0 21 * * *"] });
      expect(updated.schedules).toEqual(["0 9 * * *", "0 21 * * *"]);
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(2);

      // 关掉就不排了
      hob.runtime.routines.update(routine.id, { active: false });
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(0);
      hob.runtime.routines.update(routine.id, { active: true });

      hob.faux.setResponses([
        call("report", { outcome: "done", summary: "今天 6 条" }),
        text("简报好了。"),
        text("好"),
      ]);
      const job = await hob.runtime.routines.runNow(routine.id);
      expect(job.routineId).toBe(routine.id);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const saved = hob.runtime.store.routine(routine.id)!;
      expect(saved.runs[0]).toMatchObject({ jobId: job.id, status: "done" });

      // 定时结果的回复带 routine 标记
      const items = hob.runtime.router.items("hob").items;
      const reply = items.filter((item) => item.kind === "assistant").pop();
      expect(reply).toMatchObject({ kind: "assistant", routine: { id: routine.id, name: "每日简报" } });
    } finally {
      hob.close();
    }
  });

  it("非法 cron 报错，不建定时", () => {
    const hob = makeHob();
    try {
      expect(() =>
        hob.runtime.routines.create({
          assistantId: "hob",
          name: "坏定时",
          instruction: "x",
          schedules: ["不是 cron"],
        }),
      ).toThrow(/cron/);
      expect(hob.runtime.store.routines()).toHaveLength(0);
    } finally {
      hob.close();
    }
  });

  it("删掉定时后不再排", () => {
    const hob = makeHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "临时",
        instruction: "x",
        schedules: ["0 9 * * *"],
      });
      hob.runtime.routines.remove(routine.id);
      expect(hob.runtime.store.routine(routine.id)).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(routine.id)).toEqual([]);
    } finally {
      hob.close();
    }
  });
});
