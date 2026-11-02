import { Cron } from "croner";
import type { Job, Routine } from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";
import { newId } from "./ids.ts";

export interface RoutineInput {
  assistantId: string;
  name: string;
  instruction: string;
  schedules: string[];
}

function validate(schedules: string[], timezone: string): void {
  if (!schedules.length) throw new Error("定时任务至少需要一个执行时间。");
  for (const schedule of schedules) {
    try {
      const cron = new Cron(schedule, { timezone });
      cron.stop();
    } catch {
      throw new Error(`cron 表达式不合法：${schedule}`);
    }
  }
}

/** croner 调度：每个开启的定时按 schedules 起一个 Cron，增删改即时生效。 */
export class RoutineScheduler {
  private timers = new Map<string, Cron[]>();

  constructor(private readonly runtime: HobRuntime) {}

  start(): void {
    for (const routine of this.runtime.store.routines()) this.apply(routine);
  }

  stop(): void {
    for (const list of this.timers.values()) for (const cron of list) cron.stop();
    this.timers.clear();
  }

  /** 设置里的时区改了：按新时区重新排（cron 的时区是建的时候定死的）。 */
  reload(): void {
    this.stop();
    this.start();
  }

  private apply(routine: Routine): void {
    for (const cron of this.timers.get(routine.id) ?? []) cron.stop();
    this.timers.delete(routine.id);
    if (!routine.active) return;
    const list = routine.schedules.map(
      // cron 里的时间都按设置里的时区算（服务器系统时区可能是别的）
      (schedule) =>
        new Cron(schedule, { timezone: this.runtime.settings.settings.general.timezone }, () => void this.fire(routine.id)),
    );
    this.timers.set(routine.id, list);
  }

  private async fire(routineId: string): Promise<void> {
    const routine = this.runtime.store.routine(routineId);
    if (!routine || !routine.active) return;
    try {
      await this.runtime.jobs.start(routine.assistantId, {
        title: routine.name,
        instruction: routine.instruction,
        routineId: routine.id,
      });
    } catch (error) {
      await this.runtime.router.addItem(routine.assistantId, {
        kind: "note",
        icon: "routine",
        text: `定时任务「${routine.name}」启动失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  create(input: RoutineInput): Routine {
    validate(input.schedules, this.runtime.settings.settings.general.timezone);
    const routine: Routine = {
      id: newId("rt-"),
      assistantId: input.assistantId,
      name: input.name,
      instruction: input.instruction,
      schedules: input.schedules,
      active: true,
      createdAt: new Date().toISOString(),
      runs: [],
    };
    this.runtime.store.saveRoutine(routine);
    this.apply(routine);
    this.runtime.bus.emit({ type: "routine", routine });
    return routine;
  }

  update(id: string, patch: Partial<Pick<Routine, "name" | "instruction" | "schedules" | "active">>): Routine {
    const routine = this.runtime.store.routine(id);
    if (!routine) throw new Error(`定时任务不存在：${id}`);
    if (patch.schedules) validate(patch.schedules, this.runtime.settings.settings.general.timezone);
    const next: Routine = { ...routine, ...patch };
    this.runtime.store.saveRoutine(next);
    this.apply(next);
    this.runtime.bus.emit({ type: "routine", routine: next });
    return next;
  }

  remove(id: string): void {
    const routine = this.runtime.store.routine(id);
    if (!routine) throw new Error(`定时任务不存在：${id}`);
    for (const cron of this.timers.get(id) ?? []) cron.stop();
    this.timers.delete(id);
    this.runtime.store.deleteRoutine(id);
    this.runtime.bus.emit({ type: "routine_removed", id });
  }

  /** 这个定时下次要跑的时间（调试和测试用）。 */
  nextRuns(id: string): (string | undefined)[] {
    return (this.timers.get(id) ?? []).map((cron) => cron.nextRun()?.toISOString() ?? undefined);
  }

  /** 立即跑一次（不影响原定时间）。 */
  async runNow(id: string): Promise<Job> {
    const routine = this.runtime.store.routine(id);
    if (!routine) throw new Error(`定时任务不存在：${id}`);
    return await this.runtime.jobs.start(routine.assistantId, {
      title: routine.name,
      instruction: routine.instruction,
      routineId: routine.id,
    });
  }
}
