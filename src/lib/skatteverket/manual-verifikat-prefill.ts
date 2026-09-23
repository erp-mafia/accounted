/**
 * Deep-link contract for "Skapa verifikat manuellt" on a skattekonto row:
 * the SkattekontoBookDialog stages the row payload and navigates to
 * /bookkeeping, whose page consumes the payload to prefill the Nytt
 * verifikat dialog and auto-link the created entry via the extension's
 * match endpoint. Kept in core lib (not the extension) because the
 * bookkeeping page cannot import from @/extensions/.
 *
 * The URL carries ONLY the opaque transaction id; date, text and amount
 * ride in sessionStorage (compliance swarm PR #1621: query params leak
 * financial data into browser history, access logs and Referer headers).
 * The payload is prefill convenience only and is consumed single-use:
 * linking is validated server-side by the match route (ownership,
 * ALREADY_BOOKED, ENTRY_ALREADY_LINKED), so a missing or tampered payload
 * can at worst degrade to the plain /bookkeeping list.
 *
 * Accepted residual risk (ISO A.8.12, decided 2026-08-14): the staged
 * payload sits unencrypted in sessionStorage for the sub-second navigation
 * window, readable by XSS. An attacker with script execution already reads
 * the full ledger through the session's authenticated APIs, so a
 * server-issued staging token would add a roundtrip without adding
 * protection.
 */

import { isIsoDateShaped } from '@/lib/invariants'
import { UUID_RE } from '@/lib/invariants/uuid'
import { roundOre } from '@/lib/money'

/**
 * The BAS account for skattekontot. The skatteverket extension's booking lib
 * imports this constant so prefill and server-side booking cannot drift.
 */
export const SKATTEKONTO_ACCOUNT = '1630'

const STORAGE_KEY = 'accounted.skv-manual-prefill'

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

/** Minimal Storage surface, injectable so node-env tests can fake it. */
export interface PrefillStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): PrefillStorage | null {
  // sessionStorage can be absent (SSR) or throw (some privacy modes).
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Stage a skattekonto row for manual verifikat creation and return the
 * /bookkeeping URL to navigate to. The row payload goes into sessionStorage;
 * the URL exposes only the opaque row id.
 */
export function stageSkvManualPrefill(
  row: {
    id: string
    transaktionsdatum: string
    transaktionstext: string
    belopp_skatteverket: string | number
  },
  storage: PrefillStorage | null = defaultStorage(),
): string {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        transactionId: row.id,
        date: row.transaktionsdatum,
        text: row.transaktionstext,
        amount: Number(row.belopp_skatteverket),
      }),
    )
  } catch {
    // Quota/privacy-mode failure: the deep link still arms the auto-link
    // fallback path; only the prefill convenience is lost.
  }
  const params = new URLSearchParams({ skv_tx: row.id })
  return `/bookkeeping?${params.toString()}`
}

/**
 * Consume (single-use) the staged payload for the given skv_tx URL param.
 * Returns null when the id is malformed or the stored payload is missing,
 * mismatched or invalid; the caller then degrades to the plain list.
 */
export function takeSkvManualPrefill(
  rawId: string | null,
  storage: PrefillStorage | null = defaultStorage(),
): SkvManualPrefill | null {
  if (!rawId || !UUID_RE.test(rawId) || !storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(STORAGE_KEY)
    storage.removeItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const p = parsed as {
    transactionId?: unknown
    date?: unknown
    text?: unknown
    amount?: unknown
  }
  if (p.transactionId !== rawId) return null
  if (typeof p.date !== 'string' || !isIsoDateShaped(p.date)) return null
  const amount = typeof p.amount === 'number' ? p.amount : Number.NaN
  if (!Number.isFinite(amount) || amount === 0) return null
  const text = typeof p.text === 'string' ? p.text.trim() : ''
  return { transactionId: rawId, date: p.date, text, amount }
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
