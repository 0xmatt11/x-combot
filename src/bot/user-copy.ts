/**
 * Outbound copy for this X group bot.
 * A model blurb that names another chat product is rewritten before anyone
 * sees it: a "… reply" becomes a reply-thread, "on/in …" becomes "in this chat",
 * and any other use becomes "chat".
 */
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
