import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const LATEST_PROTOCOL = "2025-03-26";
const CALLBACK_TOOL = "opskat_card_callback";
const READ_ONLY_TOOLS = new Set(["list_assets", "get_asset", "list_groups", "get_group", "list_credentials", "get_credential", "help", "list_audit", "get_task"]);
const APPROVAL_TOOLS = new Set(["exec", "batch_exec", "cp", "request_permission", "put_asset", "put_group", "delete_asset", "delete_group", "get_asset_secret"]);
const APPROVAL_HINT = "\n\n[Hob approval] OpsKat enforces its own security policy and interactive approval card. Do NOT use ask_user to pre-confirm this operation before calling this tool. If an approval or MFA card is displayed, wait for the user's card action. If the user denies, stop immediately and do not retry.";

const approvalMode = (process.env.OPSKAT_APPROVAL_MODE || "hob_card").trim() === "desktop" ? "desktop" : "external";
const toolset = (process.env.OPSKAT_TOOLSET || "core").trim() === "full" ? "full" : "core";
const allowPermanent = (process.env.HOB_OPSKAT_ALLOW_PERMANENT || "").trim().toLowerCase() === "true";
const allowLocalDirs = (process.env.HOB_OPSKAT_ALLOW_LOCAL_DIRS || "")
  .split(/[,;\r\n]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const resolveWaitMs = Math.min(Math.max(Number(process.env.OPSKAT_RESOLVE_WAIT_MS) || 45_000, 100), 50_000);
const initTimeoutMs = Math.min(Math.max(Number(process.env.OPSKAT_INIT_TIMEOUT_MS) || 30_000, 1_000), 120_000);
const controlTimeoutMs = Math.min(Math.max(resolveWaitMs + 8_000, 10_000), 56_000);
const approvalSecret = approvalMode === "external" ? randomBytes(32).toString("hex") : "";

const pauseCache = new Map();
const MAX_CACHED_PAUSES = 200;
const MAX_GRANT_GROUPS = 40;
const MAX_CALLBACK_OUTPUT_CHARS = 32_000;
const MAX_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
let cardSeq = 0;

process.stdout.on("error", () => {});

function writeMessage(msg) {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    /* stdout closed during shutdown */
  }
}

function resolveOpsctlCommand() {
  const configured = (process.env.OPSKAT_BIN || "").trim();
  if (configured) {
    if (/\.(mjs|js|cjs)$/i.test(configured)) {
      return { command: process.execPath, prefixArgs: [configured] };
    }
    return { command: configured, prefixArgs: [] };
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const candidate = join(process.env.LOCALAPPDATA, "OpsKat", "opsctl.exe");
    if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
  }
  if (process.platform === "darwin") {
    for (const candidate of [
      "/Applications/OpsKat.app/Contents/MacOS/opsctl",
      join(homedir(), ".local", "bin", "opsctl"),
      "/opt/homebrew/bin/opsctl",
      "/usr/local/bin/opsctl",
    ]) {
      if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
    }
  } else if (process.platform !== "win32") {
    for (const candidate of [
      join(homedir(), ".local", "bin", "opsctl"),
      "/usr/local/bin/opsctl",
    ]) {
      if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
    }
  }
  return { command: process.platform === "win32" ? "opsctl.exe" : "opsctl", prefixArgs: [] };
}

