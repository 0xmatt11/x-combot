/**
 * Outbound copy for this X group bot.
 * A model blurb that names another chat product is rewritten before anyone
 * sees it: a "… reply" becomes a reply-thread, "on/in …" becomes "in this chat",
 * and any other use becomes "chat".
 */

/** Sent to the model only. Chat posts still pass through `asChatCopy`. */
export const CHAT_COPY_RULE =
  "You are an X (Twitter) group DM bot. In any text a person will read, say this chat, a reply-thread, or X. Never write Telegram.";
const OTHER_PRODUCT_REPLY = /\btelegrams?[\s-]+repl(?:y|ies)\b/gi;
const OTHER_PRODUCT_PLACE = /\b(?:on|in|via|from)\s+telegrams?\b/gi;
const OTHER_PRODUCT_TO = /\bto\s+telegrams?\b/gi;
const OTHER_PRODUCT_WORD = /\btelegrams?\b/gi;

export function asChatCopy(text: string): string {
  if (!/telegram/i.test(text)) return text;
  return text
    .replace(OTHER_PRODUCT_REPLY, "reply-thread")
    .replace(OTHER_PRODUCT_PLACE, "in this chat")
    .replace(OTHER_PRODUCT_TO, "to this chat")
    .replace(OTHER_PRODUCT_WORD, "chat");
}
