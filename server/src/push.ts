// HOB_HOME/system/push.json：VAPID 密钥 + 订阅设备（0600、原子写）。推送走 web-push。
import { t } from "../../shared/i18n.ts";
import { plainText } from "../../shared/plain-text.ts";
import { conversationTarget } from "../../shared/push-target.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Approval, Place, PushDevice, PushSubscriptionJson, PushView } from "../../shared/types.ts";
import { systemDir } from "./config.ts";
import { placeOf } from "./place.ts";
import type { Store } from "./store.ts";

const requirePush = createRequire(import.meta.url);
const webpush = requirePush("web-push") as typeof import("web-push");

const FILE = "push.json";

/** 一条订阅在磁盘上的样子（密钥只在这里）。 */
interface DeviceRecord extends PushDevice {
  p256dh: string;
  auth: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushFile {
  vapid: VapidKeys;
  devices: DeviceRecord[];
}

/** 发给浏览器的那条通知（sw.js 的 push 事件照这个解）。 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 真正发出去的一步；测试注入假的，不碰网络。 */
export type PushSender = (
  target: PushTarget,
  payload: string,
  vapid: VapidKeys & { subject: string },
) => Promise<void>;

const PUSH_TIMEOUT_MS = 15_000;
const PUSH_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TRANSIENT_NAMES = new Set(["TimeoutError", "AbortError"]);
const TRANSIENT_MESSAGE = /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|fetch failed/i;

/** 用 web-push 加密并签发 VAPID，再经全局 fetch 发送，复用 undici 全局代理与超时控制。 */
export function createWebPushSender(fetchImpl?: typeof fetch): PushSender {
  return async (target, payload, vapid) => {
    const details = webpush.generateRequestDetails(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payload,
      { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } },
    );
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(details.headers ?? {})) {
      if (key.toLowerCase() === "content-length" || value === undefined) continue;
      headers[key] = String(value);
    }
    const response = await (fetchImpl ?? globalThis.fetch)(details.endpoint, {
      method: details.method,
      headers,
      body: details.body ? new Uint8Array(details.body) : undefined,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(`Received unexpected response code ${response.status}`) as Error & {
        statusCode: number;
        body: string;
      };
      error.statusCode = response.status;
      error.body = body;
      throw error;
    }
  };
}

export interface PushResult {
  sent: number;
  removed: number; // 订阅已失效（404/410、密钥对不上）被删掉的条数
  skipped?: "visible" | "no-devices"; // 没发的原因
  error?: string; // 发送失败的原因（几台都失败时取第一台）
}

/** 没填邮箱时的 VAPID subject：Apple 不认 mailto:…@localhost（回 403 BadJwtToken） */
const DEFAULT_SUBJECT = "https://github.com/FFatTiger/hob";

export interface PushServiceOptions {
  home: string;
  /** 设置 → 通知里填的邮箱（VAPID subject 用） */
  email: () => string;
  sender?: PushSender;
  retryDelaysMs?: readonly number[];
}

function isVapid(value: unknown): value is VapidKeys {
  const keys = value as Partial<VapidKeys> | undefined;
  return typeof keys?.publicKey === "string" && !!keys.publicKey && typeof keys.privateKey === "string" && !!keys.privateKey;
}

function isDevice(value: unknown): value is DeviceRecord {
  const device = value as Partial<DeviceRecord> | undefined;
  return (
    typeof device?.endpoint === "string" &&
    !!device.endpoint &&
    typeof device.p256dh === "string" &&
    typeof device.auth === "string" &&
    typeof device.label === "string" &&
    typeof device.createdAt === "string"
  );
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/** 推送服务回的原因：Apple 是 {"reason":"…"}，其他服务给一段文字 */
function reasonOf(error: unknown): string {
  const body = (error as { body?: unknown })?.body;
  if (typeof body !== "string" || !body.trim()) return "";
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  } catch {
    // 不是 JSON 就用原文
  }
  return body.trim().slice(0, 120);
}

