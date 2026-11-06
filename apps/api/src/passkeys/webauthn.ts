import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { encodeAbiParameters, toHex, type Hex } from 'viem';
import { Refusal } from '../types.js';

/** The P-256 group order; signatures with s above n/2 are refused (the contract refuses them too). */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N / 2n;

export const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
export const fromBase64url = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
const sha256 = (...parts: Uint8Array[]) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return new Uint8Array(h.digest()); };
const hexBytes = (hex: Hex) => new Uint8Array(Buffer.from(hex.slice(2), 'hex'));
const pad32 = (value: Uint8Array) => { const out = new Uint8Array(32); out.set(value.slice(-32), 32 - Math.min(32, value.length)); return out; };

/** A passkey's public key, as the account stores it. */
export interface PasskeyKey { x: Hex; y: Hex }
/** What the browser returns from `navigator.credentials.get`, with the signature already split and low-s. */
export interface Assertion { credentialId: string; authenticatorData: string; clientDataJSON: string; r: Hex; s: Hex }
/** `WebAuthn.Auth`, the signature the PasskeyAccount decodes (abi.encode of the tuple). */
export interface WebAuthnAuth { authenticatorData: Hex; clientDataJSON: string; challengeIndex: bigint; typeIndex: bigint; r: Hex; s: Hex }

/** The (x, y) of an uncompressed P-256 public key in SPKI DER, as `AuthenticatorAttestationResponse.getPublicKey()` gives it. */
export function keyFromSpki(spki: Uint8Array): PasskeyKey {
  let jwk;
  try { jwk = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' }).export({ format: 'jwk' }); }
  catch { throw new Refusal('invalid_passkey', 'The passkey public key could not be read'); }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Refusal('invalid_passkey', 'Passkeys must use P-256 (ES256)');
  return { x: toHex(pad32(fromBase64url(jwk.x))), y: toHex(pad32(fromBase64url(jwk.y))) };
}

/** Splits a DER ECDSA signature into r and s, with s moved to the low half. */
export function splitDer(der: Uint8Array): { r: Hex; s: Hex } {
  const fail = () => { throw new Refusal('invalid_signature', 'Malformed passkey signature'); };
  if (der[0] !== 0x30) fail();
  let i = 2;
  const read = () => {
    if (der[i] !== 0x02) fail();
    const length = der[i + 1];
    const value = der.slice(i + 2, i + 2 + length);
    i += 2 + length;
    return BigInt(toHex(value));
  };
  const r = read();
  let s = read();
  if (s > HALF_N) s = P256_N - s;
  return { r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }) };
}

/** The clientDataJSON as received, as text. */
const clientText = (clientDataJSON: string) => Buffer.from(clientDataJSON, 'base64url').toString('utf8');

/** Checks a registration (`navigator.credentials.create`) answered the challenge Pact issued, from Pact's origin. */
export function verifyRegistration(input: { clientDataJSON: string; challenge: Uint8Array; origin: string }) {
  let client: { type?: string; challenge?: string; origin?: string };
  try { client = JSON.parse(clientText(input.clientDataJSON)); } catch { throw new Refusal('invalid_passkey', 'Malformed registration'); }
  if (client.type !== 'webauthn.create') throw new Refusal('invalid_passkey', 'Not a passkey registration');
  if (client.challenge !== base64url(input.challenge)) throw new Refusal('challenge_mismatch');
  if (client.origin !== input.origin) throw new Refusal('origin_mismatch');
}

/**
 * Verifies a passkey assertion exactly as `WebAuthn.verify` will on chain (User Present, User Verified,
 * backup flags, `"type":"webauthn.get"`, the challenge, P-256 over sha256(authenticatorData ||
 * sha256(clientDataJSON)), low s), plus what the contract cannot see: the origin and the RP ID hash.
 * Returns the `WebAuthn.Auth` to pass on chain. Throws a Refusal before anything is sent.
 */
export function verifyAssertion(assertion: Assertion, challenge: Uint8Array, key: PasskeyKey, expected: { origin: string; rpId: string }): WebAuthnAuth {
  let authData: Uint8Array, clientBytes: Uint8Array;
  try { authData = fromBase64url(assertion.authenticatorData); clientBytes = fromBase64url(assertion.clientDataJSON); }
  catch { throw new Refusal('invalid_signature', 'Malformed passkey assertion'); }
  if (authData.length < 37) throw new Refusal('invalid_signature', 'Malformed authenticator data');
  if (Buffer.compare(Buffer.from(authData.slice(0, 32)), Buffer.from(sha256(new TextEncoder().encode(expected.rpId)))) !== 0) throw new Refusal('rp_mismatch');
  const flags = authData[32];
  if (!(flags & 0x01)) throw new Refusal('user_not_present');
  if (!(flags & 0x04)) throw new Refusal('user_not_verified', 'Confirm with Face ID, Touch ID or your device PIN');
  if (!(flags & 0x08) && (flags & 0x10)) throw new Refusal('invalid_signature', 'Inconsistent backup flags');
  const text = Buffer.from(clientBytes).toString('utf8');
  let client: { type?: string; challenge?: string; origin?: string };
  try { client = JSON.parse(text); } catch { throw new Refusal('invalid_signature', 'Malformed client data'); }
  if (client.type !== 'webauthn.get') throw new Refusal('invalid_signature', 'Not a passkey assertion');
  if (client.challenge !== base64url(challenge)) throw new Refusal('challenge_mismatch');
  if (client.origin !== expected.origin) throw new Refusal('origin_mismatch');
  // The contract finds these by byte offset in the exact JSON the authenticator signed.
  const typeIndex = text.indexOf('"type":"webauthn.get"');
  const challengeIndex = text.indexOf(`"challenge":"${base64url(challenge)}"`);
  if (typeIndex < 0 || challengeIndex < 0 || Buffer.byteLength(text.slice(0, typeIndex)) !== typeIndex || Buffer.byteLength(text.slice(0, challengeIndex)) !== challengeIndex) throw new Refusal('invalid_signature', 'Unsupported client data layout');
  const r = BigInt(assertion.r), s = BigInt(assertion.s);
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) throw new Refusal('invalid_signature');
  if (s > HALF_N) throw new Refusal('high_s', 'The passkey signature must be normalized to low s');
  const jwk = { kty: 'EC', crv: 'P-256', x: base64url(hexBytes(key.x)), y: base64url(hexBytes(key.y)) };
  const signature = Buffer.concat([Buffer.from(hexBytes(toHex(r, { size: 32 }))), Buffer.from(hexBytes(toHex(s, { size: 32 })))]);
  const valid = verifySignature('sha256', Buffer.concat([Buffer.from(authData), Buffer.from(sha256(clientBytes))]), { key: jwk, format: 'jwk', dsaEncoding: 'ieee-p1363' }, signature);
  if (!valid) throw new Refusal('invalid_signature', 'The passkey signature does not match this account');
  return { authenticatorData: toHex(authData), clientDataJSON: text, challengeIndex: BigInt(challengeIndex), typeIndex: BigInt(typeIndex), r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }) };
}

/** abi.encode(WebAuthn.Auth): the bytes `isValidSignature` and `execute` decode. */
export function encodeAuth(auth: WebAuthnAuth): Hex {
  return encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' },
    { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
  ] }], [auth]);
}
