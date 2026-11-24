import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { t } from "../../shared/i18n.ts";
import { systemDir, type HobConfig } from "./config.ts";
import { verifyPassword } from "./password.ts";

const PREFIX = "/api/passkeys";
const TIMEOUT = 5 * 60_000;
const MAX_CHALLENGES = 128;
const MAX_KEYS = 20;

export const publicPasskeyPaths = new Set([
  `${PREFIX}/status`, `${PREFIX}/login/options`, `${PREFIX}/login/verify`,
]);

type Passkey = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  rpId: string;
  name: string;
  createdAt: string;
};

type Challenge = { expires: number } & (
  { kind: "login" } |
  { kind: "register"; session: string; passwordHash: string; name: string }
);

function relyingParty(address: string): { origin: string; id: string } | null {
  try {
    const url = new URL(address);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
    return { origin: url.origin, id: url.hostname };
  } catch {
    return null;
  }
}

function readKeys(file: string): Passkey[] {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Passkey[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function mountPasskeys(
  app: Hono,
  { home, port, config, sessionCookie, signIn }: {
    home: string;
    port: number;
    config: () => HobConfig;
    sessionCookie: string;
    signIn: (c: Context, secure: boolean) => void;
  },
) {
  // Never infer the expected origin from Host or proxy headers.
  const rp = relyingParty(process.env.HOB_PASSKEY_ORIGIN?.trim() || `http://localhost:${port}`);
  const userId = createHmac("sha256", config().cookieSecret).update("hob-webauthn-user").digest();
  const file = join(systemDir(home), "passkeys.json");
  let keys = readKeys(file);
  const pending = new Map<string, Challenge>();
  const matchesOrigin = (c: Context) => rp !== null && c.req.header("Origin") === rp.origin;
  const scopeKeys = () => keys.filter((key) => key.rpId === rp?.id);

  function save(next: Passkey[]) {
    mkdirSync(systemDir(home), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
    keys = next;
  }

  function remember(challenge: string, entry: Challenge) {
    const now = Date.now();
    for (const [value, item] of pending) if (item.expires <= now) pending.delete(value);
    const oldest = pending.keys().next().value;
    if (pending.size >= MAX_CHALLENGES && oldest !== undefined) pending.delete(oldest);
    pending.set(challenge, entry);
  }

  function take(challenge: unknown, kind: Challenge["kind"]) {
    if (typeof challenge !== "string") return;
    const entry = pending.get(challenge);
    if (!entry || entry.kind !== kind) return;
    pending.delete(challenge);
    if (entry.expires > Date.now()) return entry;
  }

  app.use(`${PREFIX}/*`, bodyLimit({ maxSize: 32 * 1024 }), async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post(`${PREFIX}/status`, (c) => {
    const enabled = matchesOrigin(c);
    return c.json({ enabled, ready: enabled && scopeKeys().length > 0 });
  });

  app.get(PREFIX, (c) => c.json(keys.map(({ id, name, createdAt, rpId }) => ({ id, name, createdAt, rpId }))));

  app.post(`${PREFIX}/register/options`, async (c) => {
    if (!rp || !matchesOrigin(c)) return c.json({ error: t("请通过配置的 HTTPS 地址或本机 localhost 使用通行密钥。") }, 400);
    const { password, name } = (await c.req.json().catch(() => null) ?? {}) as { password?: unknown; name?: unknown };
    const { passwordHash } = config();
    if (typeof password !== "string" || !verifyPassword(passwordHash, password)) {
      return c.json({ error: "旧密码不正确" }, 403);
    }
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
      return c.json({ error: t("请输入 1 至 80 个字符的通行密钥名称。") }, 400);
    }
    if (keys.length >= MAX_KEYS) return c.json({ error: t("最多可添加 20 个通行密钥。") }, 409);
    const options = await generateRegistrationOptions({
      rpName: "Hob", rpID: rp.id, userName: "Hob", userID: new Uint8Array(userId),
      timeout: TIMEOUT, attestationType: "none",
      excludeCredentials: scopeKeys().map(({ id, transports }) => ({ id, transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    remember(options.challenge, {
      kind: "register", expires: Date.now() + TIMEOUT, name: name.trim(), passwordHash,
      session: getCookie(c, sessionCookie) ?? "",
    });
    return c.json(options);
  });

  app.post(`${PREFIX}/register/verify`, async (c) => {
    if (!rp || !matchesOrigin(c)) return c.json({ error: t("请通过配置的 HTTPS 地址或本机 localhost 使用通行密钥。") }, 400);
    const { challenge, response } = (await c.req.json().catch(() => null) ?? {}) as { challenge?: unknown; response?: RegistrationResponseJSON };
    const entry = take(challenge, "register");
    if (entry?.kind !== "register" || entry.session !== getCookie(c, sessionCookie)
      || entry.passwordHash !== config().passwordHash || !response || typeof challenge !== "string") {
      return c.json({ error: t("通行密钥验证已失效，请重试。") }, 400);
    }
    const result = await verifyRegistrationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
    }).catch(() => null);
    if (!result?.verified || !result.registrationInfo || entry.passwordHash !== config().passwordHash) {
      return c.json({ error: t("无法注册通行密钥。") }, 400);
    }
    const { id, publicKey, counter, transports } = result.registrationInfo.credential;
    if (keys.some((key) => key.id === id) || keys.length >= MAX_KEYS) {
      return c.json({ error: t("通行密钥已存在或已达到数量上限。") }, 409);
    }
    const createdAt = new Date().toISOString();
    save([...keys, { id, publicKey: Buffer.from(publicKey).toString("base64url"), counter, transports, rpId: rp.id, name: entry.name, createdAt }]);
    return c.json({ id, name: entry.name, createdAt, rpId: rp.id }, 201);
  });

  app.post(`${PREFIX}/remove`, async (c) => {
    const { id, password } = (await c.req.json().catch(() => null) ?? {}) as { id?: unknown; password?: unknown };
    if (typeof password !== "string" || !verifyPassword(config().passwordHash, password)) {
      return c.json({ error: "旧密码不正确" }, 403);
    }
    const remaining = keys.filter((key) => key.id !== id);
    if (remaining.length === keys.length) return c.json({ error: t("通行密钥不存在。") }, 404);
    save(remaining);
    return c.body(null, 204);
  });

  app.post(`${PREFIX}/login/options`, async (c) => {
    if (!rp || !matchesOrigin(c)) return c.json({ error: t("请通过配置的 HTTPS 地址或本机 localhost 使用通行密钥。") }, 400);
    const allowed = scopeKeys();
    if (!allowed.length) return c.json({ error: t("该地址还没有已注册的通行密钥。") }, 404);
    const options = await generateAuthenticationOptions({
      rpID: rp.id, timeout: TIMEOUT, userVerification: "required",
      allowCredentials: allowed.map(({ id, transports }) => ({ id, transports })),
    });
    remember(options.challenge, { kind: "login", expires: Date.now() + TIMEOUT });
    return c.json(options);
  });

  app.post(`${PREFIX}/login/verify`, async (c) => {
    if (!rp || !matchesOrigin(c)) return c.json({ error: t("请通过配置的 HTTPS 地址或本机 localhost 使用通行密钥。") }, 400);
    const { challenge, response } = (await c.req.json().catch(() => null) ?? {}) as { challenge?: unknown; response?: AuthenticationResponseJSON };
    const key = scopeKeys().find(({ id }) => id === response?.id);
    if (!take(challenge, "login") || !key || !response || typeof challenge !== "string") {
      return c.json({ error: t("通行密钥验证已失效，请重试。") }, 400);
    }
    const result = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
      credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")), counter: key.counter },
    }).catch(() => null);
    // Concurrent removal or a newer counter update invalidates this attempt.
    if (!result?.verified || !keys.includes(key)) return c.json({ error: t("通行密钥验证失败。") }, 401);
    const counter = result.authenticationInfo.newCounter;
    if (counter !== key.counter) save(keys.map((item) => item === key ? { ...key, counter } : item));
    signIn(c, rp.origin.startsWith("https:"));
    return c.json({ ok: true });
  });
}
