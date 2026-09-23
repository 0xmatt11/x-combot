import type { ActionSignature, PreparedKeyChange } from "./cipher.js";

export interface RemotePublicKey {
  userId: string;
  publicKeyVersion: string;
  /** Identity public key (`public_key`). */
  publicKey: string;
  /** Signing public key (`signing_public_key`). */
  signingPublicKey: string;
  identityPublicKeySignature: string;
  juiceboxConfig?: unknown;
}

export function normalizePublicKeys(body: unknown, userId: string): RemotePublicKey[] {
  const records = unwrapKeyRecords(body);
  const keys: RemotePublicKey[] = [];
  for (const record of records) {
    const publicKey = stringField(record, "public_key", "publicKey");
    const signingPublicKey = stringField(record, "signing_public_key", "signingPublicKey");
    const identityPublicKeySignature = stringField(
      record,
      "identity_public_key_signature",
      "identityPublicKeySignature",
    );
    const publicKeyVersion =
      stringField(record, "public_key_version", "publicKeyVersion") ||
      stringField(record, "version", "keyVersion");
    if (!publicKey || !signingPublicKey || !identityPublicKeySignature || !publicKeyVersion) {
      continue;
    }
    const juicebox = record.juicebox_config ?? record.juiceboxConfig;
    keys.push({
      userId,
      publicKey,
      signingPublicKey,
      identityPublicKeySignature,
      publicKeyVersion,
      juiceboxConfig: juicebox,
    });
  }
  return keys;
}

export function latestPublicKey(keys: RemotePublicKey[]): RemotePublicKey | undefined {
  return [...keys].sort((a, b) => versionRank(b.publicKeyVersion) - versionRank(a.publicKeyVersion))[0];
}

/**
 * Newest registered key that carries a Juicebox config. The account's latest
 * public key is not always the one Juicebox can recover (a later
 * `generateKeypairs` registration may have no `juicebox_config`).
 */
export function publicKeyWithJuicebox(keys: RemotePublicKey[]): RemotePublicKey | undefined {
  return [...keys]
    .filter((key) => key.juiceboxConfig !== undefined && key.juiceboxConfig !== null)
    .sort((a, b) => versionRank(b.publicKeyVersion) - versionRank(a.publicKeyVersion))[0];
}

export interface RotationMemberKeys {
  userId: string;
  keys: RemotePublicKey[];
}

export interface LoadedIdentityVersion {
  userId: string;
  publicKeyVersion: string;
  publicKey: string;
}

/**
 * Public keys to pass to `prepareConversationKeyChange`.
 *
 * chat-xdk 0.5 groups by user id and wraps only the newest version in the
 * list. Passing every account version for this bot therefore wraps a newer
 * key than the one the process loaded, and the process cannot decrypt.
 * For the loaded user, versions newer than the loaded identity are omitted
 * so the loaded version is the newest entry and gets the wrap. Older versions
 * of that user stay in the list. Every other member's versions are passed
 * through (the SDK wraps their newest).
 */
export function participantKeysForRotation(
  members: RotationMemberKeys[],
  loaded?: LoadedIdentityVersion,
): { userId: string; publicKey: string; keyVersion: string }[] {
  const selected: { userId: string; publicKey: string; keyVersion: string }[] = [];
  for (const member of members) {
    let keys = member.keys;
    if (loaded && member.userId === loaded.userId) {
      const known = keys.some(
        (key) => key.publicKeyVersion === loaded.publicKeyVersion || key.publicKey === loaded.publicKey,
      );
      if (!known && loaded.publicKey && loaded.publicKeyVersion) {
        keys = [
          ...keys,
          {
            userId: member.userId,
            publicKeyVersion: loaded.publicKeyVersion,
            publicKey: loaded.publicKey,
            signingPublicKey: "",
            identityPublicKeySignature: "",
          },
        ];
      }
      const ceiling = versionRank(loaded.publicKeyVersion);
      keys = keys.filter((key) => {
        if (key.publicKeyVersion === loaded.publicKeyVersion || key.publicKey === loaded.publicKey) {
          return true;
        }
        return versionRank(key.publicKeyVersion) < ceiling;
      });
    }
    for (const key of keys) {
      selected.push({
        userId: member.userId,
        publicKey: key.publicKey,
        keyVersion: key.publicKeyVersion,
      });
    }
  }
  return selected;
}

export function toSigningEntries(keys: RemotePublicKey[]) {
  return keys.map((key) => ({
    userId: key.userId,
    publicKeyVersion: key.publicKeyVersion,
    publicKey: key.signingPublicKey,
    identityPublicKey: key.publicKey,
    identityPublicKeySignature: key.identityPublicKeySignature,
  }));
}

