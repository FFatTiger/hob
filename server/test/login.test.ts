import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { hostsMatch } from "../src/login.ts";
import { readLoginAuto, saveLoginAuto } from "../src/login-auto.ts";
import { makeHob } from "./helpers.ts";

describe("fill_login safety boundaries", () => {
  it("only accepts the saved host or one of its subdomains", () => {
    expect(hostsMatch("login.example.net", "example.net")).toBe(true);
    expect(hostsMatch("example.net", "login.example.net")).toBe(false);
    expect(hostsMatch("forum-example.net.verify-login.io", "forum.example.net")).toBe(false);
    expect(hostsMatch("example.net.", "example.net")).toBe(true);
  });

  it("persists only the auto-fill identity and never a password", () => {
    const hob = makeHob();
    const password = "unique-password-that-must-not-be-written";
    try {
      saveLoginAuto(hob.home, { provider: "bitwarden", itemId: "item-1", host: "forum.example.net", username: "user@example.net" });
      assert.deepEqual(readLoginAuto(hob.home), [{ provider: "bitwarden", itemId: "item-1", host: "forum.example.net", username: "user@example.net", at: readLoginAuto(hob.home)[0]!.at }]);
      expect(readFileSync(join(hob.home, "system", "login-auto.json"), "utf8")).not.toContain(password);
    } finally { hob.close(); }
  });

  it("does not expose fill_login when the desktop or credential provider is unavailable", () => {
    const hob = makeHob();
    try {
      expect(buildRouterTools(hob.runtime, "hob").some((tool) => tool.name === "fill_login")).toBe(false);
    } finally { hob.close(); }
  });
});
