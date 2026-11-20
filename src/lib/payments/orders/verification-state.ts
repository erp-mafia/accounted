/**
 * Where a company's verification (know your customer) at the payment provider
 * stands, derived from the stored record (company_payment_verifications) in one
 * pure function, so every surface (the Koppla banken step, the Betalningar
 * page, the payment dialog, the machine doors and the worklist) tells the same
 * story:
 *
 *   not_started          nothing on file, no form ever created
 *   form_open            a form link exists, created less than 24 hours ago
 *   awaiting_signatory   that form was handed to a firmatecknare (mailed or
 *                        copied for them) and is still live
 *   link_expired         the newest form link is older than 24 hours and the
 *                        provider has not answered valid: a new link is needed
 *   valid                the provider answers valid, with the date it holds to
 *   expiring             valid, but that date is within 30 days
 *   expired              that date has passed, or the provider answers invalid
 *                        after the company was once verified
 *
 * A live form link outranks a lapsed verification (a renewal in progress is a
 * renewal in progress), and a link created after the lapse keeps the link
 * states when it runs out; a link older than the lapse is history, and the
 * state is expired. Dates are Swedish calendar days (validUntil is a date the
 * provider grants "through"); the 24 hours are an instant.
 */

import { daysBetweenIso, endOfDayIsoStockholm, todayIsoStockholm } from '@/lib/dates/iso'

export const VERIFICATION_STATES = ['not_started', 'form_open', 'awaiting_signatory', 'link_expired', 'valid', 'expiring', 'expired'] as const

export type VerificationState = (typeof VERIFICATION_STATES)[number]

export type ProviderVerificationStatus = 'valid' | 'invalid' | 'unknown'

/** The hosted form link is accessible for 24 hours (the provider's documented limit). */
export const VERIFICATION_LINK_TTL_MS = 24 * 60 * 60 * 1000

/** A verification inside its last 30 days is expiring: the nudge starts and the state says so. */
export const VERIFICATION_RENEWAL_NOTICE_DAYS = 30

/** The stored record, as the state needs it (link_url is never part of this). */
export interface VerificationRecordLike {
  status: ProviderVerificationStatus
  /** YYYY-MM-DD, the date the provider reports the verification valid through. */
  valid_until: string | null
  /** ISO instants. */
  link_created_at: string | null
  link_expires_at: string | null
  handed_off_at: string | null
}

export interface DerivedVerification {
  state: VerificationState
  status: ProviderVerificationStatus
  valid_until: string | null
  /** The current form link's expiry, while a link exists (live or not); null without one. */
  link_expires_at: string | null
  /** Whole days from today (Stockholm) to valid_until; negative once passed; null without a date. */
  days_left: number | null
  /** A live form link exists while the verification is still valid or expiring: a renewal in progress. */
  renewal_form_open: boolean
}

/** States in which a form link is out and the provider may answer valid any moment: readers refresh. */
export const FORM_OUT_STATES: ReadonlySet<VerificationState> = new Set(['form_open', 'awaiting_signatory'])

/** States the renewal nudge shows a worklist row for. */
export const RENEWAL_DUE_STATES: ReadonlySet<VerificationState> = new Set(['expiring', 'expired'])

/** States in which a new form link is the way forward (the button says Verifiera, Förnya or Skapa ny länk). */
export const NEEDS_LINK_STATES: ReadonlySet<VerificationState> = new Set(['not_started', 'link_expired', 'expiring', 'expired'])

/** The expiry of a form link created at `createdAt`, as an ISO instant. */
export function verificationLinkExpiresAt(createdAt: Date): string {
  return new Date(createdAt.getTime() + VERIFICATION_LINK_TTL_MS).toISOString()
}

function linkIsLive(record: VerificationRecordLike, now: Date): boolean {
  if (!record.link_created_at) return false
  const expires = record.link_expires_at ? new Date(record.link_expires_at).getTime() : new Date(record.link_created_at).getTime() + VERIFICATION_LINK_TTL_MS
  return now.getTime() < expires
}

export function deriveVerificationState(record: VerificationRecordLike | null, now: Date = new Date()): DerivedVerification {
  const today = todayIsoStockholm(now)
  const empty: DerivedVerification = { state: 'not_started', status: 'unknown', valid_until: null, link_expires_at: null, days_left: null, renewal_form_open: false }
  if (!record) return empty

  const daysLeft = record.valid_until ? daysBetweenIso(today, record.valid_until) : null
  const live = linkIsLive(record, now)
  const base = {
    status: record.status,
    valid_until: record.valid_until,
    link_expires_at: record.link_created_at ? (record.link_expires_at ?? verificationLinkExpiresAt(new Date(record.link_created_at))) : null,
    days_left: daysLeft,
    renewal_form_open: false,
  }

  if (record.status === 'valid') {
    if (daysLeft !== null && daysLeft < 0) return { ...base, state: 'expired' }
    const state: VerificationState = daysLeft !== null && daysLeft <= VERIFICATION_RENEWAL_NOTICE_DAYS ? 'expiring' : 'valid'
    return { ...base, state, renewal_form_open: live }
  }

  // Not valid. A live form outranks everything else: it is the way out.
  if (live) return { ...base, state: record.handed_off_at ? 'awaiting_signatory' : 'form_open' }

  const lapsed = record.valid_until !== null
  if (lapsed) {
    // A link made after the lapse is this renewal's; one made before it is history.
    const lapsedAt = new Date(endOfDayIsoStockholm(record.valid_until!)).getTime()
    const linkAfterLapse = record.link_created_at ? new Date(record.link_created_at).getTime() > lapsedAt : false
    return { ...base, state: linkAfterLapse ? 'link_expired' : 'expired' }
  }
  if (record.link_created_at) return { ...base, state: 'link_expired' }
  return { ...base, state: 'not_started' }
}
