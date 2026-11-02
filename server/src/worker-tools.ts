import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalOption } from "../../shared/types.ts";
import { generateImage } from "./image.ts";
import type { HobRuntime } from "./runtime.ts";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Worker 的收尾工具：必须调用一次提交结果。 */
export function registerReportTool(runtime: HobRuntime, jobId: string): ToolDefinition<any, any> {
  return {
    name: "report",
    label: "提交结果",
    description:
      "任务结束时必须调用一次，提交结果。summary 用中文写给用户：一两句结论 + 关键数字，不要罗列过程。",
    promptSnippet: "任务结束必须调用 report 提交结果。",
    parameters: Type.Object({
      outcome: Type.Unsafe<"done" | "stuck" | "need_approval">(
        Type.String({ description: "done 已完成 / stuck 受阻 / need_approval 待确认" }),
      ),
      summary: Type.String({ description: "中文摘要，一两句结论 + 关键数字，不超过 600 字" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "产出文件的绝对路径" })),
    }),
    execute: async (_id, params: any) => {
      // 不认识的结果不能当成已完成：退回让模型重新调用
      if (params.outcome !== "done" && params.outcome !== "stuck" && params.outcome !== "need_approval") {
        return {
          content: [{ type: "text" as const, text: "outcome 只能是 done、stuck 或 need_approval，请重新调用 report。" }],
          details: undefined,
          isError: true,
        };
      }
      runtime.jobs.reportFromTool(jobId, {
        outcome: params.outcome,
        summary: String(params.summary ?? ""),
        ...(Array.isArray(params.files) && params.files.length ? { files: params.files as string[] } : {}),
      });
      return ok("结果已记录。");
    },
  };
}

/** Worker 的询问工具：阻塞等待用户选择一个选项。 */
export function registerAskTool(runtime: HobRuntime, jobId: string): ToolDefinition<any, any> {
  return {
    name: "ask_user",
    label: "询问用户",
    description: "遇到规则要求执行前确认、或者不可逆的操作时，用这个询问用户，会一直等到用户选择。返回用户选择的选项文字。",
    promptSnippet: "规则要求执行前确认的事，执行前必须调用 ask_user。",
    parameters: Type.Object({
      title: Type.String({ description: "问题，一句话" }),
      detail: Type.Optional(Type.String({ description: "补充说明，写清后果" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "选项文字" }),
          always: Type.Optional(Type.Boolean({ description: "选中后将这句话记为规则" })),
        }),
        { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
      ),
      ruleText: Type.Optional(Type.String({ description: "always 选项要写进规则的文字" })),
    }),
    execute: async (_id, params: any) => {
      const labels: { label: string; always?: boolean }[] = Array.isArray(params.options) ? params.options : [];
      if (labels.length < 2 || labels.length > 3) {
        return { content: [{ type: "text" as const, text: "选项要 2 到 3 个。" }], details: undefined, isError: true };
      }
      const options: ApprovalOption[] = labels.map((option, index) => ({
        key: (["A", "B", "C"] as const)[index],
        label: String(option.label),
        ...(option.always ? { always: true } : {}),
      }));
      const answer = await runtime.jobs.askQuestion(jobId, {
        title: String(params.title),
        ...(params.detail ? { detail: String(params.detail) } : {}),
        options,
        ...(params.ruleText ? { ruleText: String(params.ruleText) } : {}),
      });
      // 用户可能没选给出的选项，而是自己写了一段：answer 已经是回给模型的整句
      return ok(answer);
    },
  };
}

/** Worker 的图像生成工具：只在配了图像生成、且这个助手开着这项能力时才注册。 */
export function registerImageTool(runtime: HobRuntime, jobId: string): ToolDefinition<any, any> {
  return {
    name: "generate_image",
    label: "生成图片",
    description:
      "按文字描述生成一张图片，返回图片的绝对路径（存在任务工作目录）。要把图给用户看，就把这个路径放进 report 的 files。",
    promptSnippet: "生成图片用 generate_image；要给用户看就把它放进 report 的 files。",
    parameters: Type.Object({
      prompt: Type.String({ description: "要画什么，越具体越好" }),
      size: Type.Optional(
        Type.String({ description: "尺寸，如 1024x1024；不填用设置里的默认（有的模型不支持，会忽略）" }),
      ),
      refs: Type.Optional(
        Type.Array(Type.String(), { description: "参考图的绝对路径（改图、按图生成的时候给）" }),
      ),
    }),
    execute: async (_id, params: any) => {
      const job = runtime.store.job(jobId);
      if (!job) return { content: [{ type: "text" as const, text: "任务不存在。" }], details: undefined, isError: true };
      try {
        const path = await generateImage(
          {
            home: runtime.home,
            dir: job.cwd ?? runtime.store.workDir(jobId),
            config: runtime.settings.settings.image,
          },
          {
            prompt: String(params.prompt ?? ""),
            ...(params.size ? { size: String(params.size) } : {}),
            ...(Array.isArray(params.refs) && params.refs.length ? { refs: params.refs.map(String) } : {}),
          },
        );
        return ok(`图片已生成：${path}`);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}
