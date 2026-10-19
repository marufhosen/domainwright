/**
 * Web Crypto helpers. `crypto.subtle` and `crypto.randomUUID` are available in
 * Node.js 18+ (global `crypto`) and in Cloudflare Workers.
 */

import { ConfigurationError } from '../core/errors.js';

function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new ConfigurationError('Web Crypto (globalThis.crypto.subtle) is required but not available in this runtime');
  }
  return c;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** HMAC-SHA256 of `message` keyed with `secret`, encoded as base64url. */
export async function hmacBase64Url(secret: string, message: string): Promise<string> {
  const c = getCrypto();
  const encoder = new TextEncoder();
  const key = await c.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await c.subtle.sign('HMAC', key, encoder.encode(message));
  return toBase64Url(new Uint8Array(signature));
}

export function randomId(): string {
  return getCrypto().randomUUID();
}

/** Length-independent string comparison for tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
