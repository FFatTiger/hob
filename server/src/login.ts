import type { Page } from "playwright-core";
import type { FillLoginApproval, FillLoginCandidate, LoginAutoEntry } from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";
import { DesktopToolSession } from "./desktop-tools.ts";
import { readLoginAuto, saveLoginAuto } from "./login-auto.ts";

export type FillLoginResult = { kind: "filled" | "username"; host: string; username: string; text: string };
export type FillLoginPreparation =
  | { kind: "message"; text: string }
  | { kind: "mismatch"; text: string; approval: FillLoginApproval }
  | { kind: "approval"; approval: FillLoginApproval; title: string; detail: string };

export type InputInfo = { index: number; type: string; autocomplete: string; name: string; value: string; beforePassword: boolean };
export type PageInfo = { url: string; host: string; inputs: InputInfo[]; usernameIndex?: number; passwordIndex?: number };

const recentAllowed = new WeakMap<HobRuntime, Map<string, number>>();

function hostOf(value: string): string | undefined {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return parsed.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

export function hostsMatch(pageHost: string, savedHost: string): boolean {
  const page = pageHost.toLowerCase().replace(/\.$/, "");
  const saved = savedHost.toLowerCase().replace(/\.$/, "");
  return page === saved || page.endsWith(`.${saved}`);
}

function candidateKey(candidate: Pick<FillLoginCandidate, "provider" | "id">): string {
  return `${candidate.provider}:${candidate.id}`;
}

function autoFor(home: string, candidate: FillLoginCandidate, host: string): LoginAutoEntry | undefined {
  return readLoginAuto(home).find((entry) => entry.provider === candidate.provider && entry.itemId === candidate.id && entry.host === host && entry.username === candidate.username);
}

function markRecent(runtime: HobRuntime, candidate: FillLoginCandidate, host: string): void {
  let entries = recentAllowed.get(runtime);
  if (!entries) recentAllowed.set(runtime, entries = new Map());
  entries.set(`${candidateKey(candidate)}:${host}`, Date.now() + 10 * 60 * 1000);
}

function recentFor(runtime: HobRuntime, candidate: FillLoginCandidate, host: string): boolean {
  const entries = recentAllowed.get(runtime);
  const key = `${candidateKey(candidate)}:${host}`;
  const until = entries?.get(key) ?? 0;
  if (until < Date.now()) entries?.delete(key);
  return until >= Date.now();
}

export async function pageInfo(page: Page): Promise<PageInfo> {
  const url = page.url();
  const host = hostOf(url);
  if (!host) throw new Error(`当前页面（${url}）没有网站地址。先打开登录页再调 fill_login。`);
  const inputs = await page.locator("input").evaluateAll((elements) => elements.flatMap((element, index) => {
    const input = element as HTMLInputElement;
    const style = window.getComputedStyle(input);
    if (input.type === "hidden" || input.disabled || style.display === "none" || style.visibility === "hidden" || input.getClientRects().length === 0) return [];
    return [{ index, type: input.type.toLowerCase(), autocomplete: input.autocomplete.toLowerCase(), name: input.name.toLowerCase(), value: input.type.toLowerCase() === "password" ? "" : input.value }];
  }));
  const password = inputs.find((input) => input.type === "password");
  const passwordIndex = password?.index;
  const usernameCandidates = inputs.filter((input) => input.type === "email" || input.autocomplete === "username" || /user|email|login|account/i.test(`${input.name} ${input.type}`));
  const before = inputs.filter((input) => input.type === "text" || input.type === "email").filter((input) => passwordIndex === undefined || input.index < passwordIndex);
  const username = usernameCandidates.find((input) => input.autocomplete === "username" || input.type === "email") ?? usernameCandidates.at(-1) ?? before.at(-1);
  return { url, host, inputs: inputs.map((input) => ({ ...input, beforePassword: passwordIndex === undefined || input.index < passwordIndex })), ...(username ? { usernameIndex: username.index } : {}), ...(password ? { passwordIndex } : {}) };
}

export async function inspectCurrentPage(runtime: HobRuntime, assistantId: string): Promise<PageInfo> {
  const session = new DesktopToolSession(runtime, assistantId);
  try { return await session.withCurrentPage(pageInfo); }
  finally { await session.dispose(); }
}

const inspect = inspectCurrentPage;

function listUris(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function credentialCandidates(runtime: HobRuntime, assistantId: string, site: string, account?: string): Promise<FillLoginCandidate[]> {
  const providers = runtime.plugins.credentialProviders(assistantId, "list");
  const query = site.trim().toLowerCase();
  const queryHost = hostOf(site.trim());
  const result: FillLoginCandidate[] = [];
  for (const provider of providers) {
    const value = await runtime.plugins.callCredential(provider, {});
    const logins = Array.isArray(value.logins) ? value.logins : [];
    for (const item of logins) {
      if (!item || typeof item !== "object") continue;
      const login = item as Record<string, unknown>;
      const name = typeof login.name === "string" ? login.name : "";
      const username = typeof login.username === "string" ? login.username : "";
      const uris = listUris(login.uris);
      const nameMatch = name.toLowerCase().includes(query);
      const uriMatch = queryHost !== undefined && uris.some((uri) => hostOf(uri) === queryHost);
      if (!nameMatch && !uriMatch) continue;
      if (account && !username.toLowerCase().includes(account.trim().toLowerCase())) continue;
      result.push({
        provider: provider.pluginId,
        providerName: provider.providerName,
        id: typeof login.id === "string" ? login.id : String(login.id ?? ""),
        name,
        username,
        ...(typeof login.folder === "string" && login.folder ? { folder: login.folder } : {}),
        uris,
      });
    }
  }
  return result.filter((candidate) => candidate.id);
}

function matchingCandidates(candidates: FillLoginCandidate[], host: string): FillLoginCandidate[] {
  return candidates.filter((candidate) => candidate.uris.some((uri) => {
    const saved = hostOf(uri);
    return saved !== undefined && hostsMatch(host, saved);
  }));
}

function approvalDetail(candidates: FillLoginCandidate[]): string {
  const names = [...new Set(candidates.map((candidate) => candidate.providerName))];
  return `Hob 从 ${names.join("、")} 取出密码，直接填进登录页，助手看不到。`;
}

export async function prepareFillLogin(runtime: HobRuntime, assistantId: string, site: string, account?: string): Promise<FillLoginPreparation> {
  const info = await inspect(runtime, assistantId);
  const candidates = await credentialCandidates(runtime, assistantId, site, account);
  if (!candidates.length) {
    return { kind: "message", text: `密码管理器里没有 ${site} 的账号。注册新账号用 fill_new_password；用户有账号但没存的，可以请他在云桌面里自己登录，或者用密码管理插件的保存工具存进去。` };
  }
  const matched = matchingCandidates(candidates, info.host);
  if (!matched.length) {
    const savedHosts = [...new Set(candidates.flatMap((candidate) => candidate.uris.map(hostOf).filter((host): host is string => Boolean(host))))];
    return {
      kind: "mismatch",
      text: `没有填写：当前页面是 ${info.host}，和密码管理器里保存的网址（${savedHosts.join("、")}）对不上，可能是仿冒的页面。把情况告诉用户。`,
      approval: { host: info.host, currentHost: info.host, candidates, state: "mismatch" },
    };
  }
  if (info.inputs.length === 0) return { kind: "message", text: `当前页面（${info.url}）上没有找到登录框。先打开登录表单再调 fill_login。` };
  const auto = matched.filter((candidate) => autoFor(runtime.home, candidate, info.host) || recentFor(runtime, candidate, info.host));
  if (auto.length === 1) return { kind: "approval", approval: { host: info.host, candidates: matched, chosenId: candidateKey(auto[0]), state: "pending" }, title: `在 ${info.host} 登录`, detail: approvalDetail(matched) };
  if (matched.length === 1) return { kind: "approval", approval: { host: info.host, candidates: matched, state: "pending" }, title: `在 ${info.host} 登录`, detail: approvalDetail(matched) };
  return { kind: "approval", approval: { host: info.host, candidates: matched, state: "pending" }, title: `在 ${info.host} 登录`, detail: approvalDetail(matched) };
}

async function visibleInputIndices(page: Page): Promise<{ inputs: InputInfo[]; usernameIndex?: number; passwordIndex?: number }> {
  const info = await pageInfo(page);
  return { inputs: info.inputs, ...(info.usernameIndex === undefined ? {} : { usernameIndex: info.usernameIndex }), ...(info.passwordIndex === undefined ? {} : { passwordIndex: info.passwordIndex }) };
}

export async function fillCandidate(runtime: HobRuntime, assistantId: string, candidate: FillLoginCandidate, host: string): Promise<FillLoginResult> {
  const provider = runtime.plugins.credentialProviders(assistantId, "secret").find((item) => item.pluginId === candidate.provider);
  if (!provider) throw new Error(`${candidate.providerName} 的凭据工具现在不可用。`);
  const session = new DesktopToolSession(runtime, assistantId);
  try {
    return await session.withCurrentPage(async (page) => {
      const current = await pageInfo(page);
      if (current.host !== host || !candidate.uris.some((uri) => { const saved = hostOf(uri); return saved && hostsMatch(current.host, saved); })) {
        throw new Error(`当前页面是 ${current.host}，和保存的网址对不上，可能是仿冒的页面。`);
      }
      const fields = await visibleInputIndices(page);
      if (fields.usernameIndex === undefined && fields.passwordIndex === undefined) throw new Error(`当前页面（${current.url}）上没有找到登录框。先打开登录表单再调 fill_login。`);
      const secret = await runtime.plugins.callCredential(provider, { id: candidate.id });
      const username = typeof secret.username === "string" ? secret.username : candidate.username;
      const password = typeof secret.password === "string" ? secret.password : "";
      if (!password && fields.passwordIndex !== undefined) throw new Error("密码管理器没有存密码。");
      if (fields.usernameIndex !== undefined) await page.locator("input").nth(fields.usernameIndex).fill(username);
      if (fields.passwordIndex === undefined) {
        markRecent(runtime, candidate, host);
        return { kind: "username", host, username, text: `已在 ${host} 填好用户名 ${username}，点下一步后再调一次 fill_login 填密码。` };
      }
      await page.locator("input").nth(fields.passwordIndex).fill(password);
      return { kind: "filled", host, username, text: `已在 ${host} 填好 ${username} 的账号和密码，接下来点登录按钮。` };
    });
  } finally { await session.dispose(); }
}

export function candidateId(candidate: FillLoginCandidate): string { return candidateKey(candidate); }
export function rememberAutoLogin(runtime: HobRuntime, candidate: FillLoginCandidate, host: string): LoginAutoEntry {
  return saveLoginAuto(runtime.home, { provider: candidate.provider, itemId: candidate.id, host, username: candidate.username });
}
