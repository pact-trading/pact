import type { PasskeyRegistration, PasskeyRegistrationOptions, PasskeyRequest } from '@/server/data/types';

/**
 * Browser WebAuthn for passkey accounts. ES256 (P-256) only, user verification required: the account
 * contract refuses an assertion without it. Whitechain verifies P-256 natively (RIP-7212 at 0x100).
 */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const toBase64url = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const fromBase64url = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
};
const hex32 = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;

/** The user backed out of the passkey prompt (or it timed out). */
export class PasskeyCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PasskeyCancelled';
  }
}
const cancelled = (error: unknown) =>
  error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name);

export const passkeysSupported = () =>
  typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

/** Creates the passkey and returns what Pact stores: its id, SPKI public key and the signed client data. */
export async function createPasskey(options: PasskeyRegistrationOptions): Promise<PasskeyRegistration> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: fromBase64url(options.challenge),
        rp: options.rp,
        user: {
          id: fromBase64url(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
        timeout: options.timeout,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    if (cancelled(error)) throw new PasskeyCancelled();
    throw error;
  }
  if (!credential) throw new PasskeyCancelled();
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey?.();
  if (!publicKey)
    throw new Error('This browser cannot create a passkey account. Try a current Chrome, Safari or Firefox.');
  return {
    credentialId: toBase64url(credential.rawId),
    publicKey: toBase64url(publicKey),
    clientDataJSON: toBase64url(response.clientDataJSON),
  };
}

/** r and s from a DER ECDSA signature, with s moved to the low half (the account refuses a high s). */
function splitDer(der: Uint8Array) {
  if (der[0] !== 0x30) throw new Error('Malformed passkey signature');
  let i = 2;
  const read = () => {
    if (der[i] !== 0x02) throw new Error('Malformed passkey signature');
    const length = der[i + 1];
    let value = 0n;
    for (const b of der.slice(i + 2, i + 2 + length)) value = (value << 8n) | BigInt(b);
    i += 2 + length;
    return value;
  };
  const r = read();
  let s = read();
  if (s > P256_N / 2n) s = P256_N - s;
  return { r: hex32(r), s: hex32(s) };
}

/** Confirms with the passkey: the assertion, as the JSON string the submit takes as its signature. */
export async function passkeyAssertion(request: PasskeyRequest): Promise<string> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64url(request.challenge),
        rpId: request.rpId,
        allowCredentials: request.allowCredentials.map(id => ({
          type: 'public-key' as const,
          id: fromBase64url(id),
        })),
        userVerification: request.userVerification,
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    if (cancelled(error)) throw new PasskeyCancelled();
    throw error;
  }
  if (!credential) throw new PasskeyCancelled();
  const response = credential.response as AuthenticatorAssertionResponse;
  const { r, s } = splitDer(new Uint8Array(response.signature));
  return JSON.stringify({
    credentialId: toBase64url(credential.rawId),
    authenticatorData: toBase64url(response.authenticatorData),
    clientDataJSON: toBase64url(response.clientDataJSON),
    r,
    s,
  });
}
