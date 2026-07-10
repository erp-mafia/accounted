import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import {
  fetchVatAccountTotals,
  formatPeriodLabel,
  resolvePeriodDates,
  rutorFromTotals,
  VAT_INPUT_ACCOUNTS,
  VAT_OUTPUT_ACCOUNTS,
} from './vat-declaration'
import { buildFiledAmounts } from './vat-manual-filing'
import type { VatPeriodType } from '@/types'

/**
 * Momsredovisning settlement proposal (issue #980): the verifikat that closes
 * a VAT period by clearing every 26xx account the momsrapport reads from into
 * the redovisningskonto.
 *
 * Shape of the proposed entry (standard Swedish momsomföring, booked on the
 * period's last day):
 *   - each output-VAT account (261x/262x/263x incl. reverse charge + import)
 *     is debited by its period balance, each input-VAT account (264x) is
 *     credited, at exact öre so the accounts land on zero for the period;
 *   - the net goes to 2650 (Redovisningskonto för moms, credit = att betala)
 *     or 1650 (Momsfordran, debit = att återfå) at the WHOLE-KRONA amount the
 *     declaration is filed with (buildFiledAmounts: öretal faller bort per
 *     SFL 22 kap 1 §), so 2650/1650 always matches the skattekonto movement;
 *   - the öre gap between the exact clearing lines and the filed net is
 *     balanced on 3740 (Öres- och kronutjämning).
 *
 * This is a PROPOSAL: the user reviews and edits the lines in the journal
 * entry form before committing, and the entry books through the normal
 * engine (balance validation, period locks, voucher numbering) with
 * source_type 'vat_settlement'. That source type is excluded from the
 * declaration projection (see fetchVatAccountTotals), so booking the
 * settlement never changes the report it was created from.
 */

/** Redovisningskonto för moms: net VAT to pay (credit). */
export const VAT_SETTLEMENT_ACCOUNT = '2650'
/** Momsfordran: net VAT refund (debit). */
export const VAT_REFUND_ACCOUNT = '1650'
/** Öres- och kronutjämning: absorbs the filed whole-krona truncation gap. */
export const VAT_ROUNDING_ACCOUNT = '3740'

export interface VatSettlementProposalLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

/** A vat_settlement entry already booked (or drafted) inside the period. */
export interface VatSettlementExistingEntry {
  id: string
  status: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number | null
}

export interface VatSettlementProposal {
  period: {
    type: VatPeriodType
    year: number
    period: number
    start: string
    end: string
  }
  /** Swedish period label, e.g. "Kvartal 1 2026" (Skatteverket-bound wording). */
  period_label: string
  /** Proposed entry date: the period's last day. */
  entry_date: string
  /** Proposed verifikationstext, e.g. "Momsredovisning Kvartal 1 2026". */
  description: string
  lines: VatSettlementProposalLine[]
  /** Ruta 49 as filed (whole kronor, signed: positive = att betala). */
  filed_net: number
  /** Signed öre gap balanced on 3740 (positive = credited, negative = debited). */
  rounding_amount: number
  /** True when the period has no VAT activity to clear. */
  is_empty: boolean
  existing_entries: VatSettlementExistingEntry[]
}

/**
 * Build the settlement verifikat proposal for a VAT period. Reads the same
 * aggregated ledger totals as the momsrapport (fetchVatAccountTotals), so the
 * proposal always ties out with the report on screen and the filed eSKD/PDF
 * amounts.
 */
export async function buildVatSettlementProposal(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  options: { fiscalPeriodId?: string } = {}
): Promise<VatSettlementProposal> {
  // Yearly (helårsmoms) resolves to the räkenskapsår bounds when a fiscal
  // period is supplied: same resolution as the declaration itself.
  const { start, end } = await resolvePeriodDates(
    supabase, companyId, periodType, year, period, options.fiscalPeriodId
  )

  const [totals, existingResult] = await Promise.all([
    fetchVatAccountTotals(supabase, companyId, start, end),
    supabase
      .from('journal_entries')
      .select('id, status, entry_date, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .eq('source_type', 'vat_settlement')
      .in('status', ['draft', 'posted'])
      .gte('entry_date', start)
      .lte('entry_date', end)
      .order('entry_date', { ascending: false })
      .limit(5),
  ])

  // The existing-settlement lookup gates the UI's "already booked" warning
  // and its create button; a swallowed error here would silently re-enable
  // booking a period that already has a settlement, so fail loud instead.
  if (existingResult.error) {
    throw new Error(
      `existing vat_settlement lookup failed: ${existingResult.error.message}`
    )
  }

  const rutor = rutorFromTotals(totals)
  const { net: filedNet } = buildFiledAmounts(rutor)

  // Clear every 26xx account the declaration reads from, at exact öre, so the
  // accounts land on zero for the period. A positive (credit) balance clears
  // with a debit and vice versa: the same formula handles credit-note-heavy
  // periods where an account sits on the "wrong" side.
  const clearingAccounts = [...new Set([...VAT_OUTPUT_ACCOUNTS, ...VAT_INPUT_ACCOUNTS])].sort()
  const lines: VatSettlementProposalLine[] = []
  for (const account of clearingAccounts) {
    const t = totals.get(account)
    if (!t) continue
    const balance = roundOre(t.credit - t.debit)
    if (balance > 0) {
      lines.push({ account_number: account, debit_amount: balance, credit_amount: 0 })
    } else if (balance < 0) {
      lines.push({ account_number: account, debit_amount: 0, credit_amount: -balance })
    }
  }

  if (lines.length > 0) {
    if (filedNet > 0) {
      lines.push({
        account_number: VAT_SETTLEMENT_ACCOUNT,
        debit_amount: 0,
        credit_amount: filedNet,
        line_description: 'Moms att betala',
      })
    } else if (filedNet < 0) {
      lines.push({
        account_number: VAT_REFUND_ACCOUNT,
        debit_amount: -filedNet,
        credit_amount: 0,
        line_description: 'Moms att återfå',
      })
    }
  }

  // Balance the öre/krona gap left by the whole-krona filed net on 3740.
  let roundingAmount = 0
  if (lines.length > 0) {
    const gap = roundOre(
      lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)
    )
    if (gap !== 0) {
      roundingAmount = gap
      lines.push({
        account_number: VAT_ROUNDING_ACCOUNT,
        debit_amount: gap < 0 ? -gap : 0,
        credit_amount: gap > 0 ? gap : 0,
        line_description: 'Öres- och kronutjämning',
      })
    }
  }

  const periodLabel = formatPeriodLabel(periodType, year, period)

  return {
    period: { type: periodType, year, period, start, end },
    period_label: periodLabel,
    entry_date: end,
    description: `Momsredovisning ${periodLabel}`,
    lines,
    filed_net: filedNet,
    rounding_amount: roundingAmount,
    is_empty: lines.length === 0,
    existing_entries: (existingResult.data ?? []) as VatSettlementExistingEntry[],
  }
}
