import { createPublicKey } from "node:crypto";
import type { SigningKeyEntry } from "./cipher.js";
import type { RemotePublicKey } from "./wire.js";

/**
 * chat-xdk drops a signing key unless `identityPublicKeySignature` verifies
 * over the identity key's exact bytes (SPKI on the wire). A raw SEC1 point,
 * or URL-safe base64, fails that check and every KeyChange then reports
 * "signature missing or no matching signing key" even though the API returned
 * the key. Rewrite each record into the encoding that binds.
 */
export function boundSigningEntries(
  keys: RemotePublicKey[],
  verify: (identityPublicKey: string, signingPublicKey: string, signature: string) => boolean,
): { entries: SigningKeyEntry[]; unboundVersions: string[] } {
  const entries: SigningKeyEntry[] = [];
  const unboundVersions: string[] = [];
  for (const key of keys) {
    const signature = normalizeStandardBase64(key.identityPublicKeySignature);
    const bound = firstBinding(key.publicKey, key.signingPublicKey, signature, verify);
    if (!bound) {
      unboundVersions.push(key.publicKeyVersion);
      const identity = keyEncodings(key.publicKey)[0] ?? normalizeStandardBase64(key.publicKey);
      const signing = keyEncodings(key.signingPublicKey)[0] ?? normalizeStandardBase64(key.signingPublicKey);
      entries.push(entry(key, identity, signing, signature));
      continue;
    }
    entries.push(entry(key, bound.identity, bound.signing, signature));
  }
  return { entries, unboundVersions };
}

function entry(
  key: RemotePublicKey,
  identity: string,
  signing: string,
  signature: string,
): SigningKeyEntry {
  return {
    userId: key.userId,
    publicKeyVersion: key.publicKeyVersion,
    publicKey: signing,
    identityPublicKey: identity,
    identityPublicKeySignature: signature,
  };
}

function firstBinding(
  identityKey: string,
  signingKey: string,
  signature: string,
  verify: (identityPublicKey: string, signingPublicKey: string, signature: string) => boolean,
): { identity: string; signing: string } | undefined {
  if (!signature) return undefined;
  for (const identity of keyEncodings(identityKey)) {
    for (const signing of keyEncodings(signingKey)) {
      try {
        if (verify(identity, signing, signature)) return { identity, signing };
      } catch {
        // try the next encoding
      }
    }
  }
  return undefined;
}

/** Standard and URL-safe base64, SEC1 (65 or 64 bytes) and SPKI (91 bytes). */
export function keyEncodings(material: string): string[] {
  const normalized = normalizeStandardBase64(material);
  if (!normalized) return [];
  const out: string[] = [];
  const push = (value: string | undefined) => {
    if (value && !out.includes(value)) out.push(value);
  };
  push(normalized);
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 91) push(bytes.subarray(26).toString("base64"));
  if (bytes.length === 65 && bytes[0] === 0x04) push(sec1ToSpki(bytes));
  if (bytes.length === 64) {
    const sec1 = Buffer.concat([Buffer.from([0x04]), bytes]);
    push(sec1.toString("base64"));
    push(sec1ToSpki(sec1));
  }
  return out;
}

export function normalizeStandardBase64(value: string): string {
  const trimmed = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!trimmed) return "";
  const remainder = trimmed.length % 4;
  const pad = remainder === 0 ? "" : "=".repeat(4 - remainder);
  return `${trimmed}${pad}`;
}

function sec1ToSpki(sec1: Buffer): string | undefined {
  if (sec1.length !== 65 || sec1[0] !== 0x04) return undefined;
  try {
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: sec1.subarray(1, 33).toString("base64url"),
        y: sec1.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    return Buffer.from(key.export({ format: "der", type: "spki" })).toString("base64");
  } catch {
    return undefined;
  }
}
