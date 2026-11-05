/** Verify the raw request body before JSON parsing. Signature is a hex HMAC-SHA256, optionally prefixed with sha256=. */
export async function verifyWebhook(body: string | Uint8Array, signature: string, secret: string): Promise<boolean> {
  const hex = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[a-f\d]{64}$/i.test(hex) || !secret) return false;
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, bytes, typeof body === 'string' ? encoder.encode(body) : new Uint8Array(body));
}

export const webhooks = { verify: verifyWebhook };
