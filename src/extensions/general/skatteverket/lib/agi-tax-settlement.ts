import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { parseNumericAgiPeriod, SWEDISH_MONTH_NUMBERS } from './skattekonto-match'

const log = createLogger('agi-tax-settlement')

/**
 * Auto-settle AGI tax payments from booked skattekonto rows.
 *
 * When Skatteverket books the AGI debit on the skattekonto, the declared
 * amount has been drawn from the account. If the account is not in deficit
 * at that point, the period's tax obligation is settled: flip
 * agi_declarations.tax_paid_at so the salary UI stops showing the period
 * as unpaid.
 *
 * The draw appears in two formats:
 *  - test environment: one combined row "Arbetsgivardeklaration YYYYMM"
 *    equal to total_tax + total_avgifter;
 *  - production: two rows, "Avdragen skatt <månad> <år>" (= total_tax) and
 *    "Arbetsgivaravgift <månad> <år>" (= total_avgifter).
 *
 * The rule is deliberately strict (deterministic, no inference):
 *  - saldo must be >= 0: a deficit means something is still unpaid, so
 *    nothing gets marked paid;
 *  - amounts must match to the ore, and the production pair requires exactly
 *    one row of each kind: corrections, partial draws and duplicate rows fall
 *    back to the manual mark-paid button.
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

const MONTH_NAME_ALTERNATION = Object.keys(SWEDISH_MONTH_NUMBERS).join('|')

// Anchored to the whole text on purpose: production decision rows like
// "Beslut 260703 arbetsgivaravgift mars 2026" carry the same keyword + period
// but are corrections with arbitrary amounts and must never classify as the
// period's regular draw.
const TAX_DRAW_RE = new RegExp(
  `^avdragen skatt\\s+(${MONTH_NAME_ALTERNATION})\\s+(\\d{4})\\s*$`,
  'i',
)
const AVGIFT_DRAW_RE = new RegExp(
  `^arbetsgivaravgift\\s+(${MONTH_NAME_ALTERNATION})\\s+(\\d{4})\\s*$`,
  'i',
)

type DrawKind = 'combined' | 'tax' | 'avgift'

interface PeriodDraws {
  tax: SettleableSkattekontoRow[]
  avgift: SettleableSkattekontoRow[]
  combined: SettleableSkattekontoRow[]
}

function classifyDraw(
  transaktionstext: string,
): { kind: DrawKind; year: number; month: number } | null {
  const text = transaktionstext.trim()

  for (const [kind, re] of [
    ['tax', TAX_DRAW_RE],
    ['avgift', AVGIFT_DRAW_RE],
  ] as const) {
    const m = re.exec(text)
    if (m) {
      const month = SWEDISH_MONTH_NUMBERS[m[1].toLowerCase()]
      const year = Number(m[2])
      if (month && year >= 2000 && year <= 2100) return { kind, year, month }
      return null
    }
  }

  const period = parseNumericAgiPeriod(text)
  if (period) return { kind: 'combined', ...period }
  return null
}

function drawnOre(row: SettleableSkattekontoRow): number {
  return Math.round(Math.abs(row.belopp_skatteverket) * 100)
}

/**
 * The date the period's obligation was settled, or null when the booked rows
 * don't deterministically prove full settlement: either one combined row
 * matching the whole declared amount, or exactly one tax row + exactly one
 * avgift row matching their respective totals (settled on the later of the
 * two dates).
 */
function resolveSettlementDate(
  draws: PeriodDraws,
  decl: AgiDeclarationRow,
): string | null {
  const declaredTotal = Math.round((decl.total_tax + decl.total_avgifter) * 100)

  const combinedMatch = draws.combined.find(r => drawnOre(r) === declaredTotal)
  if (combinedMatch) return combinedMatch.transaktionsdatum

  if (draws.combined.length === 0 && draws.tax.length === 1 && draws.avgift.length === 1) {
    const declaredTax = Math.round(decl.total_tax * 100)
    const declaredAvgifter = Math.round(decl.total_avgifter * 100)
    if (
      drawnOre(draws.tax[0]) === declaredTax &&
      drawnOre(draws.avgift[0]) === declaredAvgifter
    ) {
      return draws.tax[0].transaktionsdatum > draws.avgift[0].transaktionsdatum
        ? draws.tax[0].transaktionsdatum
        : draws.avgift[0].transaktionsdatum
    }
  }

  return null
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

    // Debit rows (money drawn from the account) that classify as an AGI draw,
    // grouped per period so the production tax/avgift pair settles together.
    const drawsByPeriod = new Map<string, PeriodDraws>()
    const periods = new Map<string, { year: number; month: number }>()

    for (const row of bookedRows) {
      if (row.belopp_skatteverket >= 0) continue
      const draw = classifyDraw(row.transaktionstext)
      if (!draw) continue
      const key = periodKey(draw.year, draw.month)
      let bucket = drawsByPeriod.get(key)
      if (!bucket) {
        bucket = { tax: [], avgift: [], combined: [] }
        drawsByPeriod.set(key, bucket)
        periods.set(key, { year: draw.year, month: draw.month })
      }
      bucket[draw.kind].push(row)
    }

    if (drawsByPeriod.size === 0) return 0

    const years = Array.from(new Set(Array.from(periods.values()).map(p => p.year)))
    const months = Array.from(new Set(Array.from(periods.values()).map(p => p.month)))

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

    for (const [key, draws] of drawsByPeriod) {
      const decl = declarationsByPeriod.get(key)
      if (!decl) continue

      const paidDate = resolveSettlementDate(draws, decl)
      if (!paidDate) {
        // Refusing to settle must leave a trace: a rounding divergence between
        // the stored declaration totals and SKV's actual draw would otherwise
        // block auto-settlement for the period with nothing to diagnose.
        // Amounts only, in ore; transaction texts can carry personal data.
        log.info('agi settlement candidates did not match declared amounts', {
          companyId,
          period: key,
          declaredTaxOre: Math.round(decl.total_tax * 100),
          declaredAvgifterOre: Math.round(decl.total_avgifter * 100),
          taxDrawsOre: draws.tax.map(r => drawnOre(r)),
          avgiftDrawsOre: draws.avgift.map(r => drawnOre(r)),
          combinedDrawsOre: draws.combined.map(r => drawnOre(r)),
          taxDrawCount: draws.tax.length,
          avgiftDrawCount: draws.avgift.length,
          combinedDrawCount: draws.combined.length,
        })
        continue
      }

      const { error: updateError } = await supabase
        .from('agi_declarations')
        .update({ tax_paid_at: `${paidDate}T00:00:00Z` })
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
