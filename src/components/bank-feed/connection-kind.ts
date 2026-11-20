/**
 * Which service a bank_connections row reads through, and when an Open
 * Payments consent needs renewing. Enable Banking rows carry the bank as
 * their provider ("swedbank-se", from the ASPSP name and country); the Open
 * Payments reading feed writes provider 'open_payments' (lib/bank-feed/feed.ts).
 * The settings surfaces decide per row whether to offer "Byt till ny
 * koppling" (Enable Banking) or "Förnya" / "Koppla bort" (Open Payments).
 * The Enable Banking rows are why the surfaces read bank_connections rather
 * than GET /api/bank/open-payments/connections, which lists Open Payments only.
 */

export type ConnectionKind = 'open_payments' | 'enable_banking'

const OPEN_PAYMENTS_PROVIDER = /^open[-_ ]?payments$/i

export function connectionKind(row: { provider: string | null }): ConnectionKind {
  return row.provider && OPEN_PAYMENTS_PROVIDER.test(row.provider) ? 'open_payments' : 'enable_banking'
}

/** How long before the consent expires the row starts asking for a renewal. */
export const RENEWAL_WINDOW_DAYS = 14

export type ConsentState = { kind: 'active'; until: string } | { kind: 'renew_by'; until: string } | { kind: 'expired'; until: string } | { kind: 'unknown' }

/** Where the consent stands, from its expiry and today. The dates are ISO strings; `now` is a timestamp. */
export function consentState(consentExpires: string | null, now: number): ConsentState {
  if (!consentExpires) return { kind: 'unknown' }
  const until = new Date(consentExpires).getTime()
  if (Number.isNaN(until)) return { kind: 'unknown' }
  if (until <= now) return { kind: 'expired', until: consentExpires }
  const daysLeft = (until - now) / 86_400_000
  return daysLeft <= RENEWAL_WINDOW_DAYS ? { kind: 'renew_by', until: consentExpires } : { kind: 'active', until: consentExpires }
}

/**
 * What one Open Payments connection row says, from its stored status first
 * and its consent date second. The date only says how long a live consent
 * has left: a row the sync marked 'expired' while its date is still ahead
 * (the bank refused it for good, or ended the consent early, crm#1355) has
 * ended all the same, and reading the date alone showed it as active.
 */
export type ConnectionRowState = ConsentState | { kind: 'choose_accounts' } | { kind: 'sync_failed' } | { kind: 'ended' }

export function connectionRowState(status: string, consentExpires: string | null, now: number): ConnectionRowState {
  const consent = consentState(consentExpires, now)
  if (consent.kind === 'expired') return consent
  if (status === 'expired') return { kind: 'ended' }
  if (status === 'pending_selection') return { kind: 'choose_accounts' }
  if (status === 'error') return { kind: 'sync_failed' }
  return consent
}
