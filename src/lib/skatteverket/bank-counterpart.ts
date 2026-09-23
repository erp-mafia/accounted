import type { StoredSkattekontoTransaction } from '@/types/skatteverket'

/**
 * Heuristic for spotting a 1930↔1630-transfer that has been observed
 * from both sides (bank PSD2 + Skatteverket API).
 *
 * Used to render a passive dublett-varning on the bank-tx card in
 * /transactions so the user doesn't book the same transfer twice (once
 * via /transactions, once via /skattekonto).
 *
 * Rule, intentionally conservative:
 *   - Equal absolute amount (rounded to öre)
 *   - Opposite signs (a transfer looks like -X on bank, +X on SKV: or
 *     vice versa for a refund). Same-sign pairs are unrelated cash flows
 *     that happen to share an amount.
 *   - Transaktionsdatum within ±DATE_WINDOW_DAYS of bank.date. Real
 *     settlement is usually 1-3 working days but we widen the window to
 *     handle weekends and holidays.
 *
 * The function is non-blocking: false positives just mean an extra
 * warning panel the user can ignore. False negatives mean no warning
 * (user might double-book, but the SKV row will still have its own
 * `match_suggestion` once they book one side, so the dublett-flow has a
 * second chance to fire).
 */

export const BANK_SKV_DATE_WINDOW_DAYS = 14

interface BankCounterpartInput {
  /** Bank transactions that are still uncategorized (inbox candidates). */
  bankRows: ReadonlyArray<{ id: string; date: string; amount: number }>
  /** SKV rows that have not been linked to a verifikat yet. */
  skvRows: ReadonlyArray<
    Pick<StoredSkattekontoTransaction, 'id' | 'transaktionsdatum' | 'belopp_skatteverket'>
  >
  /** Override for testing: defaults to BANK_SKV_DATE_WINDOW_DAYS. */
  dateWindowDays?: number
}

function isoToTime(iso: string): number {
  return new Date(iso + 'T00:00:00Z').getTime()
}

function diffDays(a: string, b: string): number {
  return Math.abs(isoToTime(a) - isoToTime(b)) / 86_400_000
}

/**
 * Map each bank tx that has a plausible SKV counterpart to that SKV row's
 * transaktionsdatum. First plausible match wins per bank tx: we don't
 * return a ranked list since the UI only renders a single hint per card.
 */
export function findBankSkvCounterparts({
  bankRows,
  skvRows,
  dateWindowDays = BANK_SKV_DATE_WINDOW_DAYS,
}: BankCounterpartInput): Map<string, string> {
  const result = new Map<string, string>()
  if (skvRows.length === 0 || bankRows.length === 0) return result

  for (const tx of bankRows) {
    const txAmount = Math.round(Math.abs(tx.amount) * 100) / 100
    if (txAmount === 0) continue
    const txSign = Math.sign(tx.amount)
    for (const r of skvRows) {
      const skvAmount = Math.round(Math.abs(Number(r.belopp_skatteverket)) * 100) / 100
      if (skvAmount !== txAmount) continue
      // Transfer scenario: bank-side and SKV-side have opposite signs.
      if (txSign === Math.sign(Number(r.belopp_skatteverket))) continue
      if (diffDays(r.transaktionsdatum, tx.date) > dateWindowDays) continue
      result.set(tx.id, r.transaktionsdatum)
      break
    }
  }
  return result
}