class OpsctlClient {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrLines = [];
    this.closed = false;
    this.controlSocketPath = "";
    this.controlAddr = "";
    this.controlAddrWaiters = [];
  }

  scrub(text, extraSecrets = []) {
    let out = String(text ?? "");
    const secrets = [];
    if (approvalSecret) secrets.push(approvalSecret);
    if (this.controlAddr) secrets.push(this.controlAddr);
    if (this.controlSocketPath) secrets.push(this.controlSocketPath);
    for (const s of extraSecrets) {
      if (typeof s === "string" && s.length > 0) secrets.push(s);
    }
    const unique = [...new Set(secrets)].sort((a, b) => b.length - a.length);
    for (const secret of unique) {
      out = out.split(secret).join("***");
    }
    return out;
  }

  stderrTail() {
    return this.scrub(this.stderrLines.slice(-6).join("\n").trim());
  }

  cleanupControlSocketFile() {
    if (this.controlSocketPath && process.platform !== "win32") {
      try { rmSync(this.controlSocketPath, { force: true }); } catch { /* ignore */ }
    }
  }

  async ensureStarted() {
    if (this.closed) throw new Error("OpsKat MCP adapter is closing");
    if (this.proc && !this.proc.killed && this.proc.exitCode === null && this.proc.signalCode === null && this.ready) {
      await this.ready;
      return;
    }
    this.ready = this.start();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async start() {
    const { command, prefixArgs } = resolveOpsctlCommand();
    const args = [...prefixArgs, "mcp", `--approval-mode=${approvalMode}`, `--toolset=${toolset}`];
    this.cleanupControlSocketFile();
    this.controlSocketPath = "";
    this.controlAddr = "";
    this.controlAddrWaiters = [];

    if (approvalMode === "external") {
      this.controlSocketPath = join(tmpdir(), `hob-opskat-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
      args.push(`--approval-control-socket=${this.controlSocketPath}`);
      if (allowPermanent) args.push("--allow-permanent");
    }
    for (const dir of allowLocalDirs) {
      args.push(`--allow-local-dir=${dir}`);
    }

    const env = { ...process.env };
    const cfgDataDir = (process.env.HOB_OPSKAT_DATA_DIR || "").trim();
    const cfgMasterKey = (process.env.HOB_OPSKAT_MASTER_KEY || "").trim();
    delete env.HOB_OPSKAT_DATA_DIR;
    delete env.HOB_OPSKAT_MASTER_KEY;
    delete env.HOB_OPSKAT_ALLOW_PERMANENT;
    delete env.HOB_OPSKAT_ALLOW_LOCAL_DIRS;
    if (cfgDataDir) env.OPSKAT_DATA_DIR = cfgDataDir;
    if (cfgMasterKey) env.OPSKAT_MASTER_KEY = cfgMasterKey;
    if (approvalMode === "external") env.OPSKAT_MCP_APPROVAL_SECRET = approvalSecret;
    else delete env.OPSKAT_MCP_APPROVAL_SECRET;

    this.stderrLines = [];
    this.buffer = "";
    const proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;

    proc.stdin.on("error", () => {});

    let stderrBuf = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderrBuf += String(chunk);
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("OPSKAT_MCP_CONTROL_ADDR=")) {
          const addr = trimmed.slice("OPSKAT_MCP_CONTROL_ADDR=".length).trim();
          if (addr) {
            this.controlAddr = addr;
            for (const resolve of this.controlAddrWaiters.splice(0)) resolve(addr);
          }
          continue;
        }
        this.stderrLines.push(trimmed);
        if (this.stderrLines.length > 20) this.stderrLines.shift();
      }
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    });

    let failed = false;
    const failAll = (reason) => {
      if (failed) return;
      failed = true;
      if (stderrBuf.trim()) {
        const last = stderrBuf.trim();
        if (last.startsWith("OPSKAT_MCP_CONTROL_ADDR=")) {
          this.controlAddr = last.slice("OPSKAT_MCP_CONTROL_ADDR=".length).trim();
        } else {
          this.stderrLines.push(last);
        }
        stderrBuf = "";
      }
      const detail = this.stderrTail();
      const err = new Error(detail ? `${reason}: ${detail}` : reason);
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
      for (const resolve of this.controlAddrWaiters.splice(0)) resolve("");
      if (this.proc === proc) {
        this.proc = null;
        this.ready = null;
      }
      this.cleanupControlSocketFile();
    };

    proc.on("error", (err) => failAll(`启动 opsctl 失败（${command}）：${err.message}`));
    proc.on("close", (code, signal) => failAll(`opsctl mcp 已退出（code=${code}, signal=${signal}）`));

    let timer;
    try {
      const init = await Promise.race([
        this.rawRequest("initialize", {
          protocolVersion: LATEST_PROTOCOL,
          capabilities: {},
          clientInfo: { name: "hob-opskat-plugin", version: "1.0.0" },
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`opsctl mcp 初始化超时（${Math.round(initTimeoutMs / 1000)}s）`)), initTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (init.error) throw new Error(init.error.message || "opsctl mcp initialize 失败");
      this.notify("notifications/initialized");
      if (approvalMode === "external" && !this.controlAddr) {
        await this.waitForControlAddr(2_000);
        if (!this.controlAddr && process.platform !== "win32") {
          this.controlAddr = this.controlSocketPath;
        }
        if (!this.controlAddr) {
          throw new Error("opsctl mcp 未输出带外控制通道地址（OPSKAT_MCP_CONTROL_ADDR），请升级到最新版 opsctl");
        }
      }
    } catch (error) {
      if (this.proc === proc) {
        this.proc = null;
        this.ready = null;
      }
      try { proc.stdin?.end(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      this.cleanupControlSocketFile();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  waitForControlAddr(timeoutMs) {
    if (this.controlAddr) return Promise.resolve(this.controlAddr);
    return new Promise((resolve) => {
      let settled = false;
      const done = (addr) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(addr);
      };
      this.controlAddrWaiters.push(done);
      const t = setTimeout(() => done(this.controlAddr || ""), timeoutMs);
      t.unref?.();
    });
  }

  notify(method, params) {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
    } catch {
      /* ignore write error on dying child */
    }
  }

  rawRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error("opsctl mcp 未运行"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async request(method, params) {
    await this.ensureStarted();
    return this.rawRequest(method, params);
  }

  /** Send an out-of-band request over opsctl mcp's user-restricted local IPC control socket. */
  async controlRequest(action, payload = {}, extraSecrets = []) {
    await this.ensureStarted();
    const addr = this.controlAddr || (process.platform !== "win32" ? this.controlSocketPath : "");
    if (!addr) throw new Error("审批控制通道未就绪");
    const reqBody = JSON.stringify({ action, secret: approvalSecret, ...payload }) + "\n";

    return new Promise((resolve, reject) => {
      let settled = false;
      let raw = "";
      const socket = createConnection(addr);
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        if (err) reject(new Error(this.scrub(err instanceof Error ? err.message : String(err), extraSecrets)));
        else resolve(value);
      };

      const timer = setTimeout(() => finish(new Error("审批控制通道请求超时")), controlTimeoutMs);
      timer.unref?.();

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(reqBody);
      });
      socket.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > MAX_CONTROL_RESPONSE_BYTES) {
          finish(new Error("审批控制通道响应过大"));
          return;
        }
        const nl = raw.indexOf("\n");
        if (nl >= 0) {
          const line = raw.slice(0, nl).trim();
          if (line) {
            try { finish(null, JSON.parse(line)); }
            catch (err) { finish(new Error(`审批控制通道响应解析失败：${err.message}`)); }
          }
        }
      });
      socket.on("end", () => {
        if (settled) return;
        const trimmed = raw.trim();
        if (!trimmed) {
          finish(new Error("审批控制通道未返回数据"));
          return;
        }
        try { finish(null, JSON.parse(trimmed)); }
        catch (err) { finish(new Error(`审批控制通道响应解析失败：${err.message}`)); }
      });
      socket.on("error", (err) => finish(new Error(`连接审批控制通道失败：${err.message}`)));
    });
  }

  async close() {
    this.closed = true;
    const err = new Error("OpsKat MCP adapter is closing");
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (!proc) {
      this.cleanupControlSocketFile();
      return;
    }
    try { proc.stdin?.end(); } catch { /* ignore */ }
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        proc.once("close", finish);
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* ignore */ }
          finish();
        }, 800);
        timer.unref?.();
      });
    }
    this.cleanupControlSocketFile();
  }
}

const upstream = new OpsctlClient();

function clip(text, max = 500) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function row(label, value) {
  const str = String(value ?? "");
  return {
    tag: "column_set",
    background_style: "light",
    columns: [
      { weight: 1, elements: [{ tag: "div", text: String(label ?? "") }] },
      { weight: 4, elements: [{ tag: "div", text: str || "—" }] },
    ],
  };
}

function cachePause(pause) {
  if (!pause?.approval_id) return;
  pauseCache.set(pause.approval_id, pause);
  while (pauseCache.size > MAX_CACHED_PAUSES) {
    const oldest = pauseCache.keys().next().value;
    pauseCache.delete(oldest);
  }
}

function buttonActionName(kind, decision, approvalId) {
  return `opskat:${kind}:${decision}:${approvalId}`;
}

function parseButtonActionName(name) {
  if (typeof name !== "string" || !name.startsWith("opskat:")) return null;
  const parts = name.split(":");
  if (parts.length < 4) return null;
  const [, kind, decision, ...rest] = parts;
  const approvalId = rest.join(":");
  if (!approvalId) return null;
  return { kind, decision, approvalId };
}

function reviewSummary(review) {
  if (!review || typeof review !== "object") return "";
  const parts = [];
  if (review.outcome) parts.push(String(review.outcome));
  if (review.reason) parts.push(String(review.reason));
  if (review.message) parts.push(String(review.message));
  const failed = Array.isArray(review.failed) ? review.failed.filter((v) => typeof v === "string" && v) : [];
  if (failed.length) {
    const names = review.failed_names && typeof review.failed_names === "object" ? review.failed_names : {};
    const labels = failed.map((id) => {
      const entry = names[id];
      if (entry && typeof entry === "object") {
        return entry["zh-CN"] || entry.zh || entry.en || Object.values(entry).find((v) => typeof v === "string" && v) || id;
      }
      return id;
    });
    parts.push(`触发规则：${labels.join("、")}`);
  }
  return parts.join(" · ");
}

function decisionLabel(decision) {
  switch (decision) {
    case "deny": return "已拒绝";
    case "allow": return "已允许";
    case "allow_session": return "已记住 24 小时";
    case "allow_permanent": return "已永久允许";
    default: return decision;
  }
}

function itemTargetLabel(item) {
  if (item.asset_name) return `${item.asset_name}${item.asset_id ? ` (ID ${item.asset_id})` : ""}`;
  if (item.asset_id) return `ID ${item.asset_id}`;
  if (item.group_name) return `${item.group_name}${item.group_id ? ` (分组 ID ${item.group_id})` : ""}`;
  if (item.group_id) return `分组 ID ${item.group_id}`;
  return "OpsKat";
}

function buildApprovalCard(pause) {
  const items = Array.isArray(pause.items) ? pause.items : [];
  const allowed = Array.isArray(pause.allowed_decisions) ? pause.allowed_decisions : ["deny", "allow"];
  const aid = pause.approval_id;
  const seq = ++cardSeq;

  if (pause.kind === "grant") {
    const formElements = [];
    if (pause.reason) formElements.push(row("申请说明", clip(pause.reason, 300)));
    const grouped = new Map();
    for (const item of items) {
      const key = `${item.asset_id ?? 0}:${item.asset_name || ""}:${item.group_id ?? 0}:${item.group_name || ""}`;
      const existing = grouped.get(key) ?? {
        asset_id: item.asset_id,
        asset_name: item.asset_name,
        group_id: item.group_id,
        group_name: item.group_name,
        type: item.type,
        commands: [],
      };
      if (item.command) existing.commands.push(item.command);
      grouped.set(key, existing);
    }
    const groups = [...grouped.values()];
    const shownGroups = groups.slice(0, MAX_GRANT_GROUPS);
    shownGroups.forEach((group, idx) => {
      const target = group.asset_name || (group.asset_id ? `ID ${group.asset_id}` : (group.group_name || (group.group_id ? `分组 ID ${group.group_id}` : "全局")));
      const label = `${target}（每行一条模式，可编辑收窄）`;
      formElements.push({
        tag: "input",
        element_id: `g_${idx}_${seq}`,
        name: `grant_${idx}`,
        label: clip(label, 120),
        input_type: "multiline_text",
        default_value: clip(group.commands.join("\n"), 4000),
      });
    });
    if (groups.length > MAX_GRANT_GROUPS) {
      formElements.push({ tag: "div", text: `（共 ${groups.length} 个目标，仅展示前 ${MAX_GRANT_GROUPS} 个，建议分批申请）` });
    }
    formElements.push(
      { tag: "button", name: buttonActionName("grant", "deny", aid), text: "拒绝", type: "default" },
      { tag: "button", name: buttonActionName("grant", "allow", aid), text: "批准授权", type: "primary_filled", form_action_type: "submit" },
    );
    return {
      config: { callback_tool: CALLBACK_TOOL },
      header: { title: "权限申请", subtitle: `${items.length} 条命令模式` },
      body: { elements: [{ tag: "form", name: "opskat_grant", elements: formElements }] },
    };
  }

  if (pause.kind === "batch") {
    const shown = items.slice(0, 20).map((item, i) => {
      const parts = [clip(item.command || item.detail, 200)];
      if (item.action) {
        const res = Array.isArray(item.resources) && item.resources.length ? item.resources.join(", ") : (item.resource || "");
        parts.push(res ? `[${item.action} → ${clip(res, 80)}]` : `[${item.action}]`);
      }
      const rev = reviewSummary(item.review);
      if (rev) parts.push(`审核：${clip(rev, 120)}`);
      return row(`${i + 1}. ${item.asset_name || (item.asset_id ? `ID ${item.asset_id}` : "OpsKat")}`, parts.filter(Boolean).join(" · "));
    });
    const elements = shown.slice(0, 5);
    if (shown.length > 5) {
      elements.push({
        tag: "collapsible_panel",
        header: { title: `其余 ${shown.length - 5} 项` },
        expanded: false,
        elements: shown.slice(5),
      });
    }
    if (items.length > 20) elements.push({ tag: "div", text: `（共 ${items.length} 项，已省略其余 ${items.length - 20} 项）` });
    elements.push(
      { tag: "button", name: buttonActionName("apr", "deny", aid), text: "拒绝", type: "default" },
      { tag: "button", name: buttonActionName("apr", "allow", aid), text: "全部允许", type: "primary_filled" },
    );
    return {
      config: { callback_tool: CALLBACK_TOOL },
      header: { title: "批量操作审批", subtitle: `共 ${items.length} 项` },
      body: { elements },
    };
  }

  const item = items[0] ?? {};
  const isLocalTool = pause.kind === "local_tool";
  const targetLabel = itemTargetLabel(item);
  const isGroupOnly = !item.asset_name && !item.asset_id && Boolean(item.group_name || item.group_id);
  const elements = [];
  if (isLocalTool) {
    elements.push(row("目标", "本机文件系统"));
  } else {
    elements.push(row(isGroupOnly ? "分组" : "资产", `${targetLabel}${item.type ? ` · ${item.type}` : ""}`));
  }
  if (item.command) elements.push(row("命令", clip(item.command, 400)));
  if (item.detail && item.detail !== item.command) elements.push(row("详情", clip(item.detail, 400)));
  const localPaths = Array.isArray(item.local_paths) ? item.local_paths.filter(Boolean) : [];
  if (localPaths.length) elements.push(row("本机路径", clip(localPaths.join(" ; "), 300)));
  if (item.action) {
    const targetRes = Array.isArray(item.resources) && item.resources.length ? item.resources.join(", ") : (item.resource || "");
    elements.push(row("动作", targetRes ? `${item.action} → ${clip(targetRes, 240)}` : item.action));
  }
  const subjects = Array.isArray(item.subjects) ? item.subjects.filter(Boolean) : [];
  if (subjects.length && (subjects.length > 1 || subjects[0] !== item.command)) {
    elements.push(row("授权主体", clip(subjects.join(" ; "), 300)));
  }
  const rev = reviewSummary(item.review);
  if (rev) elements.push(row("模型审核", clip(rev, 300)));

  if (allowed.includes("deny")) {
    elements.push({ tag: "button", name: buttonActionName("apr", "deny", aid), text: "拒绝", type: "default" });
  }
  if (allowed.includes("allow")) {
    elements.push({
      tag: "button",
      name: buttonActionName("apr", "allow", aid),
      text: pause.kind === "delete" ? "确认删除" : "本次允许",
      type: pause.kind === "delete" ? "danger" : "primary_filled",
    });
  }
  if (allowed.includes("allow_session")) {
    elements.push({ tag: "button", name: buttonActionName("apr", "allow_session", aid), text: "记住 24 小时", type: "default" });
  }
  if (allowed.includes("allow_permanent")) {
    elements.push({ tag: "button", name: buttonActionName("apr", "allow_permanent", aid), text: "永久允许", type: "default" });
  }

  const headerTarget = item.asset_name || item.group_name || pause.tool_name || "OpsKat";
  const title = pause.kind === "delete"
    ? `确认删除 · ${item.asset_name || item.group_name || "资产"}`
    : isLocalTool
      ? `本机文件写入审批 · ${pause.tool_name || "cp"}`
      : `需要审批 · ${headerTarget}`;
  return {
    config: { callback_tool: CALLBACK_TOOL },
    header: {
      title,
      subtitle: item.type ? `${item.type} · ${pause.tool_name || "exec"}` : (pause.tool_name || "OpsKat"),
    },
    body: { elements },
  };
}

function buildMFACard(pause) {
  const mfa = pause.mfa ?? { prompts: ["验证码"], echo: [false] };
  const prompts = Array.isArray(mfa.prompts) ? mfa.prompts : ["验证码"];
  const echo = Array.isArray(mfa.echo) ? mfa.echo : [];
  const aid = pause.approval_id;
  const seq = ++cardSeq;
  const elements = [];
  if (mfa.instruction) elements.push({ tag: "div", text: clip(mfa.instruction, 300) });
  prompts.forEach((prompt, idx) => {
    elements.push({
      tag: "input",
      element_id: `m_${idx}_${seq}`,
      name: `mfa_${idx}`,
      label: clip(String(prompt ?? "").replace(/[:：\s]+$/, "") || `验证项 ${idx + 1}`, 80),
      input_type: echo[idx] === true ? "text" : "password",
      placeholder: echo[idx] === true ? "请输入" : "请输入一次性验证码",
    });
  });
  elements.push(
    { tag: "button", name: buttonActionName("mfa", "deny", aid), text: "取消", type: "default" },
    { tag: "button", name: buttonActionName("mfa", "allow", aid), text: prompts.length ? "提交验证" : "继续", type: "primary_filled", form_action_type: "submit" },
  );
  return {
    config: { callback_tool: CALLBACK_TOOL },
    header: {
      title: `两步验证 · ${mfa.asset_name || (mfa.asset_id ? `ID ${mfa.asset_id}` : "SSH")}`,
      ...(mfa.name ? { subtitle: clip(mfa.name, 100) } : {}),
    },
    body: { elements: [{ tag: "form", name: "opskat_mfa", elements }] },
  };
}

function buildResultCard(pause, decision, statusText) {
  const items = Array.isArray(pause?.items) ? pause.items : [];
  const elements = [];
  if (pause?.kind === "mfa") {
    const mfa = pause.mfa ?? {};
    const target = mfa.asset_name || (mfa.asset_id ? `ID ${mfa.asset_id}` : "SSH");
    elements.push(row("资产", target));
    elements.push({ tag: "div", icon: "check", text: statusText });
    return { header: { title: `两步验证 · ${target}` }, body: { elements } };
  }
  if (pause?.kind === "batch") {
    for (const item of items.slice(0, 5)) {
      elements.push(row(item.asset_name || `ID ${item.asset_id}`, clip(item.command || item.detail, 200)));
    }
    if (items.length > 5) elements.push({ tag: "div", text: `（共 ${items.length} 项）` });
    elements.push({ tag: "div", icon: "check", text: statusText });
    return { header: { title: "批量操作审批" }, body: { elements } };
  }
  if (pause?.kind === "grant") {
    if (pause.reason) elements.push(row("申请说明", clip(pause.reason, 200)));
    elements.push(row("模式数量", `${items.length} 条`));
    elements.push({ tag: "div", icon: "check", text: statusText });
    return { header: { title: "权限申请" }, body: { elements } };
  }
  const item = items[0] ?? {};
  if (pause?.kind === "local_tool") {
    elements.push(row("目标", "本机文件系统"));
  } else if (item.asset_name || item.asset_id || item.group_name || item.group_id) {
    const isGroupOnly = !item.asset_name && !item.asset_id && Boolean(item.group_name || item.group_id);
    elements.push(row(isGroupOnly ? "分组" : "资产", `${itemTargetLabel(item)}${item.type ? ` · ${item.type}` : ""}`));
  }
  if (item.command) elements.push(row("命令", clip(item.command, 300)));
  elements.push({ tag: "div", icon: "check", text: statusText || decisionLabel(decision) });
  return {
    header: { title: `审批结果 · ${item.asset_name || item.group_name || pause?.tool_name || "OpsKat"}` },
    body: { elements },
  };
}

function extractGrantEdits(pause, formValue) {
  const items = Array.isArray(pause?.items) ? pause.items : [];
  const grouped = [];
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.asset_id ?? 0}:${item.asset_name || ""}:${item.group_id ?? 0}:${item.group_name || ""}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        asset_id: item.asset_id,
        asset_name: item.asset_name,
        group_id: item.group_id,
        group_name: item.group_name,
        type: item.type,
        detail: item.detail,
      };
      byKey.set(key, entry);
      grouped.push(entry);
    }
  }
  const edited = [];
  const errors = {};
  grouped.slice(0, MAX_GRANT_GROUPS).forEach((group, idx) => {
    const raw = formValue?.[`grant_${idx}`];
    const lines = String(raw ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      errors[`grant_${idx}`] = "至少保留一条命令模式，或点击「拒绝」";
      return;
    }
    for (const cmd of lines) {
      edited.push({
        type: group.type || "grant",
        asset_id: group.asset_id,
        asset_name: group.asset_name,
        ...(group.group_id ? { group_id: group.group_id } : {}),
        ...(group.group_name ? { group_name: group.group_name } : {}),
        command: cmd,
        detail: group.detail,
      });
    }
  });
  return { edited, errors };
}

function capCallbackOutput(text) {
  if (text.length <= MAX_CALLBACK_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_CALLBACK_OUTPUT_CHARS)}\n…（输出过长，已截断，共 ${text.length} 字符）`;
}

async function fetchPausePayload(approvalId) {
  const ctrlResp = await upstream.controlRequest("get_pending", { approval_id: approvalId });
  if (!ctrlResp?.ok || !ctrlResp.pause) {
    throw new Error(ctrlResp?.error || "获取审批详情失败");
  }
  return ctrlResp.pause;
}

async function handleCardCallback(args) {
  const action = args?.action && typeof args.action === "object" ? args.action : {};
  const parsed = parseButtonActionName(action.name);
  if (!parsed) {
    return { content: [], _meta: { "hob/toast": { type: "error", content: "无法识别的审批按钮操作" } } };
  }
  const { kind, decision, approvalId } = parsed;
  let cached = pauseCache.get(approvalId);
  if (!cached && decision === "allow" && (kind === "grant" || kind === "mfa")) {
    try {
      cached = await fetchPausePayload(approvalId);
      cachePause(cached);
    } catch {
      /* handled below by fail-closed checks */
    }
  }
  const formValue = action.form_value && typeof action.form_value === "object" ? action.form_value : {};

  const resolveArgs = {
    approval_id: approvalId,
    decision,
    wait_ms: resolveWaitMs,
  };

  const sensitiveInputs = [];

  if (kind === "mfa" && decision === "allow") {
    let promptCount;
    if (Array.isArray(cached?.mfa?.prompts)) {
      promptCount = cached.mfa.prompts.length;
    } else {
      const mfaIndices = Object.keys(formValue)
        .map((k) => /^mfa_(\d+)$/.exec(k))
        .filter(Boolean)
        .map((m) => Number(m[1]));
      if (!mfaIndices.length) {
        return { content: [], _meta: { "hob/toast": { type: "error", content: "验证上下文已过期，请取消后重新发起" } } };
      }
      promptCount = Math.max(...mfaIndices) + 1;
    }
    const answers = [];
    const errors = {};
    for (let idx = 0; idx < promptCount; idx++) {
      const raw = String(formValue[`mfa_${idx}`] ?? "");
      const trimmed = raw.trim();
      if (!trimmed) {
        errors[`mfa_${idx}`] = "请输入验证码";
      } else {
        sensitiveInputs.push(raw, trimmed);
      }
      answers.push(trimmed);
    }
    if (Object.keys(errors).length) {
      return { content: [], _meta: { "hob/errors": errors } };
    }
    resolveArgs.mfa_answers = answers;
  }

  if (kind === "grant" && decision === "allow") {
    if (!cached) {
      return { content: [], _meta: { "hob/toast": { type: "error", content: "权限申请上下文已过期，请点击「拒绝」或让助手重新发起" } } };
    }
    const { edited, errors } = extractGrantEdits(cached, formValue);
    if (Object.keys(errors).length) {
      return { content: [], _meta: { "hob/errors": errors } };
    }
    resolveArgs.edited_items = edited;
  }

  let ctrlResp;
  try {
    ctrlResp = await upstream.controlRequest("resolve", resolveArgs, sensitiveInputs);
  } catch (err) {
    const errMsg = upstream.scrub(err instanceof Error ? err.message : String(err), sensitiveInputs);
    return { content: [], _meta: { "hob/toast": { type: "error", content: errMsg || "审批提交失败" } } };
  }

  if (!ctrlResp || !ctrlResp.ok || !ctrlResp.result || !ctrlResp.result.status) {
    const errText = upstream.scrub(ctrlResp?.error || "审批处理失败", sensitiveInputs);
    if (/not found or expired|expired/i.test(errText)) {
      pauseCache.delete(approvalId);
      return {
        content: [{ type: "text", text: "该审批已过期或不存在，如需继续请重新发起。" }],
        _meta: {
          "hob/card": buildResultCard(cached, decision, "审批已过期"),
          "hob/toast": { type: "warning", content: errText || "该审批已过期" },
        },
      };
    }
    return { content: [], _meta: { "hob/toast": { type: "error", content: errText } } };
  }

  const sc = ctrlResp.result;
  pauseCache.delete(approvalId);

  // Secondary pause (e.g. approved SSH command triggered MFA) -> morph card in-place!
  if (sc.status === "needs_mfa" && sc.pause) {
    cachePause(sc.pause);
    return {
      content: [],
      _meta: { "hob/card": buildMFACard(sc.pause) },
    };
  }
  if (sc.status === "needs_approval" && sc.pause) {
    cachePause(sc.pause);
    return {
      content: [],
      _meta: { "hob/card": buildApprovalCard(sc.pause) },
    };
  }

  if (sc.status === "running") {
    const actionLabel = kind === "mfa" ? "已验证" : decisionLabel(decision);
    const statusText = `${actionLabel} · 后台执行中（任务 ${sc.task_id}）`;
    return {
      content: [{
        type: "text",
        text: `用户已选择「${actionLabel}」，命令仍在后台执行。请调用 opskat_get_task(task_id="${sc.task_id}") 等待执行完成并获取结果。`,
      }],
      _meta: { "hob/card": buildResultCard(cached, decision, statusText) },
    };
  }

  // Completed (executed or denied)
  const output = capCallbackOutput(upstream.scrub(typeof sc.output === "string" ? sc.output : "", sensitiveInputs));
  const actionLabel = kind === "mfa" ? "已验证" : decisionLabel(decision);
  const statusText = decision === "deny"
    ? (kind === "mfa" ? "已取消验证" : "已拒绝")
    : `${actionLabel} · ${sc.is_error ? "执行失败" : "执行完成"}`;

  return {
    content: [{ type: "text", text: output || statusText }],
    _meta: { "hob/card": buildResultCard(cached, decision, statusText) },
  };
}

async function handleListTools() {
  const resp = await upstream.request("tools/list", {});
  if (resp.error) throw new Error(resp.error.message || "获取 opsctl 工具列表失败");
  const upstreamTools = Array.isArray(resp.result?.tools) ? resp.result.tools : [];
  const tools = upstreamTools.map((tool) => {
    const annotations = { readOnlyHint: READ_ONLY_TOOLS.has(tool.name), ...(tool.annotations ?? {}) };
    if (approvalMode === "external" && APPROVAL_TOOLS.has(tool.name)) {
      return { ...tool, annotations, description: `${tool.description || ""}${APPROVAL_HINT}` };
    }
    return { ...tool, annotations };
  });

  if (approvalMode === "external") {
    tools.push({
      name: CALLBACK_TOOL,
      description: "OpsKat 审批与 MFA 卡片回调。",
      inputSchema: {
        type: "object",
        properties: {
          card_id: { type: "string" },
          action: { type: "object" },
        },
        required: ["card_id", "action"],
      },
      _meta: { ui: { visibility: ["app"] } },
    });
  }
  return { tools };
}

async function handleToolCall(name, args) {
  if (name === CALLBACK_TOOL) {
    if (approvalMode !== "external") {
      return { content: [], _meta: { "hob/toast": { type: "error", content: "当前为桌面端审批模式，不支持卡片回调" } } };
    }
    return handleCardCallback(args);
  }

  const resp = await upstream.request("tools/call", { name, arguments: args ?? {} });
  if (resp.error) {
    return { content: [{ type: "text", text: upstream.scrub(resp.error.message || "opsctl 工具调用失败") }], isError: true };
  }
  const result = resp.result ?? { content: [] };
  const sc = result.structuredContent;
  if (approvalMode === "external" && sc && typeof sc === "object") {
    // Reference-Passing: MCP data plane only returns an opaque PauseRef (status + approval_id + task_id).
    // Fetch the full approval/MFA details strictly over the out-of-band local IPC control socket,
    // and NEVER pass structuredContent back to Hob/LLM.
    const ref = sc.pause_ref && typeof sc.pause_ref === "object"
      ? sc.pause_ref
      : sc.pause && typeof sc.pause === "object"
        ? sc.pause
        : sc;
    if ((sc.status === "needs_approval" || sc.status === "needs_mfa") && ref.approval_id) {
      let pause;
      try {
        pause = await fetchPausePayload(ref.approval_id);
      } catch (err) {
        return {
          content: [{ type: "text", text: upstream.scrub(err instanceof Error ? err.message : String(err)) }],
          isError: true,
        };
      }
      cachePause(pause);
      if (sc.status === "needs_approval") {
        return {
          content: [{ type: "text", text: "该操作需要用户审批，审批卡片已显示给用户。请等待用户在卡片上点击允许或拒绝后再继续。" }],
          _meta: { "hob/card": buildApprovalCard(pause) },
        };
      }
      return {
        content: [{ type: "text", text: "目标 SSH 服务器需要两步验证，验证卡片已显示给用户。请等待用户提交验证码。" }],
        _meta: { "hob/card": buildMFACard(pause) },
      };
    }
  }
  return result;
}

async function handleIncoming(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    return;
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id === undefined) return;
  try {
    if (message.method === "initialize") {
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "hob-opskat", version: "1.0.0" },
        },
      });
      return;
    }
    if (message.method === "ping") {
      writeMessage({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.method === "tools/list") {
      writeMessage({ jsonrpc: "2.0", id: message.id, result: await handleListTools() });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      writeMessage({ jsonrpc: "2.0", id: message.id, result: await handleToolCall(name, args) });
      return;
    }
    writeMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32603, message: upstream.scrub(error instanceof Error ? error.message : String(error)) },
    });
  }
}

let inBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inBuffer += chunk;
  const lines = inBuffer.split("\n");
  inBuffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch (err) {
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${err.message}` } });
      continue;
    }
    void handleIncoming(parsed);
  }
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void upstream.close().finally(() => process.exit(0));
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
