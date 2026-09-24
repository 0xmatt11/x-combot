const CHAT_GROUP_ID = /^g[0-9]{1,19}$/;

export const CHAT_WATERMARK_PREFIX = "chat_events:";

/** Encrypted X Chat group ids from `/i/chat/g…`. Classic group DMs are bare snowflakes. */
export function isChatGroupId(conversationId: string | undefined): boolean {
  return Boolean(conversationId && CHAT_GROUP_ID.test(conversationId));
}

/** Strip an `xchat:` prefix and keep only encrypted group ids. */
export function canonicalChatGroupId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let id = raw.trim();
  if (id.startsWith("xchat:")) id = id.slice("xchat:".length);
  return isChatGroupId(id) ? id : undefined;
}

export function watermarkKey(conversationId: string): string {
  return `${CHAT_WATERMARK_PREFIX}${conversationId}`;
}

/**
 * Parse a comma-separated list of encrypted X Chat group ids.
 * Empty is allowed. Rejects classic snowflakes and 1:1 ids so they are not sent to `/2/chat`.
 */
export function parseChatConversationIds(
  raw: string | undefined,
  envName = "CHAT_CONVERSATION_IDS",
): string[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!isChatGroupId(id)) {
      throw new Error(
        `${envName} entry "${id}" is not an encrypted X Chat group id. Expected g plus digits (for example g2029561975647150382). Classic group DMs stay on GET /2/dm_events and must not be listed here.`,
      );
    }
  }
  return ids;
}
