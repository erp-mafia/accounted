/**
 * The completed identification, carried inside the signed flow cookie.
 *
 * Why it exists
 * -------------
 * TIC serves a completed identification (status `complete` plus `user`) at
 * most TWICE per session, across `/auth/{id}/poll` and `/auth/{id}/collect`.
 * Every later fetch answers status `collected` with no user. The same-device
 * flow on iPhone Safari spends three: BankID returns by reloading the login
 * tab, the mount probe polls (one), the "Fortsätt" tap polls again (two), and
 * /complete then asked TIC to collect (three) and got nothing, so it answered
 * 400 and cleared the cookie. The identification the person had just made was
 * thrown away (issue #2471).
 *
 * So the FIRST delivery is kept. /poll seals the user into the flow cookie the
 * moment TIC reports completion, and every later read (probe, active poll,
 * /complete, /link) opens it from there. One identification, one TIC fetch.
 *
 * Why it is encrypted, not merely signed
 * --------------------------------------
 * The signup path stores the raw personnummer (bankid_identities
 * .personal_number_enc), so the raw value has to travel. The cookie is
 * HttpOnly, Secure and `__Host-`, and its HMAC signature already stops
 * forgery, but the payload is only base64: a signature alone would put a
 * personnummer in the clear in the cookie jar. The user object is therefore
 * AES-256-GCM encrypted with the same key that protects it at rest, and the
 * signature covers the ciphertext.
 *
 * Kept out of bankid-flow-cookie.ts on purpose: that module is WebCrypto only
 * and validates shape; this one needs Node's crypto.
 */

import { decryptPersonalNumber, encryptPersonalNumber } from '@/lib/auth/bankid'
import type { BankIdFlowResult, BankIdFlowState } from './bankid-flow-cookie'
import type { BankIdUser } from './bankid-types'

/** Encrypt a completed identification for the flow cookie. */
export function sealBankIdResult(user: BankIdUser, now: number = Date.now()): BankIdFlowResult {
  const plain: BankIdUser = {
    personalNumber: user.personalNumber,
    givenName: user.givenName,
    surname: user.surname,
    name: user.name,
  }
  return {
    enc: encryptPersonalNumber(JSON.stringify(plain)).toString('base64url'),
    completedAt: now,
  }
}

/**
 * Decrypt the identification a flow cookie carries, or null when it carries
 * none or the ciphertext does not open (wrong key, tampered, wrong shape).
 * Null means "ask TIC", exactly as before this field existed.
 */
export function openBankIdResult(flow: BankIdFlowState): BankIdUser | null {
  if (!flow.result) return null
  try {
    const parsed: unknown = JSON.parse(
      decryptPersonalNumber(Buffer.from(flow.result.enc, 'base64url')),
    )
    if (!parsed || typeof parsed !== 'object') return null
    const user = parsed as Partial<BankIdUser>
    if (typeof user.personalNumber !== 'string' || !user.personalNumber) return null
    if (typeof user.givenName !== 'string') return null
    if (typeof user.surname !== 'string') return null
    if (typeof user.name !== 'string') return null
    return {
      personalNumber: user.personalNumber,
      givenName: user.givenName,
      surname: user.surname,
      name: user.name,
    }
  } catch {
    return null
  }
}
