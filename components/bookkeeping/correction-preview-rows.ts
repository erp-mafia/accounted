import type { JournalEntryLine } from '@/types'

export interface CorrectionLineInput {
  account_number: string
  debit_amount: string | number
  credit_amount: string | number
}

export interface AccountRow {
  account_number: string
  original: number
  storno: number
  correction: number
  delta: number
  /**
   * True when this account appears on at least one (4-digit) corrected line.
   * Lets the UI tell apart an account the user removed from the rättelse, which
   * the storno then zeroes (delta = −original), from one that was never part of
   * the correction at all. Without this distinction a removed account renders as
   * a bare "-", reading as "unchanged" when it is in fact being drained.
   */
  correctionPresent: boolean
}

function toNumber(v: string | number | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Build per-account diff rows: original net, storno (= −original), proposed
 * correction net, and förändring (= storno + correction = correction − original).
 *
 * Net per row is debit − credit. Accounts appearing only on one side still get
 * a row, so the user sees account swaps clearly (old account drains to zero,
 * new account picks up the value).
 *
 * Corrected lines with account_number.length !== 4 are skipped: those are
 * incomplete user input mid-edit, not real proposals.
 */
export function buildCorrectionRows(
  original: JournalEntryLine[],
  corrected: CorrectionLineInput[]
): AccountRow[] {
  const map = new Map<string, AccountRow>()

  const ensure = (acc: string): AccountRow => {
    let row = map.get(acc)
    if (!row) {
      row = {
        account_number: acc,
        original: 0,
        storno: 0,
        correction: 0,
        delta: 0,
        correctionPresent: false,
      }
      map.set(acc, row)
    }
    return row
  }

  for (const line of original) {
    if (!line.account_number) continue
    const net = toNumber(line.debit_amount) - toNumber(line.credit_amount)
    const row = ensure(line.account_number)
    row.original += net
    row.storno -= net
  }

  for (const line of corrected) {
    if (!line.account_number || line.account_number.length !== 4) continue
    const net = toNumber(line.debit_amount) - toNumber(line.credit_amount)
    const row = ensure(line.account_number)
    row.correction += net
    row.correctionPresent = true
  }

  for (const row of map.values()) {
    row.original = round2(row.original)
    row.storno = round2(row.storno)
    row.correction = round2(row.correction)
    row.delta = round2(row.storno + row.correction)
  }

  return Array.from(map.values()).sort((a, b) =>
    a.account_number.localeCompare(b.account_number)
  )
}

export function formatSignedAmount(n: number): string {
  if (n === 0) return '-'
  const abs = Math.abs(n).toLocaleString('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return n > 0 ? `+${abs}` : `−${abs}`
}
