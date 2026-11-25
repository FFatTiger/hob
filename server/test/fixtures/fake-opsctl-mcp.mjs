// Fake `opsctl mcp` fixture implementing strict data-plane / out-of-band control-plane separation.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:net";

const isDesktop = process.argv.includes("--approval-mode=desktop");
const isFull = process.argv.includes("--toolset=full");
const allowPermanent = process.argv.includes("--allow-permanent");
const socketFlag = process.argv.find((a) => a.startsWith("--approval-control-socket="));
const controlSocketPath = socketFlag ? socketFlag.slice("--approval-control-socket=".length).trim() : "";
const allowLocalDirs = process.argv
  .filter((a) => a.startsWith("--allow-local-dir="))
  .map((a) => a.slice("--allow-local-dir=".length).trim());

const secret = process.env.OPSKAT_MCP_APPROVAL_SECRET || "";
if (!isDesktop) {
  if (!controlSocketPath) {
    process.stderr.write("Error: --approval-control-socket is required in external approval mode\n");
    process.exit(1);
  }
  if (secret.length < 16) {
    process.stderr.write("Error: external approval mode requires OPSKAT_MCP_APPROVAL_SECRET >= 16 chars\n");
    process.exit(1);
  }
}

const CORE_TOOLS = [
  { name: "list_assets", description: "List assets", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_asset", description: "Get asset", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  { name: "help", description: "Help", inputSchema: { type: "object", properties: { asset: { type: "string" } }, required: ["asset"] }, annotations: { readOnlyHint: true } },
  { name: "exec", description: "Execute command", inputSchema: { type: "object", properties: { asset: { type: "string" }, command: { type: "string" } }, required: ["asset", "command"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "batch_exec", description: "Batch execute", inputSchema: { type: "object", properties: { commands: { type: "string" } }, required: ["commands"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "cp", description: "Copy files", inputSchema: { type: "object", properties: { src: { type: "string" }, dst: { type: "string" } }, required: ["src", "dst"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "request_permission", description: "Request grant", inputSchema: { type: "object", properties: { items: { type: "string" }, reason: { type: "string" } }, required: ["items", "reason"] }, annotations: { readOnlyHint: false } },
];

const EXTRA_FULL_TOOLS = [
  { name: "list_groups", description: "List groups", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_group", description: "Get group", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  { name: "list_credentials", description: "List credentials", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_credential", description: "Get credential", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] }, annotations: { readOnlyHint: true } },
  { name: "put_asset", description: "Put asset", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
  { name: "put_group", description: "Put group", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
  { name: "delete_asset", description: "Delete asset", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "delete_group", description: "Delete group", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "get_asset_secret", description: "Get secret", inputSchema: { type: "object", properties: { id: { type: "number" }, field: { type: "string" } }, required: ["id", "field"] }, annotations: { readOnlyHint: false } },
  { name: "list_audit", description: "List MCP session audit", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

const EXTERNAL_TOOLS = [
  { name: "get_task", description: "Get task", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] }, annotations: { readOnlyHint: true } },
];

const TOOLS = [
  ...CORE_TOOLS,
  ...(isFull ? EXTRA_FULL_TOOLS : []),
  ...(isDesktop ? [] : EXTERNAL_TOOLS),
];

let seq = 1;
const pending = new Map();
const tasks = new Map();

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function toPauseRef(pause) {
  return {
    status: pause.status,
    approval_id: pause.approval_id,
    task_id: pause.task_id,
    expires_at: pause.expires_at,
  };
}

function handleControlAction(req) {
  if (req?.secret !== secret) {
    return { ok: false, error: "unauthorized: invalid approval secret" };
  }
  const action = req.action || "resolve";
  if (action === "list_pending") {
    return { ok: true, pending: [...pending.values()].map((e) => e.pause) };
  }
  if (action === "get_pending") {
    const entry = pending.get(req.approval_id);
    if (!entry) return { ok: false, error: `approval "${req.approval_id}" not found or expired` };
    return { ok: true, pause: entry.pause };
  }
  if (action !== "resolve") {
    return { ok: false, error: `unknown control action "${action}"` };
  }

  const entry = pending.get(req.approval_id);
  if (!entry) {
    return { ok: false, error: "approval not found or expired" };
  }
  if (req.decision === "allow_permanent" && !allowPermanent) {
    return { ok: false, error: "permanent allow rule writer is not enabled" };
  }
  if (entry.mode === "shadow" && req.decision === "allow_permanent") {
    return { ok: false, error: "failed to write permanent allow rule: allow rule is shadowed by deny" };
  }
  pending.delete(req.approval_id);

  if (req.decision === "deny") {
    return { ok: true, result: { status: "completed", task_id: entry.pause.task_id, output: "USER DENIED: stopped", is_error: true } };
  }

  if (entry.mode === "mfa") {
    const mfaId = `apr_mfa_${seq++}`;
    const mfaPause = {
      status: "needs_mfa",
      approval_id: mfaId,
      task_id: entry.pause.task_id,
      kind: "mfa",
      tool_name: "exec",
      mfa: { asset_id: 1, asset_name: "web-01", name: "2FA", instruction: "输入 6 位动态码", prompts: ["Verification code:"], echo: [false] },
      allowed_decisions: ["deny", "allow"],
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    pending.set(mfaId, { mode: "mfa_finish", pause: mfaPause });
    return { ok: true, result: { status: "needs_mfa", task_id: entry.pause.task_id, pause: mfaPause } };
  }

  if (entry.mode === "slow_mfa") {
    const mfaId = `apr_mfa_${seq++}`;
    const mfaPause = {
      status: "needs_mfa",
      approval_id: mfaId,
      task_id: entry.pause.task_id,
      kind: "mfa",
      tool_name: "exec",
      mfa: { asset_id: 1, asset_name: "web-01", name: "2FA", instruction: "输入后台任务动态码", prompts: ["Verification code:"], echo: [false] },
      allowed_decisions: ["deny", "allow"],
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    pending.set(mfaId, { mode: "mfa_finish", pause: mfaPause });
    tasks.set(entry.pause.task_id, { status: "needs_mfa", task_id: entry.pause.task_id, pause_ref: toPauseRef(mfaPause) });
    return { ok: true, result: { status: "running", task_id: entry.pause.task_id } };
  }

  if (entry.mode === "mfa_finish") {
    const code = req.mfa_answers?.[0] || "";
    return { ok: true, result: { status: "completed", task_id: entry.pause.task_id, output: `ssh verified with code=${code} and allowed ok`, is_error: false } };
  }

  if (entry.mode === "slow") {
    tasks.set(entry.pause.task_id, { status: "completed", task_id: entry.pause.task_id, output: "slow-job-finished", is_error: false });
    return { ok: true, result: { status: "running", task_id: entry.pause.task_id } };
  }

  if (entry.mode === "grant") {
    const edited = Array.isArray(req.edited_items) ? req.edited_items.map((it) => it.command).join(", ") : "";
    return { ok: true, result: { status: "completed", task_id: entry.pause.task_id, output: `grant approved: ${edited}`, is_error: false } };
  }

  if (entry.mode === "batch") {
    return { ok: true, result: { status: "completed", task_id: entry.pause.task_id, output: "batch completed: 2/2 ok", is_error: false } };
  }

  if (entry.mode === "local_tool") {
    return { ok: true, result: { status: "completed", task_id: entry.pause.task_id, output: `cp local write ok (dirs=${allowLocalDirs.join(",")})`, is_error: false } };
  }

  const cmd = entry.pause.items?.[0]?.command || "";
  return { ok: true, result: { status: "completed", task_id: entry.pause.task_id, output: `ran(${req.decision}): ${cmd} -> allowed ok`, is_error: false } };
}

let controlServer = null;
let listenAddr = "";
if (!isDesktop) {
  listenAddr = process.platform === "win32"
    ? `\\\\.\\pipe\\fake-opskat-${createHash("sha256").update(controlSocketPath).digest("hex").slice(0, 24)}`
    : controlSocketPath;
  if (process.platform !== "win32") {
    try { rmSync(listenAddr, { force: true }); } catch { /* ignore */ }
  }
  controlServer = createServer((conn) => {
    let raw = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      raw += chunk;
      const nl = raw.indexOf("\n");
      if (nl >= 0) {
        let req;
        try { req = JSON.parse(raw.slice(0, nl).trim()); }
        catch {
          conn.end(`${JSON.stringify({ ok: false, error: "invalid control request" })}\n`);
          return;
        }
        const resp = handleControlAction(req);
        conn.end(`${JSON.stringify(resp)}\n`);
      }
    });
  });
  controlServer.listen(listenAddr, () => {
    process.stderr.write(`OPSKAT_MCP_CONTROL_ADDR=${listenAddr}\n`);
  });
}

function handleCall(name, args) {
  if (name === "exec") {
    const cmd = String(args?.command || "");
    if (cmd === "hostname") {
      return { content: [{ type: "text", text: "web-01.internal" }] };
    }
    const approval_id = `apr_${seq++}`;
    const task_id = `tsk_${seq}`;
    const item = { type: "exec", asset_id: 1, asset_name: "web-01", command: cmd, subjects: [cmd] };
    if (cmd.includes("review-reject")) {
      item.review = { outcome: "reject", failed: ["no-prod-rm"], failed_names: { "no-prod-rm": { "zh-CN": "禁止生产删库" } } };
    }
    const allowed_decisions = ["deny", "allow", "allow_session", ...(allowPermanent ? ["allow_permanent"] : [])];
    const pause = {
      status: "needs_approval",
      approval_id,
      task_id,
      kind: "single",
      tool_name: "exec",
      items: [item],
      allowed_decisions,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    const mode = cmd.includes("slow-mfa")
      ? "slow_mfa"
      : cmd.includes("need-mfa")
        ? "mfa"
        : cmd.includes("slow-cmd")
          ? "slow"
          : cmd.includes("shadow-perm")
            ? "shadow"
            : "exec";
    pending.set(approval_id, { mode, pause });
    const ref = toPauseRef(pause);
    return { content: [{ type: "text", text: `needs approval (${approval_id})` }], structuredContent: ref };
  }

  if (name === "cp") {
    const approval_id = `apr_${seq++}`;
    const task_id = `tsk_${seq}`;
    const pause = {
      status: "needs_approval",
      approval_id,
      task_id,
      kind: "local_tool",
      tool_name: "cp",
      items: [{ type: "local_tool", command: `cp ${args?.src} -> ${args?.dst}`, local_paths: [String(args?.dst || "/tmp/out.txt")] }],
      allowed_decisions: ["deny", "allow", "allow_session"],
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    pending.set(approval_id, { mode: "local_tool", pause });
    const ref = toPauseRef(pause);
    return { content: [{ type: "text", text: `needs local write approval (${approval_id})` }], structuredContent: ref };
  }

  if (name === "batch_exec") {
    const approval_id = `apr_${seq++}`;
    const task_id = `tsk_${seq}`;
    const pause = {
      status: "needs_approval",
      approval_id,
      task_id,
      kind: "batch",
      tool_name: "batch_exec",
      items: [
        { type: "exec", asset_id: 1, asset_name: "web-01", command: "systemctl reload nginx" },
        { type: "exec", asset_id: 2, asset_name: "win-01", command: "whoami" },
      ],
      allowed_decisions: ["deny", "allow"],
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    pending.set(approval_id, { mode: "batch", pause });
    const ref = toPauseRef(pause);
    return { content: [{ type: "text", text: `needs batch approval (${approval_id})` }], structuredContent: ref };
  }

  if (name === "request_permission") {
    const approval_id = `apr_${seq++}`;
    const task_id = `tsk_${seq}`;
    const pause = {
      status: "needs_approval",
      approval_id,
      task_id,
      kind: "grant",
      tool_name: "request_permission",
      reason: String(args?.reason || "deploy"),
      items: [{ type: "grant", asset_id: 1, asset_name: "web-01", command: "systemctl * nginx" }],
      allowed_decisions: ["deny", "allow"],
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    pending.set(approval_id, { mode: "grant", pause });
    const ref = toPauseRef(pause);
    return { content: [{ type: "text", text: `needs grant approval (${approval_id})` }], structuredContent: ref };
  }

  if (name === "get_task") {
    const task = tasks.get(args?.task_id);
    if (!task) return { content: [{ type: "text", text: "task not found" }], isError: true };
    if (task.status === "needs_mfa") {
      return { content: [{ type: "text", text: "needs mfa" }], structuredContent: task };
    }
    return { content: [{ type: "text", text: task.output }], structuredContent: task };
  }

  return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-opsctl", version: "1.0" } } });
    } else if (msg.method === "notifications/initialized") {
      // no-op
    } else if (msg.method === "tools/list") {
      write({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      write({ jsonrpc: "2.0", id: msg.id, result: handleCall(msg.params?.name, msg.params?.arguments) });
    }
  }
});

const cleanup = () => {
  try { controlServer?.close(); } catch { /* ignore */ }
  if (listenAddr && process.platform !== "win32") {
    try { rmSync(listenAddr, { force: true }); } catch { /* ignore */ }
  }
  process.exit(0);
};
process.stdin.on("end", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
