/**
 * Narrow view of `@xdevplatform/chat-xdk` used by the Chat transport.
 * Tests substitute a fixture cipher; production wraps the WASM engine.
 */

export interface SigningKeyEntry {
  userId: string;
  publicKeyVersion: string;
  publicKey: string;
  identityPublicKey: string;
  identityPublicKeySignature: string;
}

export interface DecryptedEvent {
  type?: string;
  id?: string | null;
  sequenceId?: string | null;
  senderId?: string | null;
  conversationId?: string | null;
  createdAtMsec?: number | null;
  verified?: boolean;
  content?: {
    contentType?: string;
    text?: string;
  };
  changeType?: string;
  memberIds?: string[];
  change?: { changeType?: string; memberIds?: string[] };
  groupChange?: { changeType?: string; memberIds?: string[] };
}

export interface DecryptEventsResult {
  messages: { event: DecryptedEvent; originalB64?: string }[];
  errors: Record<string, string>;
}

export interface SendPayload {
  messageId: string;
  encryptedContent: string;
  encodedEventSignature: string;
}

export interface ActionSignature {
  messageId: string;
  encodedMessageEventDetail: string;
  signature: string;
  signatureVersion: string;
  publicKeyVersion: string;
  signaturePayload?: string;
}

export interface PreparedKeyChange {
  conversationId: string;
  conversationKeyVersion: string;
  participantKeys: { userId: string; encryptedKey: string; publicKeyVersion: string }[];
  actionSignatures: ActionSignature[];
}

export interface PublicKeyMaterial {
  userId: string;
  publicKey: string;
  keyVersion: string;
}

export interface ChatCipher {
  setSigningKeys(keys: SigningKeyEntry[]): void;
  decryptEvents(eventsB64: string[]): DecryptEventsResult;
  encryptMessage(conversationId: string, text: string): SendPayload;
  prepareMessageDelete(
    conversationId: string,
    sequenceIds: string[],
    deleteForAll: boolean,
  ): ActionSignature;
  prepareConversationKeyChange(params: {
    conversationId: string;
    publicKeys: PublicKeyMaterial[];
  }): PreparedKeyChange;
  signingPublicKey(): string;
}
