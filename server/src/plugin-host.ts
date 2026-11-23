import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSecrets } from "./secrets.ts";
import { pluginOAuthLoggedIn, pluginOAuthNeedsRelogin, pluginOAuthProvider, type PluginOAuthConfig } from "./plugin-oauth.ts";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { McpAuthRequiredError, McpClient, McpHttpError, StdioTransport, StreamableHttpTransport, limitMcpContent, normalizeMcpInputSchema, toLlmContent, validateMcpServerConfig, type Tool } from "@earendil-works/pi-mcp";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { resolvePluginMcp, validatePluginValues } from "./plugin-config.ts";
import { PluginStore } from "./plugin-store.ts";
import { proxyEnvironment, type ProxyEnvironmentSettings } from "./network-proxy.ts";

export type PluginConnectionStatus = "pending_config" | "connecting" | "connected" | "needs_login" | "needs_relogin" | "error";
export interface PluginServiceState { pluginId: string; name: string; status: PluginConnectionStatus; missing?: string[]; error?: string; tools: Tool[]; toolErrors?: { name: string; reason: string }[]; oauth?: { declared: boolean; loggedIn: boolean } }
type Connection = { state: PluginServiceState; client?: McpClient; retry?: NodeJS.Timeout; retryCount?: number; activeCalls?: number; onIdle?: Set<() => void>; stopped: boolean; hadCredentials?: boolean };
const execSecret = promisify(execCallback);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Owns one connection per enabled, configured service; all sessions share these clients. */
export class PluginHost {
  readonly store: PluginStore;
  private connections = new Map<string, Connection>();
  private reloads = new Map<string, Promise<void>>();
  private redactionValues = new Map<string, string[]>();
  private closed = false;
  migrationErrors: string[] = [];
  onToolsChanged?: () => void;
  constructor(home: string, private readonly proxySettings: () => ProxyEnvironmentSettings = () => ({ proxy: "", noProxy: "" })) { this.store = new PluginStore(home, proxySettings, process.env.HOB_PLUGIN_OFFICIAL_URL); }
  private paths(id: string, profiles?: { name: string; config: Record<string, unknown> }[]) {
    return { root: fileURLToPath(new URL("../../", import.meta.url)), plugin_root: join(this.store.home, "plugins", id), plugin_data: join(this.store.home, "plugin-data", id), ...(profiles ? { profiles } : {}) };
  }
  private key(id: string, name: string): string { return JSON.stringify([id, name]); }
  states(id?: string): PluginServiceState[] {
    return [...this.connections.values()].filter(c => !id || c.state.pluginId === id).map(c => structuredClone(c.state));
  }
  setToolErrors(id: string, service: string, errors: { name: string; reason: string }[]): void {
    const state = this.connections.get(this.key(id, service))?.state;
    if (!state) return;
    if (errors.length) state.toolErrors = errors;
    else delete state.toolErrors;
  }
  async start(): Promise<void> { await Promise.all(this.store.list().map(p => this.reload(p.id))); }
  async reload(id: string): Promise<void> {
    const previous = this.reloads.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.reloadPlugin(id));
    this.reloads.set(id, next);
    try { await next; } finally { if (this.reloads.get(id) === next) this.reloads.delete(id); }
  }
  private async reloadPlugin(id: string): Promise<void> {
    await this.stopPlugin(id);
    if (this.closed) return;
    const plugin = this.store.get(id);
    if (!plugin.enabled) return;
    let files: ReturnType<PluginStore["files"]>;
    let values: ReturnType<PluginStore["values"]> = {};
    try { files = this.store.files(id); values = plugin.profiles ? {} : this.store.values(id); }
    catch (error) {
      const reason = this.redact(id, error instanceof Error ? error.message : String(error));
      this.connections.set(this.key(id, id), { stopped: false, state: { pluginId: id, name: id, status: "error", error: reason, tools: [] } });
      return;
    }
    const { mcp, config } = files;
    if (!isObject(mcp.mcpServers)) throw new Error("mcpServers 必须是对象");
    const profileValues = plugin.profiles ? this.store.completeProfiles(id) : undefined;
    const missing = plugin.profiles
      ? (profileValues!.length ? [] : plugin.profiles.length ? [...new Set(plugin.profiles.flatMap(profile => this.store.profileMissing(id, profile.id)))] : Object.entries(config).filter(([, field]) => field.required).map(([key]) => key))
      : validatePluginValues(config, values);
    if (missing.length) {
      for (const [name, entry] of Object.entries(mcp.mcpServers)) this.connections.set(this.key(id, name), { stopped: false, state: { pluginId: id, name, status: "pending_config", missing, tools: [], ...(isObject(entry) && typeof entry.url === "string" ? { oauth: { declared: isObject(entry.oauth), loggedIn: false } } : {}) } });
      return;
    }
    try {
      for (const key of plugin.secretCommands ?? []) {
        const command = values[key];
        if (typeof command !== "string" || !command.startsWith("!")) throw new Error(`配置项 ${key} 的命令无效`);
        try { values[key] = (await execSecret(command.slice(1), { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim(); }
        catch { throw new Error(`配置项 ${key} 的取值命令执行失败`); }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const name of Object.keys(mcp.mcpServers)) this.connections.set(this.key(id, name), { stopped: false, state: { pluginId: id, name, status: "error", error: reason, tools: [] } });
      return;
    }
    this.redactionValues.set(id, Object.entries(config).flatMap(([key, field]) => field.sensitive && typeof values[key] === "string" && values[key] ? [values[key] as string] : []).concat((profileValues ?? []).flatMap(profile => Object.entries(profile.config).filter(([key]) => config[key]?.sensitive && typeof profile.config[key] === "string" && profile.config[key]).map(([, value]) => value as string))));
    const resolved = resolvePluginMcp(mcp, config, plugin.profiles ? {} : values, this.paths(id, profileValues));
    if (!isObject(resolved.mcpServers)) throw new Error("mcpServers 必须是对象");
    await Promise.all(Object.entries(resolved.mcpServers).map(async ([name, raw]) => {
      if (isObject(raw) && raw.enabled === false) return;
      const connection: Connection = { stopped: false, state: { pluginId: id, name, status: "connecting", tools: [] } };
      this.connections.set(this.key(id, name), connection);
      await this.connect(connection, raw);
    }));
  }
  oauthTarget(id: string, service: string): { home: string; id: string; service: string; url: string; config: PluginOAuthConfig } {
    const { mcp, config } = this.store.files(id);
    const values = this.store.values(id);
    const resolved = resolvePluginMcp(mcp, config, values, this.paths(id));
    const server = isObject(resolved.mcpServers) ? resolved.mcpServers[service] : undefined;
    if (!isObject(server) || typeof server.url !== "string") throw new Error(`插件服务 ${id}/${service} 不是远程服务`);
    const oauth = isObject(server.oauth) ? server.oauth as PluginOAuthConfig : {};
    return { home: this.store.home, id, service, url: server.url, config: oauth };
  }
  private scheduleRetry(connection: Connection, raw: unknown): void {
    if (connection.stopped || this.closed || connection.retry) return;
    const delay = Math.min(1000 * 2 ** Math.min(connection.retryCount ?? 0, 5), 30_000);
    connection.retryCount = (connection.retryCount ?? 0) + 1;
    connection.retry = setTimeout(() => {
      connection.retry = undefined;
      void this.connect(connection, raw);
    }, delay);
    connection.retry.unref();
  }
  private async connect(connection: Connection, raw: unknown): Promise<void> {
    if (connection.stopped || this.closed) return;
    const state = connection.state;
    state.status = "connecting"; delete state.error;
    const parsed = validateMcpServerConfig(state.name, raw);
    if (parsed.kind === "invalid") { state.status = "error"; state.error = this.redact(state.pluginId, parsed.error); this.scheduleRetry(connection, raw); return; }
    const client = new McpClient({ name: "Hob", version: "1.0", requestTimeoutMs: (parsed.config.timeout ?? 15) * 1000 });
    connection.client = client;
    client.onClose(() => {
      if (connection.stopped || this.closed || connection.client !== client) return;
      state.status = "error"; state.error = "MCP 连接已断开"; state.tools = [];
      this.onToolsChanged?.();
      this.scheduleRetry(connection, raw);
    });
    let hadCredentials = false;
    let transport: StdioTransport | StreamableHttpTransport | undefined;
    try {
      if (parsed.kind === "http") {
        connection.hadCredentials = hadCredentials = pluginOAuthLoggedIn(this.oauthTarget(state.pluginId, state.name));
        state.oauth = { declared: isObject(raw) && isObject(raw.oauth), loggedIn: hadCredentials };
      }
      transport = parsed.kind === "stdio"
        ? new StdioTransport({ command: parsed.config.command, args: parsed.config.args, cwd: parsed.config.cwd, env: { ...parsed.config.env, ...proxyEnvironment(process.env, this.proxySettings()) } })
        : new StreamableHttpTransport({ url: parsed.config.url, headers: parsed.config.headers, authProvider: pluginOAuthProvider(this.oauthTarget(state.pluginId, state.name)) });
      await client.connect(transport);
      const tools = await client.listTools();
      if (connection.stopped || this.closed) { await client.close(); return; }
      state.tools = tools; connection.retryCount = 0;
      // 有的服务不登录也能列出工具（如 Gmail），没登录就不算连上：工具留着给插件页看，不交给助手
      if (state.oauth?.declared && !hadCredentials) { state.status = "needs_login"; state.error = undefined; if (connection.client === client) connection.client = undefined; await client.close().catch(() => {}); }
      else state.status = "connected";
      this.onToolsChanged?.();
    } catch (error) {
      if (connection.stopped || this.closed) return;
      const authError = error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError || (error instanceof McpHttpError && (error.status === 401 || error.status === 403));
      state.status = authError ? (hadCredentials || (parsed.kind === "http" && pluginOAuthNeedsRelogin(this.oauthTarget(state.pluginId, state.name))) ? "needs_relogin" : "needs_login") : "error";
      // 本地服务启动就退出时，原因在它的 stderr 里；只取最后几行
      const stderr = transport instanceof StdioTransport ? transport.stderr.trim().split("\n").slice(-5).join("\n").slice(-600) : "";
      const message = error instanceof Error ? error.message : String(error);
      state.error = state.status === "needs_login" ? undefined : this.redact(state.pluginId, stderr ? `${message}：${stderr}` : message);
      if (connection.client === client) connection.client = undefined;
      await client.close().catch(() => {});
      this.scheduleRetry(connection, raw);
    }
  }
  displayName(id: string): string {
    try { const { manifest } = this.store.files(id); return typeof manifest.displayName === "string" ? manifest.displayName : typeof manifest.name === "string" ? manifest.name : id; }
    catch { return id; }
  }
  redact(id: string, message: string): string {
    for (const value of this.redactionValues.get(id) ?? []) message = message.replaceAll(value, "[已隐藏]");
    for (const [key, raw] of Object.entries(readSecrets(this.store.home))) {
      if (key.startsWith(`plugin:${id}:config:`) || key.startsWith(`plugin:${id}:profile:`)) {
        const value: unknown = JSON.parse(raw);
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) if (typeof item === "string" && item) message = message.replaceAll(item, "[已隐藏]");
      }
      if (!key.startsWith(`plugin:${id}:oauth:`)) continue;
      const stored = JSON.parse(raw) as { tokens?: { access_token?: string; refresh_token?: string } };
      for (const token of [stored.tokens?.access_token, stored.tokens?.refresh_token]) if (token) message = message.replaceAll(token, "[已隐藏]");
    }
    return message;
  }
  async call(id: string, service: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const connection = this.connections.get(this.key(id, service));
    if (!connection || connection.state.status !== "connected" || !connection.client) throw new Error(connection?.state.error ?? `插件服务 ${id}/${service} 未连接`);
    const hadCredentials = connection.hadCredentials === true;
    connection.activeCalls = (connection.activeCalls ?? 0) + 1;
    try { return await connection.client.callTool(tool, args, signal ? { signal, timeoutMs: 0 } : {}); }
    catch (error) {
      const authError = error instanceof McpOAuthAuthorizationRequiredError || (error instanceof McpHttpError && (error.status === 401 || error.status === 403));
      if (authError) connection.state.status = hadCredentials ? "needs_relogin" : "needs_login";
      const reason = this.redact(id, error instanceof Error ? error.message : String(error));
      connection.state.error = reason;
      const name = this.displayName(id);
      const message = authError
        ? `${name} ${hadCredentials ? "需要重新登录" : "还没登录"}：请用户到「插件 → ${name}」点「${hadCredentials ? "重新连接" : "连接"}」。服务返回：${reason}`
        : reason;
      if (connection.state.status !== "connected") this.onToolsChanged?.();
      throw new Error(message, { cause: error });
    } finally {
      connection.activeCalls!--;
      if (!connection.activeCalls) {
        for (const resolve of connection.onIdle ?? []) resolve();
        connection.onIdle?.clear();
      }
    }
  }
  async stopPlugin(id: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, connection] of this.connections) {
      if (connection.state.pluginId !== id) continue;
      connection.stopped = true;
      if (connection.retry) clearTimeout(connection.retry);
      this.connections.delete(key);
      if (connection.client) {
        const client = connection.client;
        closing.push((async () => {
          if (connection.activeCalls) await new Promise<void>(resolve => (connection.onIdle ??= new Set()).add(resolve));
          await client.close().catch(() => {});
        })());
      }
    }
    if (closing.length) this.onToolsChanged?.();
    await Promise.all(closing);
    this.redactionValues.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.reloads.values()].map(task => task.catch(() => {})));
    await Promise.all([...new Set([...this.connections.values()].map(c => c.state.pluginId))].map(id => this.stopPlugin(id)));
  }
}

