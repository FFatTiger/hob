import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerApproval } from "../src/actions.ts";
import { JobManager } from "../src/jobs.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

/** 进程还在不在（被杀了就 false）。 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("任务", () => {
  it("report 的 outcome 不认识就退回重填，不当成已完成", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("report", { outcome: "failed", summary: "没连上" }),
        call("report", { outcome: "stuck", summary: "没连上数据库" }),
        text("好"),
      ]);
      hob.faux.appendResponses([text("任务受阻。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "查库", instruction: "看看数据库" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const ended = hob.runtime.store.job(job.id)!;
      expect(ended.status).toBe("stuck");
      expect(ended.summary).toBe("没连上数据库");
      // 「受阻」是状态不是原因：卡片右上角已经写了，标题下面不再重复一行
      expect(ended.statusReason).toBeUndefined();
      expect(readFileSync(ended.reportPath!, "utf8")).toContain("状态：受阻\n");
    } finally {
      hob.close();
    }
  });

  it("report 说等你拍板也是受阻，不拿状态词当原因", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("report", { outcome: "need_approval", summary: "要你定发布还是先放着" }),
        text("好"),
      ]);
      hob.faux.appendResponses([text("等你定。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "发文章", instruction: "发布一篇" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const ended = hob.runtime.store.job(job.id)!;
      expect(ended.status).toBe("stuck");
      expect(ended.statusReason).toBeUndefined();
    } finally {
      hob.close();
    }
  });

  it("report 流程：状态 done、写 report.md、推事件回对话", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", summary: "磁盘用了 40%，剩 60G" }), text("好")]);
      hob.faux.appendResponses([text("磁盘用了 40%。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "查磁盘", instruction: "看看磁盘用了多少" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const done = hob.runtime.store.job(job.id)!;
      expect(done.status).toBe("done");
      expect(done.summary).toBe("磁盘用了 40%，剩 60G");
      expect(done.endedAt).toBeTruthy();
      expect(done.reportPath && existsSync(done.reportPath)).toBe(true);
      expect(readFileSync(done.reportPath!, "utf8")).toContain("磁盘用了 40%");
      expect(hob.runtime.store.worklog("hob")[0]).toMatchObject({ jobId: job.id, text: "任务已完成：查磁盘" });
      const items = hob.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "job" && item.jobId === job.id)).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text === "磁盘用了 40%。")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("报告原样保留：多行 markdown 不压成一行、长报告不截断", async () => {
    const hob = makeHob();
    try {
      const summary = `## 结论\n\n- 第一条\n- 第二条\n\n${"细节".repeat(800)}`;
      hob.faux.setResponses([call("report", { outcome: "done", summary }), text("好")]);
      hob.faux.appendResponses([text("写完了。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "长报告", instruction: "写一份长报告" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const done = hob.runtime.store.job(job.id)!;
      expect(done.summary).toBe(summary);
      expect(readFileSync(done.reportPath!, "utf8")).toContain(summary);
    } finally {
      hob.close();
    }
  });

  it("没调用 report 会先追问一次，再不报就是 stuck", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("我做完了。"), text("没有别的事。")]);
      hob.faux.appendResponses([text("没结果。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "不该忘 report", instruction: "随便干点啥" });
      await hob.runtime.jobs.waitIdle();
      const done = hob.runtime.store.job(job.id)!;
      expect(done.status).toBe("stuck");
      expect(done.statusReason).toBe("未提交结果");
      expect(hob.faux.state.callCount).toBeGreaterThanOrEqual(2);
    } finally {
      hob.close();
    }
  });

  it("跑着时补一句：立刻出现「等待读取」一行，任务读到后换成正式的一行", async () => {
    const hob = makeHob();
    let release = () => {};
    try {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const steps: { id: string; queued?: boolean; text?: string }[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "job_step" && event.step.from === "user") steps.push(event.step); });
      hob.faux.setResponses([
        async () => { await gate; return call("bash", { command: "true" }); },
        call("report", { outcome: "done", summary: "按补充改了" }),
        text("好"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "改配置", instruction: "改配置" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      await hob.runtime.jobs.reply(job.id, "只改私聊");
      expect(steps).toEqual([expect.objectContaining({ queued: true, text: "只改私聊" })]);
      expect(hob.runtime.jobs.transcript(job.id)).toContainEqual(expect.objectContaining({ queued: true, text: "只改私聊" }));
      release();
      await hob.runtime.jobs.waitIdle();
      expect(steps[1]).toMatchObject({ id: expect.stringMatching(/^u/), text: "只改私聊" });
      expect(steps[1].queued).toBeUndefined();
      expect(hob.runtime.jobs.transcript(job.id).filter((step) => step.text === "只改私聊")).toEqual([expect.objectContaining({ id: steps[1].id })]);
    } finally {
      release();
      hob.close();
    }
  });

  it("ask_user 阻塞等答复，答完继续跑并 report", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", { title: "删掉旧报告吗？", options: [{ label: "删" }, { label: "别删" }] }),
        call("report", { outcome: "done", summary: "删了 3 个旧报告" }),
        text("好"),
        text("删掉了。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "清旧报告", instruction: "删掉旧报告" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];
      expect(approval).toMatchObject({ source: "job", jobId: job.id, status: "pending" });
      // 任务半路来问是单独的一组
      expect(hob.runtime.router.items("hob").items.find((item) => item.kind === "question")).toMatchObject({ lead: true });
      // 等用户答多久都不算「无响应」（以前 15 分钟后被看门狗标成受阻，审批卡跟着作废）
      hob.runtime.jobs.checkStalls(Date.now() + 24 * 3600_000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("waiting");

      const result = await answerApproval(hob.runtime, approval.id, { key: "A" });
      expect(result.status).toBe(200);
      await hob.runtime.jobs.waitIdle();
      const done = hob.runtime.store.job(job.id)!;
      expect(done.status).toBe("done");
      expect(done.summary).toBe("删了 3 个旧报告");
    } finally {
      hob.close();
    }
  });

  it("ask_user 用自己写的一段话回答：工具结果说明没选给出的选项，任务接着跑", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", { title: "删掉旧报告吗？", options: [{ label: "删" }, { label: "别删" }] }),
        call("report", { outcome: "done", summary: "只删了三个月前的旧报告" }),
        text("好"),
        text("只删了旧的。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "清旧报告", instruction: "删掉旧报告" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];

      const answer = "只删三个月前的，上个月的别动";
      expect((await answerApproval(hob.runtime, approval.id, { text: answer })).status).toBe(200);
      expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "answered", answerText: answer });

      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      // 模型看到的就是这句：没选给出的选项，而是用户自己回的
      const ask = hob.runtime.jobs.transcript(job.id).find((step) => step.name === "ask_user");
      expect(ask?.output).toContain(`用户没有选给出的选项，而是回复：${answer}`);
    } finally {
      hob.close();
    }
  });

  it("超过 maxJobs 的任务排队，调大以后立刻接着跑", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 1 } } });
    try {
      // 两个会话共用一套假模型，用工厂按“是不是 Worker”决定回什么，避免抢响应
      const factory = (context: any) => {
        const isWorker = JSON.stringify(context.messages[0]).includes("你在后台执行");
        if (!isWorker) return text("收到。");
        const lastAssistant = [...context.messages].reverse().find((message: any) => message.role === "assistant");
        const reported = lastAssistant?.content?.some((block: any) => block.type === "toolCall" && block.name === "report");
        return reported ? text("好的。") : call("report", { outcome: "done", summary: "好了" });
      };
      hob.faux.setResponses(Array.from({ length: 10 }, () => factory));
      const first = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干活一" });
      const second = await hob.runtime.jobs.start("hob", { title: "二", instruction: "干活二" });
      expect(hob.runtime.store.job(second.id)?.status).toBe("queued");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(first.id)?.status).toBe("done");
      expect(hob.runtime.store.job(second.id)?.status).toBe("done");
    } finally {
      hob.close();
    }
  });

  it("改设置里的同时干活数立即生效：调大后排队的不等重启就启动", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 1 } } });
    try {
      hob.faux.setResponses(
        Array.from({ length: 10 }, () => (context: any) => {
          const isWorker = JSON.stringify(context.messages[0]).includes("你在后台执行");
          return isWorker ? call("report", { outcome: "done", summary: "好了" }) : text("收到。");
        }),
      );
      const first = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干活一" });
      const second = await hob.runtime.jobs.start("hob", { title: "二", instruction: "干活二" });
      expect(hob.runtime.store.job(second.id)?.status).toBe("queued");

      const { revision } = hob.runtime.settings.get();
      hob.runtime.settings.patch(revision, { work: { maxJobs: 3 } });
      hob.runtime.jobs.pump();
      expect(hob.runtime.store.job(second.id)?.status).not.toBe("queued");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(first.id)?.status).toBe("done");
    } finally {
      hob.close();
    }
  });

  it("stop 停掉正在跑的任务", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("我在想。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "停我", instruction: "慢慢想" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "running");
      await hob.runtime.jobs.stop(job.id);
      expect(hob.runtime.store.job(job.id)?.status).toBe("stopped");
    } finally {
      hob.close();
    }
  });

  it("停止任务会杀掉正在跑的命令，状态停在 stopped", async () => {
    const hob = makeHob();
    try {
      const pidFile = join(hob.home, "bash.pid");
      hob.faux.setResponses([
        call("bash", { command: `echo $$ > ${pidFile}; sleep 60; echo 跑完了` }),
        call("report", { outcome: "done", summary: "命令跑完了" }),
        text("好"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "长命令", instruction: "跑一个很长的命令" });
      await waitFor(() => existsSync(pidFile) && hob.runtime.store.job(job.id)?.status === "running");
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      const startedAt = Date.now();
      await hob.runtime.jobs.stop(job.id);
      // 命令被终止，stop 不会等它自己跑完
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("stopped");
      expect(isRunning(pid)).toBe(false);

      // 停下来之后不会被后续的 report 改成完成
      await new Promise((resolve) => setTimeout(resolve, 500));
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.job(job.id)?.status).toBe("stopped");

      // Router 收到“已停止”事件
      const transcript = readFileSync(join(hob.home, "assistants", "hob", "router.jsonl"), "utf8");
      expect(transcript).toContain("任务「长命令」已停");
    } finally {
      hob.close();
    }
  });

  it("重启恢复：running 的任务标失败，pending 的任务类审批标过期", () => {
    const hob = makeHob();
    try {
      const job = {
        id: "t-abcd",
        assistantId: "hob",
        title: "断电前",
        instruction: "干一半",
        status: "running" as const,
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(job);
      hob.runtime.store.saveApproval({
        id: "q-old",
        assistantId: "hob",
        title: "还在问",
        options: [
          { key: "A", label: "好" },
          { key: "B", label: "不好" },
        ],
        status: "pending",
        source: "job",
        jobId: "t-abcd",
        createdAt: new Date().toISOString(),
      });
      new JobManager(hob.runtime).recover();
      expect(hob.runtime.store.job("t-abcd")).toMatchObject({
        status: "failed",
        statusReason: "Hob 重启，任务中断",
      });
      expect(hob.runtime.store.approval("q-old")?.status).toBe("expired");
    } finally {
      hob.close();
    }
  });

  it("本机任务的工作目录是 HOB_HOME/jobs/<id>/work，显式给了 cwd 才用它", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", summary: "写好了" }), text("好")]);
      hob.faux.appendResponses([text("好了")]);
      const job = await hob.runtime.jobs.start("hob", { title: "写简报", instruction: "写一份简报" });
      expect(job.cwd).toBe(join(hob.home, "jobs", job.id, "work"));
      expect(existsSync(job.cwd!)).toBe(true);
      await hob.runtime.jobs.waitIdle();

      const explicit = await hob.runtime.jobs.start("hob", {
        title: "在别处干活",
        instruction: "在给定目录干活",
        cwd: hob.home,
      });
      expect(explicit.cwd).toBe(hob.home);
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });
});
