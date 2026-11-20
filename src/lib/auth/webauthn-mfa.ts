/**
 * Security keys (WebAuthn: YubiKey, platform authenticators) as a second
 * factor next to TOTP (crm#1448). Kept free of Node and browser-only imports:
 * the flag is read by client components and route handlers alike, and the
 * JSON codec runs on both sides of the server-held session.
 *
 * Off by default. Turning it on needs WebAuthn MFA enabled in the Supabase
 * Auth settings as well; until then GoTrue refuses the enrolment. The flag
 * gates ENROLMENT only: a factor that already exists can always be used to
 * reach AAL2, so switching the flag off never locks anyone out.
 */

import { flagEnabled, isSelfHosted } from '@/lib/env/public-flags'

export function isWebauthnMfaEnabled(): boolean {
  if (isSelfHosted()) return false
  return flagEnabled(process.env.NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED)
}

/** WebAuthn binary fields travel as base64url (no padding) in JSON. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Turn credential options back into their JSON form. auth-js decodes the
 * challenge options into ArrayBuffers for a browser caller; here the call
 * runs on the server, so every binary field is re-encoded as base64url
 * before the options cross to the browser. Plain values pass through.
 */
export function toWebauthnJson(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return bytesToBase64Url(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) {
    return bytesToBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (Array.isArray(value)) return value.map(toWebauthnJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, toWebauthnJson(inner)]),
    )
  }
  return value
}
