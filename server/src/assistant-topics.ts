import { rmSync } from "node:fs";
import type { Assistant, AssistantTopic, AssistantTopicSummary, Item, ModelPick, Place, TopicConfigView } from "../../shared/types.ts";
import { t } from "../../shared/i18n.ts";
import { plainText } from "../../shared/plain-text.ts";
import { assistantTopicDir, assistantTopicTodosPath } from "./config.ts";
import { newId } from "./ids.ts";
import { isValidTopicId } from "./place.ts";
import { allowedRefs, assistantTopicModelPick, checkAssistantModels, followUpPick } from "./models.ts";
import type { HobRuntime } from "./runtime.ts";
import type { Store } from "./store.ts";
import { clearTodos, readTodos } from "./todos.ts";
import { hiddenRules as topicHiddenRules, patchOverrides } from "./topic-config.ts";
import { textOfContent } from "./transcript.ts";
import { CWD_IMMUTABLE, normalizeWorkspaceCwdInput, resolveWorkspaceCwd, topicCwdLockedByAssistant, validateWorkspaceCwd } from "./workspace.ts";

export const MAX_ASSISTANT_TOPIC_TITLE = 40;
const AUTO_FALLBACK_TITLE_CHARS = 20;
const AUTO_MODEL_TITLE_CHARS = 12;

export class TopicError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

export function assertAssistantTopic(store: Store, aid: string, tid: string): AssistantTopic {
  if (!isValidTopicId(tid)) throw new TopicError("话题不存在", 404);
  const topic = store.assistantTopic(aid, tid);
  if (!topic || topic.assistantId !== aid || topic.id !== tid) throw new TopicError("话题不存在", 404);
  return topic;
}

export interface CreateAssistantTopicInput {
  title?: unknown;
  cwd?: unknown;
  text?: unknown;
  quote?: unknown;
  files?: unknown;
  createdBy?: string;
}

export interface CreateAssistantTopicResult {
  topic: AssistantTopicSummary;
  item?: Item;
}

function initialTopicName(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const cleaned = plainText(firstLine);
  if (!cleaned) return t("新话题");
  const chars = [...cleaned];
  return chars.length > AUTO_FALLBACK_TITLE_CHARS
    ? `${chars.slice(0, AUTO_FALLBACK_TITLE_CHARS).join("")}…`
    : cleaned;
}

function cleanGeneratedTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const cleaned = plainText(firstLine).replace(/^[「『"“'‘]+|[」』"”'’。.!！?？]+$/g, "").trim();
  if (!cleaned) return "";
  const chars = [...cleaned];
  return chars.length > AUTO_MODEL_TITLE_CHARS ? chars.slice(0, AUTO_MODEL_TITLE_CHARS).join("") : cleaned;
}

/**
 * 助手话题的创建、改名、关闭、重开与摘要发布。
 * 与主对话和群话题隔离，不涉及话题配置覆盖层和路由工具。
 */
export class AssistantTopicManager {
  constructor(private readonly runtime: HobRuntime) {}

  private get store() {
    return this.runtime.store;
  }

  private get bus() {
    return this.runtime.bus;
  }

  requireAssistant(aid: string): Assistant {
    const assistant = this.store.assistant(aid);
    if (!assistant) throw new TopicError("助手不存在", 404);
    return assistant;
  }

  requireTopic(aid: string, tid: string): AssistantTopic {
    this.requireAssistant(aid);
    return assertAssistantTopic(this.store, aid, tid);
  }

  private validateTitle(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw new TopicError("话题名不能为空", 400);
    const trimmed = value.trim();
    const count = [...trimmed].length;
    if (count > MAX_ASSISTANT_TOPIC_TITLE) {
      throw new TopicError(`话题名最多 ${MAX_ASSISTANT_TOPIC_TITLE} 字（现在 ${count} 字）`, 400);
    }
    return trimmed;
  }

  summaryOf(topic: AssistantTopic): AssistantTopicSummary {
    const place: Place = { topicId: topic.id };
    const last = this.runtime.router.last(topic.assistantId, place);
    const suggestions = this.runtime.router.suggestionsFor(topic.assistantId, place);
    return {
      ...topic,
      ...(last ? { last } : {}),
      unread: this.runtime.router.unread(topic.assistantId, place),
      busy: this.runtime.router.isBusy(topic.assistantId, place),
      activity: this.runtime.router.activityOf(topic.assistantId, place),
      todos: readTodos(assistantTopicTodosPath(this.runtime.home, topic.assistantId, topic.id)),
      ...(suggestions?.length ? { suggestions } : {}),
    };
  }

  summary(aid: string, tid: string): AssistantTopicSummary {
    return this.summaryOf(this.requireTopic(aid, tid));
  }

  list(aid: string): AssistantTopicSummary[] {
    this.requireAssistant(aid);
    return this.store
      .assistantTopics(aid)
      .map((topic) => this.summaryOf(topic))
      .sort((a, b) => (b.last?.at ?? b.createdAt).localeCompare(a.last?.at ?? a.createdAt));
  }

  allSummaries(): AssistantTopicSummary[] {
    return this.store
      .assistants()
      .flatMap((assistant) => this.store.assistantTopics(assistant.id).map((topic) => this.summaryOf(topic)))
      .sort((a, b) => (b.last?.at ?? b.createdAt).localeCompare(a.last?.at ?? a.createdAt));
  }

  publish(aid: string, tid: string): void {
    if (!isValidTopicId(tid)) return;
    const assistant = this.store.assistant(aid);
    if (!assistant) return;
    const topic = this.store.assistantTopic(aid, tid);
    if (!topic || topic.assistantId !== aid || topic.id !== tid) return;
    this.bus.emit({ type: "assistant_topic", topic: this.summaryOf(topic) });
  }

  async create(aid: string, input: CreateAssistantTopicInput): Promise<CreateAssistantTopicResult> {
    const assistant = this.requireAssistant(aid);
    if (!assistant.topics) {
      throw new TopicError("这个助手是单会话模式，先在助手设置里改成多话题", 400);
    }

    let cwd: string | undefined;
    try {
      const normalizedCwd = normalizeWorkspaceCwdInput(input.cwd);
      if (!assistant.primary && assistant.cwd) {
        if (normalizedCwd) throw new TopicError(topicCwdLockedByAssistant(assistant.cwd), 400);
      } else if (normalizedCwd) {
        cwd = validateWorkspaceCwd(normalizedCwd, this.runtime.home);
      }
    } catch (error) {
      if (error instanceof TopicError) throw error;
      throw new TopicError(error instanceof Error ? error.message : String(error), 400);
    }

    if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
      throw new TopicError("话题名必须是文字", 400);
    }
    const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const files = Array.isArray(input.files) ? input.files.filter((path): path is string => typeof path === "string" && !!path) : [];
    const rawQuote = input.quote as { itemId?: unknown; text?: unknown } | undefined;
    if (rawQuote !== undefined && (typeof rawQuote?.itemId !== "string" || typeof rawQuote?.text !== "string")) {
      throw new TopicError("引用的消息无效：要 itemId 和 text", 400);
    }
    const quote = rawQuote ? { itemId: rawQuote.itemId as string, text: rawQuote.text as string } : undefined;

    let name: string;
    let nameAuto: true | undefined;
    if (rawTitle) {
      name = this.validateTitle(rawTitle);
    } else {
      name = initialTopicName(text);
      nameAuto = true;
    }

    const topic: AssistantTopic = {
      id: newId("tp-"),
      assistantId: aid,
      name,
      ...(nameAuto ? { nameAuto } : {}),
      ...(cwd ? { cwd } : {}),
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? "user",
    };
    this.store.saveAssistantTopic(topic);

    if (text || files.length) {
      // 先初始化 topic 的 readAt，确保随后到来的首条助手回复能正确计入未读
      this.summaryOf(topic);
      try {
        const item = await this.runtime.router.send(
          aid,
          {
            text,
            ...(quote ? { quote } : {}),
            ...(files.length ? { files } : {}),
          },
          { topicId: topic.id },
        );
        const summary = this.summaryOf(topic);
        this.bus.emit({ type: "assistant_topic", topic: summary });
        if (nameAuto && text) {
          void this.autoName(aid, topic.id, text).catch(() => undefined);
        }
        return { topic: summary, item };
      } catch (error) {
        this.runtime.router.forgetSession(aid, { topicId: topic.id });
        rmSync(assistantTopicDir(this.runtime.home, aid, topic.id), { recursive: true, force: true });
        throw error;
      }
    }

    const summary = this.summaryOf(topic);
    this.bus.emit({ type: "assistant_topic", topic: summary });
    return { topic: summary };
  }

  private async autoName(aid: string, tid: string, text: string): Promise<void> {
    const assistant = this.store.assistant(aid);
    if (!assistant) return;
    await this.runtime.models.get();
    const pick = followUpPick(this.runtime.settings.settings.models, assistant, this.runtime.models);
    if (!pick) return;
    const model = await this.runtime.pi.model(pick.ref);
    const piRuntime = await this.runtime.pi.runtime();
    const response = await piRuntime.completeSimple(
      model,
      {
        systemPrompt: "根据用户的第一条消息起一个简短的话题标题，用用户说话的语言写，不超过 12 个字。只输出标题本身，不加引号、句号或多余解释。",
        messages: [{ role: "user", content: text.slice(0, 1000), timestamp: Date.now() }],
      },
      {
        reasoning: "off",
        maxTokens: 64,
        signal: AbortSignal.timeout(15_000),
        disableContinuation: true,
      } as unknown as Parameters<typeof piRuntime.completeSimple>[2],
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") return;
    const generated = cleanGeneratedTitle(textOfContent(response.content));
    if (!generated) return;
    let latest: AssistantTopic | undefined;
    try {
      latest = this.store.assistantTopic(aid, tid);
    } catch {
      return;
    }
    if (!latest || latest.assistantId !== aid || latest.id !== tid || !latest.nameAuto) return;
    const next: AssistantTopic = { ...latest, name: generated };
    this.store.saveAssistantTopic(next);
    this.publish(aid, tid);
  }

  rename(aid: string, tid: string, title: unknown): AssistantTopicSummary {
    const topic = this.requireTopic(aid, tid);
    const name = this.validateTitle(title);
    const { nameAuto: _auto, ...rest } = topic;
    const next: AssistantTopic = { ...rest, name };
    this.store.saveAssistantTopic(next);
    const summary = this.summaryOf(next);
    this.bus.emit({ type: "assistant_topic", topic: summary });
    return summary;
  }

  close(aid: string, tid: string, note?: unknown): AssistantTopicSummary {
    const topic = this.requireTopic(aid, tid);
    const hasNote = note !== undefined;
    const text = typeof note === "string" ? note.trim() : "";
    const { closeNote: _oldNote, ...base } = topic;
    const nextCloseNote = hasNote ? (text || undefined) : topic.closedAt ? topic.closeNote : undefined;
    const next: AssistantTopic = {
      ...base,
      closedAt: topic.closedAt ?? new Date().toISOString(),
      ...(nextCloseNote ? { closeNote: nextCloseNote } : {}),
    };
    this.store.saveAssistantTopic(next);
    const todosPath = assistantTopicTodosPath(this.runtime.home, aid, tid);
    if (readTodos(todosPath).length) clearTodos(todosPath);
    const summary = this.summaryOf(next);
    this.bus.emit({ type: "assistant_topic", topic: summary });
    return summary;
  }

  reopen(aid: string, tid: string): AssistantTopicSummary {
    const topic = this.requireTopic(aid, tid);
    const { closedAt: _closedAt, closeNote: _closeNote, ...rest } = topic;
    this.store.saveAssistantTopic(rest);
    const summary = this.summaryOf(rest);
    this.bus.emit({ type: "assistant_topic", topic: summary });
    return summary;
  }

  async configView(aid: string, tid: string): Promise<TopicConfigView> {
    const assistant = this.requireAssistant(aid);
    const topic = this.requireTopic(aid, tid);
    await this.runtime.models.get();
    const settings = this.runtime.settings.settings.models;
    const ws = resolveWorkspaceCwd(this.store, this.runtime.home, aid, { topicId: tid });
    const cwd = ws.bound && ws.source !== "default" ? { path: ws.bound, source: ws.source } : undefined;
    return {
      rules: this.store.topicRules(aid, tid),
      hiddenRules: topicHiddenRules(this.store.rules(aid), this.store.assistantTopicRuleOverrides(aid, tid)),
      models: {
        conversation: assistantTopicModelPick(assistant, topic, this.runtime.models, settings, "conversation"),
        work: assistantTopicModelPick(assistant, topic, this.runtime.models, settings, "work"),
      },
      ...(cwd ? { cwd } : {}),
    };
  }

  async updateConfig(aid: string, tid: string, body: unknown): Promise<TopicConfigView> {
    const assistant = this.requireAssistant(aid);
    this.requireTopic(aid, tid);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TopicError("模型设置无效", 400);
    }
    const input = body as Record<string, unknown>;
    if (input.cwd !== undefined) throw new TopicError(CWD_IMMUTABLE, 400);
    if (input.models !== undefined) {
      if (!input.models || typeof input.models !== "object" || Array.isArray(input.models)) {
        throw new TopicError("模型设置无效", 400);
      }
      const modelsInput = input.models as Record<string, unknown>;
      for (const key of Object.keys(modelsInput)) {
        if (key !== "conversation" && key !== "work") throw new TopicError("模型设置无效", 400);
      }
      await this.runtime.models.get();
      const roster = this.runtime.settings.settings.models.roster;
      const allowed = allowedRefs(roster, assistant);
      const parsed: { conversation?: ModelPick | null; work?: ModelPick | null } = {};
      for (const key of ["conversation", "work"] as const) {
        if (!(key in modelsInput)) continue;
        const val = modelsInput[key];
        if (val === null) {
          parsed[key] = null;
          continue;
        }
        if (!val || typeof val !== "object" || Array.isArray(val)) {
          throw new TopicError("模型设置无效", 400);
        }
        let checked: ModelPick | undefined;
        try {
          checked = checkAssistantModels({ models: { [key]: val as ModelPick } }, roster, this.runtime.models).models?.[key];
        } catch (error) {
          throw new TopicError(error instanceof Error ? error.message : String(error), 400);
        }
        if (!checked) throw new TopicError("模型设置无效", 400);
        if (key === "work" && !allowed.includes(checked.ref)) {
          throw new TopicError(`模型 ${checked.ref} 不在可分派的模型列表中。`, 400);
        }
        parsed[key] = checked;
      }
      if ("conversation" in parsed || "work" in parsed) {
        patchOverrides(this.store.assistantTopicConfigHost(aid, tid), { models: parsed });
        this.runtime.router.releaseSession(aid, { topicId: tid });
        this.publish(aid, tid);
      }
    }
    return this.configView(aid, tid);
  }
}
