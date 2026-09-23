const CHAT_GROUP_ID = /^g[0-9]{1,19}$/;

/** Encrypted X Chat group ids from `/i/chat/g…`. Classic group DMs are bare snowflakes. */
export function isChatGroupId(conversationId: string | undefined): boolean {
  return Boolean(conversationId && CHAT_GROUP_ID.test(conversationId));
}

/**
 * Parse `CHAT_CONVERSATION_IDS`. Empty means classic DM polling only.
 * Rejects classic snowflakes and 1:1 ids so they are not sent to `/2/chat`.
 */
export function parseChatConversationIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!isChatGroupId(id)) {
      throw new Error(
        `CHAT_CONVERSATION_IDS entry "${id}" is not an encrypted X Chat group id. Expected g plus digits (for example g2029561975647150382). Classic group DMs stay on GET /2/dm_events and must not be listed here.`,
      );
    }
  }
  return ids;
}
