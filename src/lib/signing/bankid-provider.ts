/**
 * Core <-> TIC boundary for BankID signing.
 *
 * `lib/` and `app/api/v1/` cannot import from `@/extensions/` (CI guard), so
 * the signing ceremony reaches TIC Identity only through the registry-resolved
 * `services` channel, the seam lib/skatteverket/extension-actions.ts uses.
 * This module holds the shared shapes, so the TIC extension (which may import
 * core) and core agree without core importing the extension.
 *
 * The services never throw across the seam: a provider failure is a result.
 * They hide TIC's own rules from core: a completed sign session's result is
 * handed out at most twice (poll and collect combined, #2471), so
 * pollBankIdSignature collects the signature in the same call that sees the
 * session complete, and answers `gone` when TIC will not hand it out again.
 *
 * BankID is hosted-only: with the flag off (always off self-hosted) or the
 * TIC extension not registered, resolveBankIdSigning answers null and every
 * signing door answers SIGNING_UNAVAILABLE.
 */
import { isBankIdEnabled } from '@/lib/auth/bankid-flags'
import { extensionRegistry } from '@/lib/extensions/registry'

export interface BankIdSignStartInput {
  /** The signer's IP as the proxy forwarded it; BankID requires it. */
  endUserIp: string
  userAgent?: string
  /** simpleMarkdownV1, shown in the BankID app and bound by the signature. */
  userVisibleData: string
  /** Bound by the signature, not shown: the document hash and ids. */
  userNonVisibleData: string
  /** 12 digits; when set, only this person can sign the order. */
  personalNumber?: string
}

export interface BankIdSignStarted {
  sessionId: string
  autoStartToken: string
  qrStartToken: string
  qrStartSecret: string
  expiresAt: string
}

/** A completed signature, collected once. Carries a full personnummer: never log it. */
export interface CollectedBankIdSignature {
  personalNumber: string
  givenName: string
  surname: string
  name: string
  completedAt: string
  /** XML-DSig, base64. */
  signatureXml: string
  /** OCSP response, base64. */
  ocspResponse: string
}

export type BankIdSignPoll =
  | { status: 'pending'; hintCode: string | null; qrStartToken: string | null; qrStartSecret: string | null }
  | { status: 'complete'; signature: CollectedBankIdSignature }
  | { status: 'failed'; hintCode: string | null }
  | { status: 'cancelled' }
  /** The session is unknown or expired, or TIC already handed its result out. */
  | { status: 'gone' }

export type BankIdSigningFailureCode = 'NOT_CONFIGURED' | 'RATE_LIMITED' | 'TIMEOUT' | 'PROVIDER_ERROR'

export interface BankIdSigningFailure {
  ok: false
  code: BankIdSigningFailureCode
  httpStatus?: number
}

export type BankIdSigningResult<T> = { ok: true; data: T } | BankIdSigningFailure

/** What the TIC extension exposes on `services` for signing. */
export interface BankIdSigningServices {
  startBankIdSignature: (input: BankIdSignStartInput) => Promise<BankIdSigningResult<BankIdSignStarted>>
  pollBankIdSignature: (sessionId: string) => Promise<BankIdSigningResult<BankIdSignPoll>>
  cancelBankIdSignature: (sessionId: string) => Promise<BankIdSigningResult<null>>
}

const SERVICE_KEYS = ['startBankIdSignature', 'pollBankIdSignature', 'cancelBankIdSignature'] as const

/** The wired signing provider, or null when BankID signing is unavailable here. */
export async function resolveBankIdSigning(): Promise<BankIdSigningServices | null> {
  if (!isBankIdEnabled()) return null
  const wired = (await extensionRegistry.get('tic'))?.services as Partial<BankIdSigningServices> | undefined
  if (!wired || SERVICE_KEYS.some((key) => typeof wired[key] !== 'function')) return null
  return wired as BankIdSigningServices
}
