import type { PageLive } from "../../shared/types.ts";

export function shouldOpenLive(
  page: PageLive,
  options: { seen: boolean; closed: boolean; assistantId: string | null; topicId?: string | null; inChat: boolean },
): boolean {
  return (
    page.state === "writing" &&
    !options.seen &&
    !options.closed &&
    options.inChat &&
    page.assistantId === options.assistantId &&
    (page.topicId ?? null) === (options.topicId ?? null)
  );
}

export function visibleLiveCards(pages: PageLive[], assistantId: string | null, topicId?: string | null): PageLive[] {
  return pages.filter(
    (page) =>
      page.assistantId === assistantId &&
      (page.topicId ?? null) === (topicId ?? null) &&
      page.state === "writing",
  );
}
