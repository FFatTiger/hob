import { beforeAll, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/api.ts";

beforeAll(() => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });
});

describe("P3 store 过滤与写层", () => {
  it("loadSidebarJobs 与 loadSidebarFiles 对群话题传 exact: true，对综合不传 exact", async () => {
    const store = await import("../src/store.ts");
    const group = { id: "g-exact", name: "研发群", purpose: "", ownerId: "po", members: ["po"], createdAt: "2026-01-01", unread: 0, busy: [] };
    const topic = { ...group, id: "t-exact", parentId: "g-exact", name: "话题" };
    Object.assign(store.getState(), { groups: [group, topic], sidebarJobs: {}, sidebarFiles: {} });

    const jobsSpy = vi.spyOn(realApi, "jobs").mockResolvedValue({ jobs: [], hasMore: false });
    const knowledgeSpy = vi.spyOn(realApi, "knowledge").mockResolvedValue({ entries: [], collections: [], hasMore: false } as never);

    await store.loadSidebarJobs("t-exact");
    expect(jobsSpy).toHaveBeenCalledWith({ groupId: "t-exact", exact: true, before: undefined, limit: 20 });

    await store.loadSidebarFiles("t-exact");
    expect(knowledgeSpy).toHaveBeenCalledWith({ origin: "output", groupId: "t-exact", exact: true, before: undefined, limit: 30 });

    await store.loadSidebarJobs("g-exact");
    expect(jobsSpy).toHaveBeenCalledWith({ groupId: "g-exact", before: undefined, limit: 20 });

    await store.loadSidebarFiles("g-exact");
    expect(knowledgeSpy).toHaveBeenCalledWith({ origin: "output", groupId: "g-exact", before: undefined, limit: 30 });

    jobsSpy.mockRestore();
    knowledgeSpy.mockRestore();
  });

  it("patchGroupMemberModels 对话题写话题层，对综合写群层且不覆盖子话题的独立配置", async () => {
    const store = await import("../src/store.ts");
    const pickGroup = { ref: "p/group-member", thinking: "high" as const };
    const pickTopic = { ref: "p/topic-member", thinking: "high" as const };
    const group = { id: "g-layer", name: "群", purpose: "", ownerId: "po", members: ["po", "dev"], createdAt: "2026-01-01", unread: 0, busy: [] };
    const topic = { ...group, id: "t-layer", parentId: "g-layer", name: "话题", overrides: { memberModels: { dev: { work: pickTopic } } }, memberModels: { dev: { work: pickTopic } } };
    Object.assign(store.getState(), { groups: [group, topic] });

    const patchSpy = vi.spyOn(realApi, "patchGroupMemberModels")
      .mockResolvedValueOnce({ ...topic, overrides: { memberModels: { dev: { work: pickTopic }, po: { work: pickTopic } } }, memberModels: { dev: { work: pickTopic }, po: { work: pickTopic } } })
      .mockResolvedValueOnce({ ...group, memberModels: { po: { work: pickGroup } } });

    await store.patchGroupMemberModels("t-layer", "po", { work: pickTopic });
    expect(patchSpy).toHaveBeenNthCalledWith(1, "t-layer", "po", { work: pickTopic });
    expect(store.getState().groups.find((g) => g.id === "t-layer")?.overrides?.memberModels?.po?.work).toEqual(pickTopic);

    await store.patchGroupMemberModels("g-layer", "po", { work: pickGroup });
    expect(patchSpy).toHaveBeenNthCalledWith(2, "g-layer", "po", { work: pickGroup });
    // 综合改完不覆盖子话题自己的 dev 覆盖
    expect(store.getState().groups.find((g) => g.id === "t-layer")?.memberModels?.dev?.work).toEqual(pickTopic);

    patchSpy.mockRestore();
  });
});
