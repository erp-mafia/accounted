/**
 * Deep-link contract for "Skapa verifikat manuellt" on a skattekonto row:
 * the SkattekontoBookDialog builds a /bookkeeping URL carrying the row's id
 * and display data, and the bookkeeping page parses it back to prefill the
 * Nytt verifikat dialog and auto-link the created entry via the extension's
 * match endpoint. Kept in core lib (not the extension) because the
 * bookkeeping page cannot import from @/extensions/.
 *
 * The URL params are convenience prefill only: linking is validated
 * server-side by the match route (ownership, ALREADY_BOOKED,
 * ENTRY_ALREADY_LINKED), so a tampered URL can at worst prefill a form the
 * user could have typed anyway.
 */

import { isIsoDateShaped } from '@/lib/invariants'
import { roundOre } from '@/lib/money'

/** Mirrors SKATTEKONTO_ACCOUNT in the skatteverket extension's booking lib. */
export const SKATTEKONTO_ACCOUNT = '1630'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SkvManualPrefill {
  transactionId: string
  /** transaktionsdatum, YYYY-MM-DD */
  date: string
  /** transaktionstext */
  text: string
  /** belopp_skatteverket: positive = money into skattekontot */
  amount: number
}

/** Structurally compatible with the journal form's FormLine. */
export interface SkvPrefillLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description: string
}

export function buildSkvManualCreateUrl(row: {
  id: string
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: string | number
}): string {
  const params = new URLSearchParams({
    skv_tx: row.id,
    skv_date: row.transaktionsdatum,
    skv_text: row.transaktionstext,
    skv_amount: String(row.belopp_skatteverket),
  })
  return `/bookkeeping?${params.toString()}`
}

// Structural param type so Next's ReadonlyURLSearchParams fits without casts.
export function parseSkvManualParams(params: {
  get(name: string): string | null
}): SkvManualPrefill | null {
  const id = params.get('skv_tx')
  if (!id || !UUID_RE.test(id)) return null
  const date = params.get('skv_date') ?? ''
  if (!isIsoDateShaped(date)) return null
  const amount = Number(params.get('skv_amount'))
  if (!Number.isFinite(amount) || amount === 0) return null
  const text = (params.get('skv_text') ?? '').trim()
  return { transactionId: id, date, text, amount }
}

/**
 * Prefill lines following the extension's booking sign convention:
 * positive belopp = money into skattekontot = debit 1630, counter credit;
 * negative = credit 1630, counter debit. The counter line carries the amount
 * but no account: picking the motkonto is exactly the manual decision this
 * flow exists for.
 */
export function buildSkvPrefillLines(prefill: SkvManualPrefill): SkvPrefillLine[] {
  const rounded = roundOre(Math.abs(prefill.amount))
  // toFixed here only pads an already-rounded value for the form's text
  // inputs; the rounding itself is done above.
  const value = rounded.toFixed(2)
  const skattekontoLine: SkvPrefillLine = {
    account_number: SKATTEKONTO_ACCOUNT,
    debit_amount: prefill.amount > 0 ? value : '',
    credit_amount: prefill.amount > 0 ? '' : value,
    line_description: prefill.text,
  }
  const counterLine: SkvPrefillLine = {
    account_number: '',
    debit_amount: prefill.amount > 0 ? '' : value,
    credit_amount: prefill.amount > 0 ? value : '',
    line_description: '',
  }
  return [skattekontoLine, counterLine]
}
