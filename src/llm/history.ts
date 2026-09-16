import type { XClient } from "../x/client.js";
import { eventToTurn, type ChatTurn } from "./context.js";

export async function fetchConversationTurns(
  client: XClient,
  conversationId: string,
  options: {
    maxMessages: number;
    maxPages: number;
    excludeEventId?: string;
  },
): Promise<{ turns: ChatTurn[]; pages: number }> {
  const newestFirst: ChatTurn[] = [];
  let paginationToken: string | undefined;
  let pages = 0;
  const pageSize = Math.min(100, Math.max(1, options.maxMessages));

  while (pages < options.maxPages && newestFirst.length < options.maxMessages) {
    const page = await client.listConversationDmEvents({
      conversationId,
      maxResults: pageSize,
      paginationToken,
    });
    pages += 1;
    for (const event of page.events) {
      if (event.id === options.excludeEventId) continue;
      const turn = eventToTurn(event);
      if (!turn) continue;
      newestFirst.push(turn);
      if (newestFirst.length >= options.maxMessages) break;
    }
    if (!page.nextToken || page.events.length === 0) break;
    paginationToken = page.nextToken;
  }

  return { turns: newestFirst.reverse(), pages };
}
