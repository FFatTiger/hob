import { describe, expect, it } from "vitest";
import { PET_EXPRESSIONS } from "../../shared/pet.ts";
import { deriveChatMood, deriveHomeMood, typingLook } from "../src/pet/pet-mood.ts";

describe("pet expressions & mood derivation", () => {
  it("provides 12 valid 48-point expressions including wink", () => {
    const keys = Object.keys(PET_EXPRESSIONS);
    expect(keys).toContain("wink");
    expect(keys.length).toBe(12);
    for (const spec of Object.values(PET_EXPRESSIONS)) {
      expect(spec.left.length).toBe(48);
      expect(spec.right.length).toBe(48);
      expect(spec.leftD.startsWith("M")).toBe(true);
      expect(spec.rightD.startsWith("M")).toBe(true);
    }
  });

  it("prioritizes home mood: typing > waiting > live > sleep > idle", () => {
    expect(deriveHomeMood({ waitingCount: 2, liveCount: 3, typing: true, idleAsleep: true })).toBe("listening");
    expect(deriveHomeMood({ waitingCount: 1, liveCount: 3, typing: false, idleAsleep: true })).toBe("curious");
    expect(deriveHomeMood({ waitingCount: 0, liveCount: 2, typing: false, idleAsleep: true })).toBe("thinking");
    expect(deriveHomeMood({ waitingCount: 0, liveCount: 0, typing: false, idleAsleep: true })).toBe("sleeping");
    expect(deriveHomeMood({ waitingCount: 0, liveCount: 0, typing: false, idleAsleep: false })).toBe("idle");
  });

  it("prioritizes chat mood: error > thinking/busy > justFinished > pendingAsk > typing > idle", () => {
    expect(deriveChatMood({ thinking: true, busy: true, hasPendingAsk: true, hasError: true, typing: true, justFinished: true })).toBe("sad");
    expect(deriveChatMood({ thinking: true, busy: false, hasPendingAsk: true, hasError: false, typing: true, justFinished: true })).toBe("thinking");
    expect(deriveChatMood({ thinking: false, busy: false, hasPendingAsk: true, hasError: false, typing: true, justFinished: true })).toBe("happy");
    expect(deriveChatMood({ thinking: false, busy: false, hasPendingAsk: true, hasError: false, typing: true, justFinished: false })).toBe("curious");
    expect(deriveChatMood({ thinking: false, busy: false, hasPendingAsk: false, hasError: false, typing: true, justFinished: false })).toBe("listening");
    expect(deriveChatMood({ thinking: false, busy: false, hasPendingAsk: false, hasError: false, typing: false, justFinished: false })).toBe("idle");
  });

  it("tracks typing position from down-left to down-right across the input line", () => {
    const start = typingLook("", 0, 460);
    const mid = typingLook("帮我查一下今天的日程安排吧", undefined, 460);
    const far = typingLook("帮我查一下今天的日程安排并整理一份简报发给我谢谢", undefined, 460);
    expect(start[0]).toBe(-32);
    expect(start[1]).toBeGreaterThanOrEqual(30);
    expect(mid[0]).toBeGreaterThan(start[0]);
    expect(mid[1]).toBeGreaterThan(start[1]);
    expect(far[0]).toBeGreaterThan(mid[0]);
    expect(far[0]).toBeLessThanOrEqual(32);
  });
});
