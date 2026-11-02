import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  COLORS,
  COLOR_IDS,
  customSprite,
  distinctSprite,
  parseSprite,
  PROP_IDS,
  PROPS,
  spriteId,
  validateCustomProp,
} from "../../shared/sprites.ts";
import type { ColorId } from "../../shared/sprites.ts";
import type { Approval, ApprovalOption, CustomProp, Draft, Routine } from "../../shared/types.ts";
import { cronToChinese } from "./cron-text.ts";
import { newId } from "./ids.ts";
import { defaultWorkRef, jobModel, noteOf, thinkingLevelsOf, usableRefs } from "./models.ts";
import { overviewTool } from "./overview.ts";
import { pageTool } from "./pages.ts";
import { pushApproval } from "./push.ts";
import { searchTools } from "./search.ts";
import type { HobRuntime } from "./runtime.ts";
import { clampDuty } from "./text.ts";

type Tool = ToolDefinition<any, any>;

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/**
 * 出了卡片就结束本轮：pi 的 terminate 让这一批工具结果之后不再请求模型，
 * 用户不会再看到卡片后面补的一句废话。
 */
function endTurn(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, terminate: true };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

function fileMeta(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    if (!/\.(md|txt)$/i.test(path)) return undefined;
    const text = readFileSync(path, "utf8");
    const chars = text.replace(/\s/g, "").length;
    const images = path.toLowerCase().endsWith(".md") ? (text.match(/!\[[^\]]*\]\([^)]*\)/g)?.length ?? 0) : 0;
    return `${chars} 字${images ? ` · ${images} 张图` : ""}`;
  } catch {
    return undefined;
  }
}