/** 订阅已经用不了：没了（404/410），或是用旧的 VAPID 密钥订的（HOB_HOME 重置过） */
function isGone(status: number | undefined, reason: string): boolean {
  return status === 404 || status === 410 || (status === 400 && reason === "VapidPkHashMismatch");
}

/** 仅重试瞬断网络错误、429 与 5xx；4xx 与失效订阅绝不重试。 */
function isTransient(error: unknown, status: number | undefined): boolean {
  if (status !== undefined) return status === 429 || status >= 500;
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const item = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof item.code === "string" && TRANSIENT_CODES.has(item.code)) return true;
    if (typeof item.name === "string" && TRANSIENT_NAMES.has(item.name)) return true;
    if (typeof item.message === "string" && TRANSIENT_MESSAGE.test(item.message)) return true;
    current = item.cause;
  }
  return false;
}

function describeFailure(error: unknown, status: number | undefined, reason: string): string {
  if (status) return t("推送服务拒绝（{status}{reason}）", { status, reason: reason ? ` ${reason}` : "" });
  return t("无法连接推送服务（{reason}）", { reason: error instanceof Error ? error.message : String(error) });
}

interface ClientViewState {
  visible: boolean;
  /** null 表示前台但未在看具体对话；"*" 表示未传 target 的旧版客户端（向后兼容） */
  target: string | null | "*";
}

/** 推送服务（可见性只在内存里：进程重启后没有前台客户端）。 */
export class PushService {
  private data?: PushFile;
  private readonly sender: PushSender;
  /** 每个页面客户端的可见状态；SSE 连接断了就删掉这一项 */
  private readonly clientViews = new Map<string, ClientViewState>();
  /** clientId → 还连着几条 SSE（重连时旧的断开不会把新的状态清掉） */
  private readonly clients = new Map<string, number>();

  constructor(private readonly options: PushServiceOptions) {
    this.sender = options.sender ?? createWebPushSender();
  }

  private file(): string {
    return join(systemDir(this.options.home), FILE);
  }

