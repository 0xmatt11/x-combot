import type { LiveXClient } from "../x/live-client.js";
import type { ChatHttp } from "./http.js";

export function chatHttpFromLive(client: LiveXClient): ChatHttp {
  return {
    getConversationEvents: (conversationId, params) =>
      client.getChatConversationEvents(conversationId, params),
    getMemberIds: (conversationId) => client.getChatMemberIds(conversationId),
    getUserPublicKeys: (userId) => client.getUserPublicKeys(userId),
    sendChatMessage: (conversationId, body) => client.sendChatMessage(conversationId, body),
    deleteChatMessages: (conversationId, body) => client.deleteChatMessages(conversationId, body),
    addConversationKeys: (conversationId, body) =>
      client.addChatConversationKeys(conversationId, body),
    addUserPublicKey: (userId, body) => client.addUserPublicKey(userId, body),
    uploadChatMedia: (conversationId, ciphertext) =>
      client.uploadChatMedia(conversationId, ciphertext),
    downloadChatMedia: (conversationId, mediaHashKey) =>
      client.downloadChatMedia(conversationId, mediaHashKey),
    listConversations: (params) => client.listChatConversations(params),
  };
}