export function pluginToolName(pluginId: string, toolName: string): string {
  return `${pluginId}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function pluginToolDisplayNames(host: PluginHost): Record<string, string> {
  const names: Record<string, string> = Object.create(null);
  for (const plugin of host.store.list()) {
    try {
      const { mcp } = host.store.files(plugin.id);
      if (isObject(mcp.mcpServers)) {
        const services = Object.keys(mcp.mcpServers);
        for (const service of services) names[service.replaceAll("-", "_")] = service;
        if (services.length === 1) names[`plugin:${pluginToolName(plugin.id, "")}`] = services[0];
      }
    } catch { /* A broken plugin cannot supply display names. */ }
    for (const service of host.states(plugin.id)) for (const tool of service.tools) {
      const name = pluginToolName(plugin.id, tool.name);
      names[name] ??= `${service.name} · ${tool.name}`;
    }
  }
  return names;
}

export type PluginAgentTool = Omit<ToolDefinition<any, any>, "execute"> & {
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: Parameters<ToolDefinition<any, any>["execute"]>[3]): ReturnType<ToolDefinition<any, any>["execute"]>;
};

/** The same tool set is used for assistant, group, worker and future script calls. */
export function pluginToolsForAssistant(host: PluginHost, assistantId: string, reservedNames: ReadonlySet<string> = new Set()): PluginAgentTool[] {
  const result: PluginAgentTool[] = [];
  const used = new Set(reservedNames);
  for (const plugin of host.store.list()) {
    if (!plugin.enabled || (plugin.assistants && !plugin.assistants.includes(assistantId))) continue;
    const states = host.states(plugin.id).filter(state => state.status === "connected");
    const count = states.reduce((n, state) => n + state.tools.length, 0);
    for (const state of states) {
      const errors: { name: string; reason: string }[] = [];
      for (const tool of state.tools) {
        const setting = plugin.tools[tool.name];
        if (setting?.enabled === false) continue;
        const name = pluginToolName(plugin.id, tool.name);
        if (name.length > 64 || used.has(name)) {
          errors.push({ name: tool.name, reason: name.length > 64 ? `工具名称超过 64 字符：${name}` : `工具名称冲突：${name}` });
          continue;
        }
        used.add(name);
        result.push({
          name, label: `${plugin.id} · ${tool.title ?? tool.name}`,
          description: tool.description ?? "",
          parameters: normalizeMcpInputSchema(tool.inputSchema) as TSchema,
          namespace: { name: plugin.id },
          exposure: count > 10 ? "deferred" : "direct",
          annotations: tool.annotations,
          execute: async (_callId, args, signal) => {
            if (!isObject(args)) throw new Error("插件工具参数必须是对象");
            const response = await host.call(plugin.id, state.name, tool.name, args, signal);
            if (response.isError) response.content = response.content.map(block => block.type === "text" ? { ...block, text: host.redact(plugin.id, block.text) } : block);
            const limited = await limitMcpContent(toLlmContent(response));
            return { content: limited.content, details: response.structuredContent, isError: response.isError };
          },
        });
      }
      host.setToolErrors(plugin.id, state.name, errors);
    }
  }
  return result;
}

