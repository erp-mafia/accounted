import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { parseAgiPeriod } from './skattekonto-match'

const log = createLogger('agi-tax-settlement')

/**
 * Auto-settle AGI tax payments from booked skattekonto rows.
 *
 * When Skatteverket books the "Arbetsgivardeklaration YYYYMM" debit on the
 * skattekonto, the declared amount has been drawn from the account. If the
 * account is not in deficit at that point, the period's tax obligation is
 * settled: flip agi_declarations.tax_paid_at so the salary UI stops showing
 * the period as unpaid.
 *
 * The rule is deliberately strict (deterministic, no inference):
 *  - saldo must be >= 0: a deficit means something is still unpaid, so
 *    nothing gets marked paid;
 *  - the row's amount must equal total_tax + total_avgifter to the ore:
 *    corrections and partial draws fall back to the manual mark-paid button.
 */

export interface SettleableSkattekontoRow {
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number
}

interface AgiDeclarationRow {
  id: string
  period_year: number
  period_month: number
  total_tax: number
  total_avgifter: number
  tax_paid_at: string | null
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * Flip tax_paid_at for AGI declarations whose skattekonto debit row is booked.
 * Returns the number of declarations settled. Never throws: settlement is a
 * best-effort side effect of the sync and must not fail it.
 */
export async function settleAgiTaxPayments(
  supabase: SupabaseClient,
  companyId: string,
  bookedRows: SettleableSkattekontoRow[],
  saldoSkatteverket: number,
): Promise<number> {
  try {
    if (saldoSkatteverket < 0) return 0

    // Debit rows (money drawn from the account) carrying an AGI period token.
    const candidates = bookedRows
      .map(row => {
        if (row.belopp_skatteverket >= 0) return null
        const period = parseAgiPeriod(row.transaktionstext)
        if (!period) return null
        return { row, period }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)

    if (candidates.length === 0) return 0

    const years = Array.from(new Set(candidates.map(c => c.period.year)))
    const months = Array.from(new Set(candidates.map(c => c.period.month)))

    const { data, error } = await supabase
      .from('agi_declarations')
      .select('id, period_year, period_month, total_tax, total_avgifter, tax_paid_at')
      .eq('company_id', companyId)
      .in('period_year', years)
      .in('period_month', months)
      .is('tax_paid_at', null)

    if (error) {
      log.warn('agi settlement lookup failed', {
        companyId,
        message: error.message,
      })
      return 0
    }

    const declarationsByPeriod = new Map<string, AgiDeclarationRow>()
    for (const decl of (data ?? []) as AgiDeclarationRow[]) {
      declarationsByPeriod.set(periodKey(decl.period_year, decl.period_month), decl)
    }

    let settled = 0
    const settledIds = new Set<string>()

    for (const { row, period } of candidates) {
      const decl = declarationsByPeriod.get(periodKey(period.year, period.month))
      if (!decl || settledIds.has(decl.id)) continue

      const drawn = Math.round(Math.abs(row.belopp_skatteverket) * 100)
      const declared = Math.round((decl.total_tax + decl.total_avgifter) * 100)
      if (drawn !== declared) continue

      const { error: updateError } = await supabase
        .from('agi_declarations')
        .update({ tax_paid_at: `${row.transaktionsdatum}T00:00:00Z` })
        .eq('id', decl.id)
        .eq('company_id', companyId)
        .is('tax_paid_at', null) // guard against concurrent settles

      if (updateError) {
        log.warn('agi settlement update failed', {
          companyId,
          declarationId: decl.id,
          message: updateError.message,
        })
        continue
      }

      settledIds.add(decl.id)
      settled++
    }

    return settled
  } catch (err) {
    log.warn('agi settlement failed', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
