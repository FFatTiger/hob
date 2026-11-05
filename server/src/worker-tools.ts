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
    description: "任务结束时调用一次，提交结果。",
    promptSnippet: "任务结束必须调用 report 提交结果。",
    parameters: Type.Object({
      outcome: Type.Unsafe<"done" | "stuck" | "need_approval">(
        Type.String({ description: "done 做完 / stuck 做不下去（写明缺什么）/ need_approval 需要用户拍板" }),
      ),
      result: Type.String({ description: "完整结果：结论、数据、链接、文件路径；写给派活的助手。" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "要给用户看的文件（绝对路径）" })),
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
        result: String(params.result ?? ""),
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
    description: "在对话里出选择题卡片（2 到 3 个选项），等用户选，返回用户的选择。用于用户定的规则要求先确认的事，或发送、删除、付费这类撤不回的事。",
    promptSnippet: "规则要求执行前确认的事，执行前必须调用 ask_user。",
    parameters: Type.Object({
      title: Type.String({ description: "问题，一句话" }),
      detail: Type.Optional(Type.String({ description: "补充说明，写清后果" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "选项文字" }),
        }),
        { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
      ),
      remember: Type.Optional(Type.String({ description: "同类事以后可以不再问时，填这类事的简称（如「清理临时目录」）；卡片会多一个「以后直接做」的选项。" })),
    }),
    execute: async (_id, params: any) => {
      const labels: { label: string }[] = Array.isArray(params.options) ? params.options : [];
      if (labels.length < 2 || labels.length > 3) {
        return { content: [{ type: "text" as const, text: "选项要 2 到 3 个。" }], details: undefined, isError: true };
      }
      const remember = typeof params.remember === "string" ? params.remember.trim() : "";
      if (remember && labels.length > 2) {
        return { content: [{ type: "text" as const, text: "带 remember 时最多给 2 个选项。" }], details: undefined, isError: true };
      }
      const options: ApprovalOption[] = labels.map((option, index) => ({
        key: (["A", "B", "C"] as const)[index],
        label: String(option.label),
      }));
      if (remember) options.push({ key: "C", label: `以后「${remember}」直接做`, always: true });
      const answer = await runtime.jobs.askQuestion(jobId, {
        title: String(params.title),
        ...(params.detail ? { detail: String(params.detail) } : {}),
        options,
        ...(remember ? { ruleText: remember } : {}),
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
