import { describe, expect, it } from "vitest";
import type { HobEvent } from "../../shared/types.ts";
import { createMock } from "../src/mock.ts";

/** 假后端里和话题有关的几条行为（真服务端是票 151）。 */
function mock(scene: Parameters<typeof createMock>[0] = "topics") {
  const api = createMock(scene);
  const events: HobEvent[] = [];
  api.events({ onEvent: (event) => events.push(event) });
  return { api, events };
}

const error = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return null;
  } catch (e) {
    return (e as { message: string }).message;
  }
};

describe("mock：话题和待办", () => {
  it("topics 场景：一个群，三个进行中的话题和两个关了的", async () => {
    const { api } = mock("topics");
    const groups = await api.groups();
    const host = groups.find((g) => g.id === "g-topics")!;
    expect(host.name).toBe("Hob 开发");
    const topics = groups.filter((g) => g.parentId === "g-topics");
    expect(topics.map((t) => t.name)).toEqual(["导出月度报表", "登录页加「记住我」", "上传大文件失败", "导出加按月筛选", "首页配色改版"]);
    expect(topics.filter((t) => !t.closedAt)).toHaveLength(3);
    expect(topics.filter((t) => t.closedAt)).toHaveLength(2);
    // 话题的成员、群主、负责什么都跟群一样
    for (const topic of topics) {
      expect(topic.members).toEqual(host.members);
      expect(topic.ownerId).toBe(host.ownerId);
    }
    // 话题带自己的未读和待办
    expect(topics.find((t) => t.id === "t-export")!.unread).toBe(2);
    const remember = topics.find((t) => t.id === "t-remember")!;
    expect(remember.todos?.filter((item) => item.status === "done")).toHaveLength(1);
    expect(remember.todos).toHaveLength(4);
  });

  it("topics-plain 场景：一个群，两个进行中的话题，都没待办", async () => {
    const { api } = mock("topics-plain");
    const groups = await api.groups();
    const topics = groups.filter((g) => g.parentId === "g-home");
    expect(topics.filter((t) => !t.closedAt).map((t) => t.name)).toEqual(["换新硬盘", "相册备份出错"]);
    expect(topics.every((t) => (t.todos ?? []).length === 0)).toBe(true);
  });

  it("开话题：综合里落一张话题卡，话题带群的成员和群主", async () => {
    const { api, events } = mock("topics");
    const topic = await api.createTopic("g-topics", { title: "发布前的检查" });
    expect(topic.parentId).toBe("g-topics");
    expect(topic.createdBy).toBe("user");
    expect(topic.ownerId).toBe("po");
    expect(topic.members).toEqual(["po", "arch", "dev", "qa", "release"]);
    const items = await api.groupItems("g-topics");
    expect(items.items.at(-1)).toMatchObject({ kind: "topic", topicId: topic.id });
    expect(events.some((event) => event.type === "group-item")).toBe(true);
    expect(events.some((event) => event.type === "group" && event.group.id === topic.id)).toBe(true);

    expect(await error(() => api.createTopic("g-topics", { title: "  " }))).toContain("话题名不能为空");
    expect(await error(() => api.createTopic(topic.id, { title: "话题里再开一个" }))).toContain("话题里不能再开话题");
  });

  it("关闭话题：关了以后发消息报错；重新打开能再发", async () => {
    const { api } = mock("topics");
    const closed = await api.closeTopic("t-remember", { note: "先不做了" });
    expect(closed.closedAt).toBeTruthy();
    expect(closed.closeNote).toBe("先不做了");
    expect(await error(() => api.sendGroupMessage("t-remember", { text: "在吗" }))).toBe("这个话题已关闭，重新打开后才能发消息");

    const reopened = await api.reopenTopic("t-remember");
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.closeNote).toBeUndefined();
    const sent = await api.sendGroupMessage("t-remember", { text: "在吗" });
    expect(sent?.item.text).toBe("在吗");
  });

  it("话题置顶：支持置顶/取消置顶，关闭后置顶失效且重开不恢复", async () => {
    const { api } = mock("topics");
    expect(await error(() => api.patchGroup("g-topics", { pinned: true }))).toBe("置顶仅适用于话题。");
    const pinned = await api.patchGroup("t-export", { pinned: true });
    expect(pinned.pinnedAt).toBeTruthy();
    const unpinned = await api.patchGroup("t-export", { pinned: false });
    expect(unpinned.pinnedAt).toBeUndefined();

    await api.patchGroup("t-export", { pinned: true });
    const closed = await api.closeTopic("t-export", { note: "完成了" });
    expect(closed.pinnedAt).toBeUndefined();
    expect(await error(() => api.patchGroup("t-export", { pinned: true }))).toContain("已关闭的话题不能置顶");
    const reopened = await api.reopenTopic("t-export");
    expect(reopened.pinnedAt).toBeUndefined();
  });

  it("话题只能改名字", async () => {
    const { api } = mock("topics");
    expect(await error(() => api.patchGroup("t-remember", { purpose: "改负责什么" }))).toBe("话题只能改名字。");
    const renamed = await api.patchGroup("t-remember", { name: "换掉的名字" });
    expect(renamed.name).toBe("换掉的名字");
  });

  it("建群只要名字、负责什么、成员和群主", async () => {
    const { api } = mock("s1");
    const created = await api.createGroup({ name: "Pix 开发", purpose: "Pix 仓库的事", ownerId: "hob", members: ["hob"] });
    expect(created.name).toBe("Pix 开发");
    expect(created.members).toEqual(["hob"]);
  });

  it("建群和开话题支持可选工作目录并校验边界", async () => {
    const { api } = mock("s1");
    expect(await error(() => api.createGroup({ name: "坏路径", purpose: "", ownerId: "hob", members: ["hob"], cwd: "relative/path" }))).toContain("绝对路径");
    const boundGroup = await api.createGroup({ name: "Hob 项目", purpose: "仓库维护", ownerId: "hob", members: ["hob"], cwd: "/workspace/hob" });
    expect(boundGroup.cwd).toBe("/workspace/hob");
    // 群已设 cwd 时，话题不能单独指定 cwd，且创建出的话题自身 cwd 保持未定义（跟随群）
    expect(await error(() => api.createTopic(boundGroup.id, { title: "覆盖目录", cwd: "/tmp/other" }))).toContain("所属群已绑定工作目录");
    const followTopic = await api.createTopic(boundGroup.id, { title: "跟随群" });
    expect(followTopic.cwd).toBeUndefined();

    // 群未设 cwd 时，话题可单独绑定绝对路径，拒绝相对路径
    const unboundGroup = await api.createGroup({ name: "家用群", purpose: "", ownerId: "hob", members: ["hob"] });
    expect(unboundGroup.cwd).toBeUndefined();
    expect(await error(() => api.createTopic(unboundGroup.id, { title: "坏目录", cwd: "foo/bar" }))).toContain("绝对路径");
    const topicWithCwd = await api.createTopic(unboundGroup.id, { title: "脚本维护", cwd: "/srv/scripts" });
    expect(topicWithCwd.cwd).toBe("/srv/scripts");
  });

  it("归档群时，每个话题各发一个 group_removed", async () => {
    const { api, events } = mock("topics");
    events.length = 0;
    await api.archiveGroup("g-topics");
    const removed = events.flatMap((event) => (event.type === "group_removed" ? [event.id] : []));
    expect(removed).toContain("g-topics");
    expect(removed.filter((id) => id.startsWith("t-"))).toHaveLength(5);
  });

  it("关闭话题暂停启用中定时并记 pausedBy；重开只恢复 pausedBy 的", async () => {
    const { api } = mock("topics");
    const topicActive = (await api.createRoutine({ assistantId: "po", groupId: "t-remember", name: "话题巡检", instruction: "查进度", schedules: ["0 9 * * *"], active: true })).routine;
    const topicPaused = (await api.createRoutine({ assistantId: "po", groupId: "t-remember", name: "手动暂停", instruction: "不用跑", schedules: ["0 10 * * *"], active: false })).routine;
    const generalActive = (await api.createRoutine({ assistantId: "po", groupId: "g-topics", name: "综合汇总", instruction: "汇总", schedules: ["0 8 * * *"], active: true })).routine;

    await api.closeTopic("t-remember", { note: "先告一段落" });
    const afterClose = (await api.bootstrap()).routines;
    expect(afterClose.find((r) => r.id === topicActive.id)).toMatchObject({ active: false, pausedBy: "topicClosed" });
    expect(afterClose.find((r) => r.id === topicPaused.id)?.active).toBe(false);
    expect(afterClose.find((r) => r.id === topicPaused.id)?.pausedBy).toBeUndefined();
    expect(afterClose.find((r) => r.id === generalActive.id)).toMatchObject({ active: true });

    expect(await error(() => api.patchRoutine(topicActive.id, { active: true }))).toBe("话题已关闭");
    expect(await error(() => api.runRoutine(topicActive.id))).toBe("话题已关闭");

    await api.reopenTopic("t-remember");
    const afterReopen = (await api.bootstrap()).routines;
    expect(afterReopen.find((r) => r.id === topicActive.id)?.active).toBe(true);
    expect(afterReopen.find((r) => r.id === topicActive.id)?.pausedBy).toBeUndefined();
    expect(afterReopen.find((r) => r.id === topicPaused.id)?.active).toBe(false);
    expect(afterReopen.find((r) => r.id === topicPaused.id)?.pausedBy).toBeUndefined();
  });
});