  /** 读磁盘；文件没有就生成 VAPID 密钥，坏的订阅丢掉。 */
  private load(): PushFile {
    if (this.data) return this.data;
    let stored: Partial<PushFile> = {};
    if (existsSync(this.file())) {
      try {
        stored = JSON.parse(readFileSync(this.file(), "utf8")) as Partial<PushFile>;
      } catch (error) {
        throw new Error(`读取 ${this.file()} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    const vapid = isVapid(stored.vapid) ? stored.vapid : webpush.generateVAPIDKeys();
    const devices = Array.isArray(stored.devices) ? stored.devices.filter(isDevice) : [];
    this.data = { vapid, devices };
    this.write();
    return this.data;
  }

  private write(): void {
    const path = this.file();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  private subject(): string {
    const email = this.options.email().trim();
    return email ? `mailto:${email}` : DEFAULT_SUBJECT;
  }

  view(): PushView {
    const file = this.load();
    return {
      publicKey: file.vapid.publicKey,
      email: this.options.email().trim(),
      devices: file.devices.map(({ endpoint, label, createdAt }) => ({ endpoint, label, createdAt })).reverse(),
    };
  }

  subscribe(subscription: PushSubscriptionJson, label: string): PushDevice {
    const endpoint = typeof subscription?.endpoint === "string" ? subscription.endpoint.trim() : "";
    const p256dh = typeof subscription?.keys?.p256dh === "string" ? subscription.keys.p256dh : "";
    const auth = typeof subscription?.keys?.auth === "string" ? subscription.keys.auth : "";
    if (!endpoint || !p256dh || !auth) throw new Error("订阅信息不完整：缺 endpoint 或 keys");
    const file = this.load();
    const name = label.trim().slice(0, 40) || "本机";
    const existing = file.devices.find((device) => device.endpoint === endpoint);
    const device: DeviceRecord = {
      endpoint,
      p256dh,
      auth,
      label: name,
      // 同一台重新订阅：保留第一次的时间，只更新名称和密钥
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    file.devices = [...file.devices.filter((item) => item.endpoint !== endpoint), device];
    this.write();
    return { endpoint: device.endpoint, label: device.label, createdAt: device.createdAt };
  }

  unsubscribe(endpoint: string): boolean {
    const file = this.load();
    const before = file.devices.length;
    file.devices = file.devices.filter((device) => device.endpoint !== endpoint);
    if (file.devices.length === before) return false;
    this.write();
    return true;
  }

  /** 页面客户端上报可见性与当前查看的会话（只存内存）；不传 target 视为旧版客户端（全局可见）。 */
  setVisibility(clientId: string, visible: boolean, target?: string | null): void {
    if (!clientId) return;
    this.clientViews.set(clientId, { visible, target: target === undefined ? "*" : target });
  }

  /** SSE 连上：记一条连接，断开时把可见性一起清掉（没法确认还在看就是不在看）。 */
  attachClient(clientId: string): () => void {
    if (!clientId) return () => undefined;
    this.clients.set(clientId, (this.clients.get(clientId) ?? 0) + 1);
    return () => {
      const left = (this.clients.get(clientId) ?? 1) - 1;
      if (left > 0) {
        this.clients.set(clientId, left);
        return;
      }
      this.clients.delete(clientId);
      this.clientViews.delete(clientId);
    };
  }

  /** 只有客户端正聚焦看着对应对话（或兼容未报 target 的旧客户端）才静默推送。 */
  hasVisible(target?: string): boolean {
    for (const view of this.clientViews.values()) {
      if (!view.visible) continue;
      if (view.target === "*" || !target || view.target === target) return true;
    }
    return false;
  }

  private async sendWithRetry(
    target: PushTarget,
    body: string,
    vapid: VapidKeys & { subject: string },
  ): Promise<void> {
    const delays = this.options.retryDelaysMs ?? PUSH_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.sender(target, body, vapid);
        return;
      } catch (error) {
        const status = statusOf(error);
        const reason = reasonOf(error);
        if (isGone(status, reason) || !isTransient(error, status) || attempt >= delays.length) throw error;
        const delay = delays[attempt] ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async deliver(devices: DeviceRecord[], payload: PushPayload): Promise<PushResult> {
    const file = this.load();
    const body = JSON.stringify(payload);
    const vapid = { ...file.vapid, subject: this.subject() };
    const gone: string[] = [];
    const failures: string[] = [];
    let sent = 0;
    await Promise.all(
      devices.map(async (device) => {
        try {
          await this.sendWithRetry(
            { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
            body,
            vapid,
          );
          sent += 1;
        } catch (error) {
          // 订阅没了（卸载了 PWA、清过数据）或密钥对不上：删掉，别一直发空；其他失败如实报出去
          const status = statusOf(error);
          const reason = reasonOf(error);
          if (isGone(status, reason)) gone.push(device.endpoint);
          else {
            const failure = describeFailure(error, status, reason);
            console.error(`推送到「${device.label}」失败：${failure}`);
            failures.push(failure);
          }
        }
      }),
    );
    if (gone.length) {
      file.devices = file.devices.filter((device) => !gone.includes(device.endpoint));
      this.write();
    }
    return { sent, removed: gone.length, ...(failures.length ? { error: failures[0] } : {}) };
  }

  /** 该推的时候推：目标对话正被某个客户端聚焦查看、或一台设备都没订阅就不发。 */
  async send(payload: PushPayload, target?: string): Promise<PushResult> {
    if (this.hasVisible(target)) return { sent: 0, removed: 0, skipped: "visible" };
    const devices = this.load().devices;
    if (!devices.length) return { sent: 0, removed: 0, skipped: "no-devices" };
    return this.deliver(devices, payload);
  }

  /** 设置页的「发一条测试」：不看可见性，只发指定设备（不给就发全部）。 */
  async test(endpoint?: string): Promise<PushResult> {
    const devices = this.load().devices;
    const targets = endpoint ? devices.filter((device) => device.endpoint === endpoint) : devices;
    if (!targets.length) return { sent: 0, removed: 0, skipped: "no-devices" };
    return this.deliver(targets, { title: "Hob", body: t("测试通知：收到此消息说明推送功能正常。"), url: "/" });
  }
}

/** 该推送的子集：只用到这一个方法（测试可以直接给假对象）。 */
export interface PushSink {
  send(payload: PushPayload, target?: string): Promise<PushResult>;
}

export interface NotifyDeps {
  push: PushSink;
  store: Store;
}

/** 一轮结束后通知助手：完成通知和失败通知共用这一条入口。 */
export interface AssistantTurnEnd {
  assistantId: string;
  place?: Place;
  text?: string;
  error?: string;
}

/** 点开推送去哪：群里提的问题、群里开的任务去群聊页，助手话题去对应话题页，其余去这个助手的单聊/主对话。 */
function openUrl(assistantId: string, place?: Place): string {
  if (place?.groupId) return `/#/group/${encodeURIComponent(place.groupId)}`;
  if (place?.topicId) return `/#/chat/${encodeURIComponent(assistantId)}/topic/${encodeURIComponent(place.topicId)}`;
  return `/?a=${encodeURIComponent(assistantId)}`;
}

/** 规范化会话目标标识，与前端上报的 ClientVisibility.target 共用 shared/push-target.ts。 */
export function pushTarget(assistantId: string, place?: Place): string {
  return conversationTarget(assistantId, place);
}

function pushConversationTitle(store: Store, assistantId: string, assistantName: string, place?: Place): string {
  if (place?.groupId) return store.group(place.groupId)?.name ?? assistantName;
  if (place?.topicId) {
    const topic = store.assistantTopic(assistantId, place.topicId);
    if (topic) return `${assistantName} · ${topic.name}`;
  }
  return assistantName;
}

/** 一轮结束后推送；是否需要推送由 Router 按本轮面向用户状态与分派任务/已推标记判断。 */
export function pushAssistantTurnEnd(deps: NotifyDeps, turn: AssistantTurnEnd): void {
  const assistant = deps.store.assistant(turn.assistantId);
  if (!assistant?.notify) return;
  const title = pushConversationTitle(deps.store, turn.assistantId, assistant.name, turn.place);
  const body = turn.error
    ? t("执行失败：{reason}", { reason: plainText(turn.error) })
    : turn.text?.trim()
      ? plainText(turn.text).replace(/\s+/g, " ").slice(0, 160)
      : t("已完成");
  void deps.push
    .send({ title, body, url: openUrl(turn.assistantId, turn.place) }, pushTarget(turn.assistantId, turn.place))
    .catch(() => undefined);
}

/** 交互卡片推送参数。 */
export interface InteractiveCardPush {
  assistantId: string;
  place?: Place;
  title?: string;
}

/** 交互卡片（含按钮/表单/选择器等）：这个助手开了通知就推送一条「等待你的操作」。 */
export function pushInteractiveCard(deps: NotifyDeps, card: InteractiveCardPush): void {
  const assistant = deps.store.assistant(card.assistantId);
  if (!assistant?.notify) return;
  const title = card.title?.trim()
    ? plainText(card.title)
    : pushConversationTitle(deps.store, card.assistantId, assistant.name, card.place);
  void deps.push
    .send(
      { title, body: t("{assistant} · 等待你的操作", { assistant: assistant.name }), url: openUrl(card.assistantId, card.place) },
      pushTarget(card.assistantId, card.place),
    )
    .catch(() => undefined);
}

/** 出审批：这个助手开了「需要我回答或做完时通知我」才推送。 */
export function pushApproval(deps: NotifyDeps, approval: Approval): void {
  const assistant = deps.store.assistant(approval.assistantId);
  if (!assistant?.notify) return;
  const place = placeOf(approval);
  // 推送失败不能影响审批本身（也不能变成未处理的 rejection 把进程带走）
  // 推送的标题是卡片标题（一张卡可能问几个问题），正文写谁在等、等什么
  void deps.push
    .send(
      { title: plainText(approval.title), body: t("{assistant} · 等待你的回答", { assistant: assistant.name }), url: openUrl(approval.assistantId, place) },
      pushTarget(approval.assistantId, place),
    )
    .catch(() => undefined);
}
