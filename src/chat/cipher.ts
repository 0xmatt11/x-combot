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
  /**
   * chat-xdk: `"valid"` when the embedded signed original matches the preview.
   * `"invalid"` (or absent) means the preview sender is untrusted.
   * The WASM build uses this camelCase name; `reply_preview_validation` is accepted too.
   */
  replyPreviewValidation?: string;
  reply_preview_validation?: string;
  content?: {
    contentType?: string;
    /** WASM decrypt uses snake_case for this discriminator. */
    content_type?: string;
    text?: string;
    /** chat-xdk types this as `unknown`. Shape is read in `trustedReplySenderId`. */
    replyingToPreview?: unknown;
    /** WASM decrypt uses snake_case for the preview object. */
    replying_to_preview?: unknown;
  };
  changeType?: string;
  memberIds?: string[];
  change?: { changeType?: string; memberIds?: string[] };
  groupChange?: { changeType?: string; memberIds?: string[] };
}

export interface ConversationKeySet {
  /** version → raw 32-byte conversation key */
  keys: Record<string, Uint8Array>;
  latestVersion: string | null;
}

export interface DecryptEventsResult {
  messages: { event: DecryptedEvent; originalB64?: string }[];
  errors: Record<string, string>;
  /** Keys extracted while decrypting. Also feeds the WASM key cache when caching is on. */
  conversationKeys?: ConversationKeySet;
}

/**
 * Inline Chat photo. `mediaType` omitted (or `1`) renders in the bubble.
 * Do not set a file/document type.
 */
export interface ChatMediaAttachment {
  mediaHashKey: string;
  width: number;
  height: number;
  /** Plaintext image size in bytes. */
  filesizeBytes: number;
  filename: string;
  /** Omit for an inline image. `1` image, `2` gif, `3` video. */
  mediaType?: number;
}

export interface EncryptMessageOptions {
  conversationKey?: Uint8Array;
  conversationKeyVersion?: string;
  attachments?: ChatMediaAttachment[];
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

/** The key this process can decrypt with (file or Juicebox), not "latest on the account". */
export interface LoadedChatIdentity {
  userId: string;
  version: string;
  /** Identity public key as registered, usually SPKI. */
  publicKey: string;
}

export interface ChatCipher {
  /** Set when the cipher was opened from a key file or a Juicebox unlock. */
  identity?: LoadedChatIdentity;
  setSigningKeys(keys: SigningKeyEntry[]): void;
  decryptEvents(eventsB64: string[], signingKeys?: SigningKeyEntry[]): DecryptEventsResult;
  /**
   * True when `identityPublicKeySignature` is a valid binding of `signingPublicKey`
   * over the exact bytes of `identityPublicKey`.
   */
  verifyKeyBinding(
    identityPublicKey: string,
    signingPublicKey: string,
    identityPublicKeySignature: string,
  ): boolean;
  /** True when `publicKey` is the identity loaded in this process (SEC1 or SPKI). */
  matchesRegisteredKey(publicKey: string): boolean;
  loadedIdentity(): LoadedChatIdentity | undefined;
  encryptMessage(conversationId: string, text: string, options?: EncryptMessageOptions): SendPayload;
  /** Streaming encrypt for Chat media (`encryptStream` / secretstream). */
  encryptStream(plaintext: Uint8Array, conversationKey: Uint8Array): Uint8Array;
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
