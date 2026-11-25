// Shared Hob attribution helpers for MCP tools and bin/gh.

export const ATTRIBUTION_LINE = "Generated with [Hob](https://github.com/FFatTiger/hob)";
export const HOB_BOT_CO_AUTHOR = "hob-bot[bot] <361159285+hob-bot[bot]@users.noreply.github.com>";

export function appendAttribution(body) {
  if (typeof body === "string" && body.includes(ATTRIBUTION_LINE)) {
    return body;
  }
  const text = typeof body === "string" ? body : "";
  if (!text.trim()) return ATTRIBUTION_LINE;
  return `${text.trimEnd()}\n\n${ATTRIBUTION_LINE}`;
}

export function shouldAttributeToolCall(toolName, args) {
  if (toolName === "create_pull_request" || toolName === "create_issue") return true;
  if (toolName === "issue_write" && args && typeof args === "object" && args.method === "create") return true;
  return false;
}
