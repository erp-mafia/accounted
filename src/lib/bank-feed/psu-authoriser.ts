/**
 * The signer's logon id at a bank that names its user by one besides BankID:
 * Nordea Corporate Netbank ("PSU-Authoriser-ID behöver skickas med som header
 * på Authorisations-resursen. PSU-Authoriser-ID motsvarar användarens
 * logon-ID i Nordea Corporate Netbank", Open Payments support 2026-10-14).
 *
 * The bank list has one Nordea entry (NDEASESS) for Nordea Business and
 * Corporate Netbank alike, and the two cannot be told apart before the bank
 * answers, so the field is offered, optional, for every Nordea signing: the
 * bank consent (Koppla banken, the signatory link) and the payment signing
 * (Betalningar, the payment signing link). Typed by the person each time,
 * sent to Connect in the party (psuAuthoriserId, contract 2026-10-17), which
 * puts it on the authorisation calls only; never stored or logged. A second
 * signatory types their own.
 *
 * Shared by the server (the party builders refuse a malformed value and drop
 * it for any other bank) and the browser (which bank shows the field, and the
 * same format check before a start).
 */

/** Nordea's one BIC in the bank list (Business and Corporate Netbank). */
export const NORDEA_BIC = 'NDEASESS'

/** The format the contract takes: 1 to 64 letters, digits, `-` or `_`, trimmed. */
export const PSU_AUTHORISER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** The code Connect relays when the bank refused an authorisation for a missing or wrong logon id. */
export const PSU_AUTHORISER_ID_MISSING = 'PSU_AUTHORISER_ID_MISSING'

/**
 * Whether a bank takes the logon id: Nordea, by its BIC, or by name where only
 * the name is at hand (a payment's paying account knows its bank by name).
 */
export function takesPsuAuthoriserId(bank: { bic?: string | null; name?: string | null }): boolean {
  if (bank.bic) return bank.bic.trim().toUpperCase() === NORDEA_BIC
  return /\bnordea\b/i.test(bank.name ?? '')
}

export type PsuAuthoriserIdInput = { ok: true; value: string | null } | { ok: false }

/** What was typed, trimmed: null when nothing was, refused when it is not the contract's format. */
export function normalizePsuAuthoriserId(raw: string | null | undefined): PsuAuthoriserIdInput {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: true, value: null }
  return PSU_AUTHORISER_ID_PATTERN.test(trimmed) ? { ok: true, value: trimmed } : { ok: false }
}

/**
 * The value a party carries for this bank: the typed id at Nordea, null at
 * any other bank (a value left over from an earlier pick never reaches it).
 * Refused only when it would be sent and is malformed.
 */
export function psuAuthoriserIdFor(bic: string | null | undefined, raw: string | null | undefined): PsuAuthoriserIdInput {
  if (!bic || !takesPsuAuthoriserId({ bic })) return { ok: true, value: null }
  return normalizePsuAuthoriserId(raw)
}