/** 一个助手的 Router 能用的全部工具。改状态的工具都写卡片 + 发事件。 */
export function buildRouterTools(runtime: HobRuntime, assistantId: string): Tool[] {
  const { store, bus, router, jobs, routines } = runtime;
  const assistant = () => {
    const found = store.assistant(assistantId);
    if (!found) throw new Error(`助手不存在：${assistantId}`);
    return found;
  };
  const note = (icon: "memory" | "rule" | "routine" | "split" | "info", text: string) =>
    router.addItem(assistantId, { kind: "note", icon, text });
  const profileChanged = () => bus.emit({ type: "profile", assistantId });

  // 能派的模型：写进 start_job 的参数说明，助手知道有哪些可选、哪个是默认
  const modelSettings = runtime.settings.settings.models;
  const usable = usableRefs(modelSettings, assistant(), runtime.models);
  const defaultModel = defaultWorkRef(modelSettings, assistant(), runtime.models);
  const modelList = usable.map((ref) => {
    const entry = modelSettings.roster.find((item) => item.ref === ref);
    const note = entry ? noteOf(entry, runtime.models) : "";
    const levels = modelSettings.thinkingChoice === "fixed"
      ? jobModel({ settings: modelSettings, assistant: assistant(), catalog: runtime.models, requested: { model: ref } }).model.thinking
      : thinkingLevelsOf(runtime.models.find(ref)).join("、");
    return `${ref}${ref === defaultModel ? "（默认）" : ""}${note ? ` · ${note}` : ""} · 思考档 ${levels}`;
  });
  const modelText = modelList.length ? modelList.join("\n") : "（现在没有可用的模型）";

  const tools: Tool[] = [
    {
      name: "start_job",
      label: "创建任务",
      description:
        "把需要动手的任务交给后台任务执行：读写文件、运行命令、修改内容都只能通过这个工具完成。立即返回任务 id，完成后会有一条事件回到对话。调用后这一轮就结束了：工具返回后不要再输出任何文字。" +
        (modelList.length > 1
          ? `可按任务难度和类型指定模型：${modelText}；不确定就不填，使用默认值。`
          : `模型用 ${modelText}，不用指定。`),
      promptSnippet: "把需要执行的任务交给后台任务。",
      parameters: Type.Object({
        title: Type.String({ description: "任务标题，短，如「查磁盘占用」" }),
        instruction: Type.String({ description: "要做什么，写清楚目标和验收标准" }),
        cwd: Type.Optional(
          Type.String({
            description:
              "任务的工作目录；不给就用任务自己的工作目录。写代码、改项目这类任务传项目目录。",
          }),
        ),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description: "要交给任务的文件路径（用户发来的附件）；图片会直接给模型看",
          }),
        ),
        model: Type.Optional(Type.String({ description: `可选：${modelText}。不填就用默认。` })),
        thinking: Type.Optional(
          Type.String({ description: modelSettings.thinkingChoice === "fixed" ? "当前设置为固定思考档，此参数会被忽略，不要填。" : "可选：思考档以可分派模型列表里每个模型标的为准。不填用模型的默认思考档。" }),
        ),
      }),
      execute: async (_id, params: any) => {
        try {
          const job = await jobs.start(assistantId, {
            title: String(params.title),
            instruction: String(params.instruction),
            ...(params.cwd ? { cwd: String(params.cwd) } : {}),
            ...(Array.isArray(params.files) && params.files.length ? { files: params.files.map(String) } : {}),
            ...(params.model ? { model: String(params.model) } : {}),
            ...(params.thinking ? { thinking: String(params.thinking) } : {}),
            ...(router.currentDelegation(assistantId) ? { delegationId: router.currentDelegation(assistantId) } : {}),
          });
          if (job.status === "failed") return fail(`任务启动失败：${job.statusReason ?? "原因不明"}`);
          return endTurn(
            `任务「${job.title}」（${job.id}）已启动，完成后会报告结果。任务卡已显示给用户。本轮到此结束：不要输出任何文字，不要再提这张卡。`,
          );
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "reply_job",
      label: "补充任务说明",
      description: "给正在运行的任务补充说明或纠正方向。",
      parameters: Type.Object({
        jobId: Type.String({ description: "任务 id" }),
        text: Type.String({ description: "要补充的话" }),
      }),
      execute: async (_id, params: any) => {
        try {
          await jobs.reply(String(params.jobId), String(params.text));
          return ok("已转交任务。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "stop_job",
      label: "停止任务",
      description: "停止一个正在运行的任务。",
      parameters: Type.Object({ jobId: Type.String({ description: "任务 id" }) }),
      execute: async (_id, params: any) => {
        try {
          await jobs.stop(String(params.jobId));
          return ok("已停止。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "ask_user",
      label: "询问用户",
      description:
        "在对话里出选择题卡片让用户确认（最多 3 个选项）。用于规则要求执行前确认、或者操作不可逆的时候。选完答案会作为事件回到对话。调用后这一轮就结束了：工具返回后不要再输出任何文字。",
      parameters: Type.Object({
        title: Type.String({ description: "问题，一句话" }),
        detail: Type.Optional(Type.String({ description: "补充说明，写清后果" })),
        options: Type.Array(
          Type.Object({
            label: Type.String({ description: "选项文字，如「暂不发布」" }),
            always: Type.Optional(Type.Boolean({ description: "选中后将这句话记为规则" })),
          }),
          { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
        ),
        ruleText: Type.Optional(Type.String({ description: "always 选项要写进规则的文字，如「发布公众号」" })),
      }),
      execute: async (_id, params: any) => {
        const labels: { label: string; always?: boolean }[] = Array.isArray(params.options) ? params.options : [];
        if (labels.length < 2 || labels.length > 3) return fail("选项要 2 到 3 个。");
        const options: ApprovalOption[] = labels.map((option, index) => ({
          key: (["A", "B", "C"] as const)[index],
          label: String(option.label),
          ...(option.always ? { always: true } : {}),
        }));
        const approval: Approval = {
          id: newId("q-"),
          assistantId,
          title: String(params.title),
          ...(params.detail ? { detail: String(params.detail) } : {}),
          options,
          status: "pending",
          source: "router",
          ...(params.ruleText ? { ruleText: String(params.ruleText) } : {}),
          createdAt: new Date().toISOString(),
        };
        store.saveApproval(approval);
        const delegationId = router.currentDelegation(assistantId);
        if (delegationId) runtime.delegations.addApproval(delegationId, approval.id);
        await router.addItem(assistantId, { kind: "question", approvalId: approval.id });
        bus.emit({ type: "approval", approval });
        pushApproval({ push: runtime.push, store }, approval);
        return endTurn("问题卡已显示给用户，等用户选。本轮到此结束：不要输出任何文字。");
      },
    },
    {
      name: "set_rule",
      label: "记录规则",
      description: "记录一条规则。mode=ask 表示执行前需要确认，mode=allow 表示直接执行。",
      parameters: Type.Object({
        text: Type.String({ description: "规则内容，如「发布公众号」" }),
        mode: Type.Unsafe<"ask" | "allow">(Type.String({ description: "ask 或 allow" })),
      }),
      execute: async (_id, params: any) => {
        const text = String(params.text).trim();
        if (!text) return fail("规则内容为空。");
        const mode = params.mode === "allow" ? "allow" : "ask";
        const rules = store.rules(assistantId);
        const existing = rules.find((rule) => rule.text === text);
        // 答 always 审批时规则已经写好了（Actions 那行提示也已经出过），这里没改动就不重复出：
        // 模型看到答案之后常会把同一句再记一遍，重复的提示行对用户没有信息量。
        if (existing?.mode === mode) return ok("这条规则已经记着了，没有改动。");
        if (existing) {
          existing.mode = mode;
          existing.changedAt = new Date().toISOString();
        } else {
          rules.push({ id: newId("r-"), text, mode, changedAt: new Date().toISOString() });
        }
        store.saveRules(assistantId, rules);
        await note("rule", `已记入${assistant().name}的规则 · ${text}`);
        profileChanged();
        return ok("已记录规则。");
      },
    },
    {
      name: "remove_rule",
      label: "删除规则",
      description: "删除一条规则。",
      parameters: Type.Object({ ruleId: Type.String({ description: "规则 id" }) }),
      execute: async (_id, params: any) => {
        const rules = store.rules(assistantId);
        const kept = rules.filter((rule) => rule.id !== params.ruleId);
        if (kept.length === rules.length) return fail("没有这条规则。");
        store.saveRules(assistantId, kept);
        await note("rule", "删除了一条规则");
        profileChanged();
        return ok("已删除。");
      },
    },
    {
      name: "create_routine",
      label: "新增定时任务",
      description: "新增一个定时任务。schedule 用 cron 表达式，如「0 9 * * *」每天 9 点；多个执行时间就传多个。",
      parameters: Type.Object({
        name: Type.String({ description: "定时任务名称，如「每日简报」" }),
        instruction: Type.String({ description: "到点要执行的内容" }),
        schedules: Type.Array(Type.String({ description: "cron 表达式" }), { description: "一个或多个" }),
      }),
      execute: async (_id, params: any) => {
        try {
          const routine = routines.create({
            assistantId,
            name: String(params.name),
            instruction: String(params.instruction),
            schedules: (params.schedules as string[]) ?? [],
          });
          await note("routine", `新增定时任务 · ${routine.name} · ${routine.schedules.map(cronToChinese).join("、")}`);
          profileChanged();
          return ok(`定时任务「${routine.name}」已创建。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "update_routine",
      label: "修改定时任务",
      description: "修改一个定时任务：名称、内容、执行时间（schedules 会整体替换）、启用状态。",
      parameters: Type.Object({
        routineId: Type.String(),
        name: Type.Optional(Type.String()),
        instruction: Type.Optional(Type.String()),
        schedules: Type.Optional(Type.Array(Type.String())),
        active: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params: any) => {
        try {
          const routine = routines.update(String(params.routineId), {
            ...(params.name ? { name: String(params.name) } : {}),
            ...(params.instruction ? { instruction: String(params.instruction) } : {}),
            ...(params.schedules ? { schedules: params.schedules as string[] } : {}),
            ...(typeof params.active === "boolean" ? { active: params.active } : {}),
          });
          await note("routine", `修改定时任务 · ${routine.name} · ${routine.schedules.map(cronToChinese).join("、")}`);
          profileChanged();
          return ok("已修改。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "delete_routine",
      label: "删除定时任务",
      description: "删除一个定时任务。",
      parameters: Type.Object({ routineId: Type.String() }),
      execute: async (_id, params: any) => {
        try {
          routines.remove(String(params.routineId));
          await note("routine", "删除了一条定时任务");
          profileChanged();
          return ok("已删除。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "send_file",
      label: "发送文件",
      description: "把任务产出的文件作为文件卡片发送到对话里。",
      parameters: Type.Object({ path: Type.String({ description: "文件的绝对路径" }) }),
      execute: async (_id, params: any) => {
        const path = String(params.path);
        if (!existsSync(path)) return fail(`文件不存在：${path}`);
        const meta = fileMeta(path);
        await router.addItem(assistantId, { kind: "file", path, name: basename(path), ...(meta ? { meta } : {}) });
        return ok("已发送。");
      },
    },
    {
      name: "set_avatar",
      label: "换头像",
      description: "给自己换头像：换内置道具、换颜色，或用 prop_art 自画一件像素道具。主助手还可以传 assistant 给其他助手换。",
      parameters: Type.Object({
        sprite: Type.String({
          description: `内置道具 id 之一（${PROP_IDS.filter((id) => id !== "hob").join(" ")}），或 custom（自画的，同时填 prop_art；已画过时不填 prop_art 就是换回那件）`,
        }),
        color: Type.Optional(
          Type.String({ description: `可选：火苗颜色，${COLOR_IDS.join(" ")} 之一；不填用道具的默认色` }),
        ),
        prop_art: Type.Optional(
          Type.Object({
            art: Type.Array(Type.String(), {
              description: "最多 16 行，每行恰好 16 个字符；从第 0 行起逐行盖在火苗上，. 表示不动，k 是描边色，其它字符查 pal；不能盖住火苗的两只眼睛",
            }),
            pal: Type.Record(Type.String(), Type.String(), {
              description: "单个小写字母 → #rrggbb；不能用 o y e（火苗自己的色）和 k（描边固定），最多 6 种",
            }),
            dx: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)], {
              description: "火苗的横向位置：头顶的道具用 2，手边的用 0 或 1",
            }),
          }, {
            description:
              'sprite 为 custom 时要画的那件。例：{ "art": ["....kkkk........", "...khhhhk.......", "....kkkk........"], "pal": { "h": "#ffc21a" }, "dx": 2 }',
          }),
        ),
        assistant: Type.Optional(Type.String({ description: "仅主助手：要换头像的助手 id；不填是自己" })),
      }),
      execute: async (_id, params: any) => {
        const target = store.assistant(String(params.assistant ?? assistantId));
        if (!target) return fail(`没有这个助手：${params.assistant}`);
        if (target.id !== assistantId && !assistant().primary) return fail("只有主助手能给其他助手换头像。");
        const parsed = parseSprite(String(params.sprite ?? ""));
        if (!parsed) {
          return fail(
            `sprite 要是内置道具 id 之一（${PROP_IDS.filter((id) => id !== "hob").join(" ")}）或 custom，收到「${params.sprite}」。`,
          );
        }
        const color = typeof params.color === "string" ? params.color : undefined;
        if (color !== undefined && !Object.hasOwn(COLORS, color)) {
          return fail(`color 要是 ${COLOR_IDS.join(" ")} 之一，收到「${color}」。`);
        }
        let sprite: string;
        let prop: CustomProp | undefined;
        if (parsed.prop === "custom") {
          if (params.prop_art !== undefined) {
            const checked = validateCustomProp(params.prop_art);
            if (!checked.ok) return fail(`prop_art 画得不对：${checked.error}；照着原因改好，再调用一次。`);
            prop = checked.prop;
          } else if (!target.prop) {
            return fail("sprite 是 custom 但还没有画过的道具：要给 prop_art（art、pal、dx）画一件。");
          }
          sprite = customSprite((color ?? parsed.color) as ColorId);
        } else {
          if (params.prop_art !== undefined) return fail("sprite 是内置道具时不要传 prop_art；要自画一件就把 sprite 填 custom。");
          sprite = spriteId(parsed.prop, (color ?? parsed.color) as ColorId);
        }
        const next = { ...target, sprite, ...(prop ? { prop } : {}) };
        store.saveAssistant(next);
        bus.emit({ type: "assistant", assistant: runtime.router.summary(next) });
        const desc =
          parsed.prop === "custom"
            ? `自画道具 · ${COLORS[(color ?? parsed.color) as ColorId].name}`
            : `${PROPS[parsed.prop].label} · ${COLORS[(color ?? parsed.color) as ColorId].name}`;
        await note("info", `已换头像 · ${target.name} · ${desc}`);
        return ok(`已换头像。`);
      },
    },
  ];

  if (runtime.settings.settings.general.showPage !== false) tools.push(pageTool(runtime, assistantId, true));

  if (assistant().primary) {
    tools.push(
      overviewTool(runtime),
      {
        name: "propose_assistant",
        label: "提议创建专属助手",
        description:
          "提议创建一个专属助手。会生成一张草稿卡，用户点「创建」后才会真正创建。用于同类任务反复出现时。调用后这一轮就结束了：工具返回后不要再输出任何文字。",
        parameters: Type.Object({
          name: Type.String({ description: "助手名字：职责加一个亲切的昵称，四五个字，如「运维小子」「写稿搭子」「代理管家」；不要只写「代理」「运维」这种光秃秃的词" }),
          duty: Type.String({ description: "左栏头像下面那行小字，最多 8 个字，如「线上和机器」「模型和 agent」" }),
          dutyLong: Type.String({ description: "草稿卡里的职责说明，两三句话，写完整一些" }),
          sprite: Type.String({
            description: `头像：内置道具 id 之一（${PROP_IDS.filter((id) => id !== "hob").join(" ")}），或 custom（同时填 prop_art，自己画一件）`,
          }),
          prop_art: Type.Optional(
            Type.Object(
              {
                art: Type.Array(Type.String(), {
                  description: "最多 16 行，每行恰好 16 个字符；从第 0 行起逐行盖在火苗上，. 表示不动，k 是描边色，其它字符查 pal；不能盖住火苗的两只眼睛",
                }),
                pal: Type.Record(Type.String(), Type.String(), {
                  description: "单个小写字母 → #rrggbb；不能用 o y e（火苗自己的色）和 k（描边固定），最多 6 种",
                }),
                dx: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)], {
                  description: "火苗的横向位置：头顶的道具用 2，手边的用 0 或 1",
                }),
              },
              {
                description:
                  'sprite 为 custom 时要画的那件。例：{ "art": ["....kkkk........", "...khhhhk.......", "....kkkk........"], "pal": { "h": "#ffc21a" }, "dx": 2 }',
              },
            ),
          ),
          routines: Type.Optional(
            Type.Array(
              Type.Object({ name: Type.String(), instruction: Type.String(), schedule: Type.String() }),
              { description: "建议包含的定时任务" },
            ),
          ),
          askFirst: Type.Optional(Type.Array(Type.String(), { description: "执行前需确认的事项" })),
          instructions: Type.Optional(
            Type.Array(Type.String(), { description: "这个助手特有的做法（每项一行，写进新助手的补充说明）" }),
          ),
          conversations: Type.Optional(Type.Integer({ description: "需要迁移的对话段数，默认 0" })),
        }),
        execute: async (_id, params: any) => {
          const checked = params.prop_art !== undefined ? validateCustomProp(params.prop_art) : undefined;
          if (checked && !checked.ok) return fail(`prop_art 画得不对：${checked.error}；照着原因改好，再调用一次。`);
          const given = parseSprite(String(params.sprite ?? ""));
          if (checked?.ok && given && given.prop !== "custom") {
            return fail("sprite 填了内置道具就不要传 prop_art；要自画一件就把 sprite 填 custom。");
          }
          if (given?.prop === "custom" && !checked?.ok) {
            return fail("sprite 是 custom 时要同时给 prop_art（art、pal、dx）画一件。");
          }
          const routinesInput: { name: string; instruction: string; schedule: string }[] =
            params.routines ?? [];
          const taken = store.assistants().map((a) => a.sprite);
          // 自画的存画法（sprite 记成 custom）；内置道具的照旧，和已有助手撞了就换个颜色
          const sprite = checked?.ok ? distinctSprite("custom", taken) : given ? distinctSprite(String(params.sprite), taken) : "page";
          const prop = checked?.ok ? checked.prop : undefined;
          const draft: Draft = {
            id: newId("d-"),
            assistantId,
            status: "pending",
            name: String(params.name),
            sprite,
            ...(prop ? { prop } : {}),
            duty: clampDuty(String(params.duty ?? "")),
            dutyLong: String(params.dutyLong),
            routines: routinesInput,
            routinesText: routinesInput.map((item) => `${item.name} · ${cronToChinese(item.schedule)}`).join("、"),
            askFirst: (params.askFirst as string[]) ?? [],
            instructions: (params.instructions as string[]) ?? [],
            carry: { conversations: Number(params.conversations ?? 0) },
            createdAt: new Date().toISOString(),
          };
          store.saveDraft(draft);
          await router.addItem(assistantId, { kind: "draft", draftId: draft.id });
          bus.emit({ type: "draft", draft });
          return endTurn(
            "草稿卡已显示给用户，卡片里已有名称、职责、定时任务和补充说明。本轮到此结束：不要输出任何文字，不要再描述或总结这张卡。",
          );
        },
      },
      {
        name: "message_assistant",
        label: "转交其他助手",
        description: "把一件事交给更合适的助手去办：对话里会出现一张委派卡，对方的回复和它派出的任务全部结束后，结果会作为一条事件回到这里，你再用一两句话告诉用户。调用后本轮结束，不要再输出文字。",
        parameters: Type.Object({
          assistantId: Type.String({ description: "目标助手 id" }),
          text: Type.String({ description: "要转交的内容" }),
        }),
        execute: async (_id, params: any) => {
          const targetId = String(params.assistantId);
          const target = store.assistant(targetId);
          if (!target) return fail(`没有这个助手：${targetId}`);
          if (targetId === assistantId) return fail("不能转交给自己。");
          try {
            await runtime.delegations.start(targetId, String(params.text));
            return endTurn(`已转交给「${target.name}」，结果会自动回到这里。`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  } else {
    tools.push({
      name: "hand_back_to_hob",
      label: "交回 Hob",
      description: "这件事不在你的职责范围内时，把它交回主助手 Hob，由它转给合适的助手或自己处理。text 写清楚用户要什么，reason 一句话说明为什么不归你。调用后本轮结束，不要再输出文字。",
      parameters: Type.Object({ text: Type.String(), reason: Type.String() }),
      execute: async (_id, params: any) => {
        const text = String(params.text ?? "").trim();
        const reason = String(params.reason ?? "").trim();
        if (!text || !reason) return fail("请写清用户要求和交回原因。");
        try {
          const delegationId = router.currentDelegation(assistantId);
          if (delegationId) {
            runtime.delegations.returnToHob(delegationId, text, reason);
          } else {
            await router.ensure("hob");
            const handbackId = newId("hb-");
            await router.addItem(assistantId, { kind: "note", icon: "info", text: `已交回 Hob：${reason}`, handbackId });
            await router.addForwarded("hob", text, handbackId, assistantId);
            await router.event("hob", `转自「${assistant().name}」：${text}\n交回原因：${reason}`);
          }
          return endTurn("已交回 Hob，本轮结束，不要再输出文字。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    });
  }

  tools.push(...searchTools(runtime.home, () => runtime.settings.settings.search));
  return tools;
}

export type { Routine };