export interface GeneratedRegistration {
  publicKey: {
    publicKey: string;
    signingPublicKey: string;
    identityPublicKeySignature: string;
    signingPublicKeySignature?: string;
    registrationMethod?: string;
  };
  version?: string | number;
  generateVersion?: boolean;
}

/** Snake-case body for `POST /2/users/{id}/public_keys`. */
export function publicKeyRegistrationBody(reg: GeneratedRegistration): {
  public_key: Record<string, string | undefined>;
  version: string;
  generate_version: boolean;
} {
  const version = reg.version === undefined || reg.version === null ? "" : String(reg.version);
  if (!version) {
    throw new Error("generateKeypairs did not return a public key version.");
  }
  return {
    public_key: {
      public_key: reg.publicKey.publicKey,
      signing_public_key: reg.publicKey.signingPublicKey,
      identity_public_key_signature: reg.publicKey.identityPublicKeySignature,
      signing_public_key_signature: reg.publicKey.signingPublicKeySignature,
      registration_method: reg.publicKey.registrationMethod,
    },
    version,
    generate_version: Boolean(reg.generateVersion),
  };
}

export function sendMessageBody(
  payload: { messageId: string; encryptedContent: string; encodedEventSignature: string },
  conversationToken?: string,
): Record<string, string> {
  const body: Record<string, string> = {
    message_id: payload.messageId,
    encoded_message_create_event: payload.encryptedContent,
    encoded_message_event_signature: payload.encodedEventSignature,
  };
  if (conversationToken) body.conversation_token = conversationToken;
  return body;
}

export function deleteMessagesBody(
  signature: ActionSignature,
  signingPublicKey: string,
  sequenceIds: string[],
  deleteForAll: boolean,
): Record<string, unknown> {
  return {
    sequence_ids: sequenceIds,
    delete_message_action: deleteForAll ? "delete_for_all" : "delete_for_self",
    action_signatures: [actionSignatureBody(signature, signingPublicKey)],
  };
}

/** Snake-case body for `POST /2/chat/conversations/{id}/keys`. */
export function addConversationKeysBody(
  prepared: PreparedKeyChange,
  signingPublicKey: string,
): Record<string, unknown> {
  return {
    conversation_key_version: prepared.conversationKeyVersion,
    conversation_participant_keys: prepared.participantKeys.map((key) => ({
      user_id: String(key.userId),
      encrypted_conversation_key: key.encryptedKey,
      public_key_version: String(key.publicKeyVersion),
    })),
    action_signatures: prepared.actionSignatures.map((signature) =>
      actionSignatureBody(signature, signingPublicKey),
    ),
  };
}

function actionSignatureBody(
  signature: ActionSignature,
  signingPublicKey: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    message_id: signature.messageId,
    encoded_message_event_detail: signature.encodedMessageEventDetail,
    message_event_signature: {
      signature: signature.signature,
      public_key_version: signature.publicKeyVersion,
      signature_version: signature.signatureVersion,
      signing_public_key: signingPublicKey,
    },
  };
  if (signature.signaturePayload) {
    body.signature_payload = signature.signaturePayload;
  }
  return body;
}

function unwrapKeyRecords(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const data = root.data ?? root;
  const records = (() => {
    if (Array.isArray(data)) return data.filter(isRecord);
    if (!isRecord(data)) return [];
    if (Array.isArray(data.public_keys)) return data.public_keys.filter(isRecord);
    if (Array.isArray(data.keys)) return data.keys.filter(isRecord);
    if (stringField(data, "public_key", "publicKey") || isRecord(data.public_key) || isRecord(data.publicKey)) {
      return [data];
    }
    return [];
  })();
  return records.map(flattenKeyRecord);
}

/** Some responses nest key material under `public_key` and put the version beside it. */
function flattenKeyRecord(record: Record<string, unknown>): Record<string, unknown> {
  const nested = record.public_key ?? record.publicKey;
  if (!isRecord(nested)) return record;
  return { ...nested, ...record, public_key: nested.public_key ?? nested.publicKey };
}

function stringField(record: Record<string, unknown>, snake: string, camel: string): string {
  const value = record[snake] ?? record[camel];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function memberIdsFromConversation(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const data = (
    root.data && typeof root.data === "object" ? root.data : root
  ) as Record<string, unknown>;
  const ids = new Set<string>();
  for (const key of [
    "member_ids",
    "admin_ids",
    "participant_ids",
    "memberIds",
    "adminIds",
    "participantIds",
  ]) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}

function versionRank(version: string): number {
  const asNumber = Number(version);
  return Number.isFinite(asNumber) ? asNumber : 0;
}
