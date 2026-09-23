import { MarkInvoiceSentSchema } from '@/lib/api/schemas'
import { roundOre } from '@/lib/money'

/**
 * Shared parse + validation for user-edited issuance lines accepted by
 * POST /api/invoices/[id]/mark-sent and POST /api/invoices/[id]/send.
 * One implementation so the two routes cannot drift (compliance V2.2).
 */

export interface CustomIssuanceLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
  dimensions?: Record<string, string>
}

export type CustomIssuanceLinesResult =
  | { ok: true; lines: CustomIssuanceLine[] | undefined }
  | { ok: false; error: 'invalid_body'; details: unknown }
  | {
      ok: false
      error: 'unbalanced'
      details: { totalDebit: number; totalCredit: number }
    }
  | {
      ok: false
      error: 'invalid_lines'
      details: { reason: 'both_sides'; index: number } | { reason: 'accrual_interim_account'; account: string }
    }

/**
 * Parse an already-JSON-decoded request body and validate any custom lines.
 *
 * Rules beyond the Zod schema:
 * - A row may not carry both a debit and a credit amount (the UI enforces
 *   exclusion; API callers get a clean 400 instead of a nonstandard entry).
 * - 29xx interim accounts (förutbetalda intäkter) are rejected: custom lines
 *   skip accrual schedule creation, so a 29xx balance booked here would never
 *   be dissolved and would sit invisible to the periodisering monitoring.
 * - Per-line öre-rounded totals must balance and be positive: the engine
 *   rounds each line before insert, so raw sums that balance can still book
 *   unbalanced otherwise.
 *
 * Account existence is NOT checked here: the engine resolves every account
 * against the company's chart of accounts and throws AccountsNotInChartError.
 */
export function parseCustomIssuanceLines(rawBody: unknown): CustomIssuanceLinesResult {
  if (rawBody == null) return { ok: true, lines: undefined }

  const parsed = MarkInvoiceSentSchema.safeParse(rawBody)
  if (!parsed.success) {
    return { ok: false, error: 'invalid_body', details: parsed.error.flatten() }
  }

  const lines = parsed.data.lines
  if (!lines) return { ok: true, lines: undefined }

  for (const [index, line] of lines.entries()) {
    if (line.debit_amount > 0 && line.credit_amount > 0) {
      return {
        ok: false,
        error: 'invalid_lines',
        details: { reason: 'both_sides', index },
      }
    }
    if (/^29\d{2}$/.test(line.account_number)) {
      return {
        ok: false,
        error: 'invalid_lines',
        details: { reason: 'accrual_interim_account', account: line.account_number },
      }
    }
  }

  const totalDebit = lines.reduce((s, l) => s + roundOre(l.debit_amount), 0)
  const totalCredit = lines.reduce((s, l) => s + roundOre(l.credit_amount), 0)
  if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
    return { ok: false, error: 'unbalanced', details: { totalDebit, totalCredit } }
  }

  return { ok: true, lines }
}
