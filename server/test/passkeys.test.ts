import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

function setup(port = 30148) {
  const hob = makeHob();
  const app = createApp(hob.runtime, { home: hob.home, port });
  const origin = `http://localhost:${port}`;
  function post(path: string, body: object = {}, cookie = "", requestOrigin = origin) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: requestOrigin, cookie },
      body: JSON.stringify(body),
    });
  }
  async function signIn() {
    const response = await post("/api/login", { password: "test" });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }
  return { ...hob, app, post, signIn, origin };
}

describe("passkey routes", () => {
  it("uses the configured exact origin, including for deployments behind TLS", async () => {
    vi.stubEnv("HOB_PASSKEY_ORIGIN", "https://hob.example.test:8443");
    const hob = setup();
    try {
      const status = (origin: string) => hob.post("/api/passkeys/status", {}, "", origin).then((r) => r.json());
      expect(await status(hob.origin)).toEqual({ enabled: false, ready: false });
      expect(await status("https://hob.example.test")).toEqual({ enabled: false, ready: false });
      expect(await status("https://hob.example.test:8443")).toEqual({ enabled: true, ready: false });
      expect((await hob.post("/api/passkeys/login/options", {}, "", "https://other.example.test")).status).toBe(400);
      expect((await hob.post("/api/passkeys/login/options", {}, "", "https://hob.example.test:8443")).status).toBe(404);
    } finally {
      hob.close();
      vi.unstubAllEnvs();
    }
  });

  it("requires a signed-in session and the current password to manage passkeys", async () => {
    const hob = setup(31957);
    try {
      const input = { password: "test", name: "A test key" };
      expect((await hob.app.request("/api/passkeys")).status).toBe(401);
      expect((await hob.post("/api/passkeys/register/options", input)).status).toBe(401);
      const cookie = await hob.signIn();
      expect((await hob.post("/api/passkeys/register/options", { ...input, password: "wrong" }, cookie)).status).toBe(403);
      expect((await hob.post("/api/passkeys/remove", { id: "missing", password: "wrong" }, cookie)).status).toBe(403);
      expect((await hob.post("/api/passkeys/register/options", input, cookie, "http://127.0.0.1:31957")).status).toBe(400);
      const registration = await hob.post("/api/passkeys/register/options", input, cookie);
      expect(registration.status).toBe(200);
      const options = await registration.json() as { challenge: string };
      expect(options).toMatchObject({
        rp: { id: "localhost" },
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
      });

      const anotherCookie = await hob.signIn();
      const verify = (session: string) => hob.post("/api/passkeys/register/verify", {
        challenge: options.challenge, response: {},
      }, session);
      expect(await (await verify(anotherCookie)).json()).toEqual({ error: "通行密钥验证已失效，请重试。" });
      expect(await (await verify(cookie)).json()).toEqual({ error: "通行密钥验证已失效，请重试。" });
      expect(await (await hob.app.request("/api/passkeys", { headers: { cookie } })).json()).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("expires enrollment challenges and invalidates enrollment after changing the password", async () => {
    const hob = setup();
    try {
      const cookie = await hob.signIn();
      const options = async () => {
        const response = await hob.post("/api/passkeys/register/options", { name: "A test key", password: "test" }, cookie);
        expect(response.status).toBe(200);
        return (await response.json() as { challenge: string }).challenge;
      };
      const verify = async (challenge: string) => {
        const response = await hob.post("/api/passkeys/register/verify", { challenge, response: {} }, cookie);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "通行密钥验证已失效，请重试。" });
      };
      const expired = await options();
      const later = Date.now() + 6 * 60_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        await verify(expired);
      } finally {
        clock.mockRestore();
      }
      const old = await options();
      expect((await hob.post("/api/password", { old: "test", new: "new-test" }, cookie)).status).toBe(200);
      await verify(old);
      expect((await hob.post("/api/login", { password: "new-test" })).status).toBe(200);
    } finally {
      hob.close();
    }
  });
});
