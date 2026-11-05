import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Item } from "../../../shared/types.ts";

vi.mock("../store.ts", () => ({
  useApp: () => ({ assistants: [], approvals: {}, drafts: {}, delegations: {}, livePages: {}, sel: "hob", jobs: { "t-1": { id: "t-1", title: "测试任务", status: "done", assistantId: "hob", createdAt: "2026-01-01T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 } } } }),
  photoUrl: (path: string) => path, fileUrl: (path: string) => path,
}));
vi.mock("./ImageGen.tsx", () => ({ ImageGenCard: ({ itemId }: { itemId: string }) => <div data-item-id={itemId}>生成的图片</div> }));
vi.mock("./Markdown.tsx", () => ({ Markdown: () => null }));

import { ItemList } from "./Items.tsx";

describe("对话卡片出处", () => {
  it("文件、图片、生图和任务条目带各自的 item id", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const at = "2026-01-01T00:00:00Z";
    const items: Item[] = [
      { kind: "file", id: "file-1", at, name: "报告", path: "/报告.md" },
      { kind: "file", id: "photo-1", at, name: "图片", path: "/图片.png" },
      { kind: "file", id: "audio-1", at, name: "音频", path: "/音频.mp3" },
      { kind: "file", id: "video-1", at, name: "视频", path: "/视频.mp4" },
      { kind: "image", id: "image-1", at, prompt: "图片", startedAt: at, status: "done", path: "/生成.png" },
      { kind: "job", id: "job-item-1", at, jobId: "t-1" },
    ];
    const html = renderToStaticMarkup(<ItemList items={items} />);
    for (const item of items) expect(html).toContain(`data-item-id="${item.id}"`);
    vi.unstubAllGlobals();
  });
});
