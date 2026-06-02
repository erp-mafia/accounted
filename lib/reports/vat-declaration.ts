import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type {
  VatDeclaration,
  VatDeclarationRutor,
  VatPeriodType,
  AccountingMethod,
} from '@/types'

/**
 * Calculate VAT declaration (Momsdeklaration) for a given period.
 *
 * Reads directly from the general ledger — sums posted journal entry lines
 * on 26xx (VAT) and 3xxx (revenue) accounts for the period. This makes the
 * momsdeklaration a pure projection from the double-entry bookkeeping ledger.
 *
 * The accounting method (accrual vs cash) is already reflected in when
 * journal entries were created by the entry generators, so no separate
 * filtering logic is needed here.
 */

/**
 * Account-to-ruta mapping for the Swedish momsdeklaration (SKV 4700).
 *
 * Pure ledger projection: every Ruta on the SKV 4700 form maps to one or more
 * BAS account balances aggregated over the period. The mapping below follows
 * the BAS 2026 chart and Skatteverket's published BAS-to-Ruta spec
 * (`.claude/skills/swedish-vat/references/vat-compliance-reference.md` §7).
 *
 * Output VAT (261x/262x/263x) → ruta 10/11/12 per rate (credit balance)
 *   Includes parent/summary accounts (2610/2620/2630) for users who post
 *   directly to the group account, and vilande accounts (2618/2628/2638)
 *   used by cash-method bookkeepers for invoices not yet paid.
 * Reverse charge output (2614/2624/2634) → ruta 30/31/32 (credit)
 * Import VAT (2615/2625/2635) → ruta 60/61/62 (credit)
 * Input VAT (2640-2649) → ruta 48 (debit), incl. parent 2640
 * Domestic taxable sales (3001-3003) → ruta 05 (credit)
 * Uttag (3401-3403) → ruta 06 (credit)
 * EU goods (3108) → ruta 35; EU services (3308) → ruta 39 (credit)
 * Export (3105/3305) → ruta 36/40; Exempt (3004/3100/3404/3994/3980) → ruta 42 (credit)
 * Reverse-charge purchase bases — read from the cost account the journal
 * entry posted to (debit balance), not from supplier classification:
 *   4515/4516/4517 (EU goods 25/12/6%) → ruta 20
 *   4535/4536/4537 (EU services 25/12/6%) → ruta 21
 *   4531/4532/4533 (non-EU services 25/12/6%) → ruta 22
 *   4415/4416/4417 (domestic goods reverse charge) → ruta 23
 *   4425/4426/4427 (domestic services reverse charge) → ruta 24
 *   4545/4546/4547 (import) → ruta 50
 */
export const ACCOUNT_RUTA: Record<string, { box: keyof VatDeclarationRutor; side: 'credit' | 'debit' }> = {
  // Output VAT 25% → ruta 10
  '2610': { box: 'ruta10', side: 'credit' },  // Utgående moms 25% (summary/parent)
  '2611': { box: 'ruta10', side: 'credit' },  // Försäljning inom Sverige
  '2612': { box: 'ruta10', side: 'credit' },  // Egna uttag
  '2613': { box: 'ruta10', side: 'credit' },  // Uthyrning (frivillig skattskyldighet)
  '2616': { box: 'ruta10', side: 'credit' },  // Vinstmarginalbeskattning
  '2618': { box: 'ruta10', side: 'credit' },  // Vilande utgående moms 25%
  // Output VAT 12% → ruta 11
  '2620': { box: 'ruta11', side: 'credit' },  // Utgående moms 12% (summary/parent)
  '2621': { box: 'ruta11', side: 'credit' },
  '2622': { box: 'ruta11', side: 'credit' },  // Egna uttag
  '2623': { box: 'ruta11', side: 'credit' },  // Uthyrning
  '2626': { box: 'ruta11', side: 'credit' },  // VMB
  '2628': { box: 'ruta11', side: 'credit' },  // Vilande utgående moms 12%
  // Output VAT 6% → ruta 12
  '2630': { box: 'ruta12', side: 'credit' },  // Utgående moms 6% (summary/parent)
  '2631': { box: 'ruta12', side: 'credit' },
  '2632': { box: 'ruta12', side: 'credit' },  // Egna uttag
  '2633': { box: 'ruta12', side: 'credit' },  // Uthyrning
  '2636': { box: 'ruta12', side: 'credit' },  // VMB
  '2638': { box: 'ruta12', side: 'credit' },  // Vilande utgående moms 6%
  // Reverse charge output VAT → ruta 30/31/32
  '2614': { box: 'ruta30', side: 'credit' },
  '2624': { box: 'ruta31', side: 'credit' },
  '2634': { box: 'ruta32', side: 'credit' },
  // Input VAT → ruta 48
  '2640': { box: 'ruta48', side: 'debit' },   // Ingående moms (summary/parent)
  '2641': { box: 'ruta48', side: 'debit' },   // Debiterad ingående moms
  '2642': { box: 'ruta48', side: 'debit' },   // Frivillig skattskyldighet
  '2645': { box: 'ruta48', side: 'debit' },   // Förvärv utlandet (EU/non-EU RC)
  '2646': { box: 'ruta48', side: 'debit' },   // Uthyrning
  '2647': { box: 'ruta48', side: 'debit' },   // Omvänd skattskyldighet i Sverige
  '2649': { box: 'ruta48', side: 'debit' },   // Blandad verksamhet
  // Import VAT (since 2015, via momsdeklaration) → ruta 60/61/62
  '2615': { box: 'ruta60', side: 'credit' },  // Import 25%
  '2625': { box: 'ruta61', side: 'credit' },  // Import 12%
  '2635': { box: 'ruta62', side: 'credit' },  // Import 6%
  // Revenue: domestic taxable sales → ruta 05
  '3001': { box: 'ruta05', side: 'credit' },
  '3002': { box: 'ruta05', side: 'credit' },
  '3003': { box: 'ruta05', side: 'credit' },
  // Revenue: momspliktiga uttag → ruta 06
  '3401': { box: 'ruta06', side: 'credit' },
  '3402': { box: 'ruta06', side: 'credit' },
  '3403': { box: 'ruta06', side: 'credit' },
  // Revenue: EU goods/services → ruta 35/39
  '3108': { box: 'ruta35', side: 'credit' },  // Varuförsäljning till EU
  '3308': { box: 'ruta39', side: 'credit' },  // Tjänsteförsäljning till EU
  // Revenue: export/other → ruta 36/40/42
  '3105': { box: 'ruta36', side: 'credit' },  // Varuförsäljning export
  '3305': { box: 'ruta40', side: 'credit' },  // Tjänsteförsäljning export
  '3004': { box: 'ruta42', side: 'credit' },  // Momsfri försäljning (AB)
  '3100': { box: 'ruta42', side: 'credit' },  // Momsfria intäkter (EF)
  '3404': { box: 'ruta42', side: 'credit' },  // Momsfria uttag
  '3980': { box: 'ruta42', side: 'credit' },  // Erhållna offentliga stöd m.m.
  '3994': { box: 'ruta42', side: 'credit' },  // Övriga rörelseintäkter momsfria
  // Reverse-charge purchase bases (debit on cost accounts) → ruta 20-24, 50
  '4515': { box: 'ruta20', side: 'debit' },   // Inköp varor EU 25%
  '4516': { box: 'ruta20', side: 'debit' },   // Inköp varor EU 12%
  '4517': { box: 'ruta20', side: 'debit' },   // Inköp varor EU 6%
  '4535': { box: 'ruta21', side: 'debit' },   // Inköp tjänster EU 25%
  '4536': { box: 'ruta21', side: 'debit' },   // Inköp tjänster EU 12%
  '4537': { box: 'ruta21', side: 'debit' },   // Inköp tjänster EU 6%
  '4531': { box: 'ruta22', side: 'debit' },   // Inköp tjänster utanför EU 25%
  '4532': { box: 'ruta22', side: 'debit' },   // Inköp tjänster utanför EU 12%
  '4533': { box: 'ruta22', side: 'debit' },   // Inköp tjänster utanför EU 6%
  '4415': { box: 'ruta23', side: 'debit' },   // Inköp varor SE reverse charge 25%
  '4416': { box: 'ruta23', side: 'debit' },   // Inköp varor SE reverse charge 12%
  '4417': { box: 'ruta23', side: 'debit' },   // Inköp varor SE reverse charge 6%
  '4425': { box: 'ruta24', side: 'debit' },   // Inköp tjänster SE reverse charge 25%
  '4426': { box: 'ruta24', side: 'debit' },   // Inköp tjänster SE reverse charge 12%
  '4427': { box: 'ruta24', side: 'debit' },   // Inköp tjänster SE reverse charge 6%
  '4545': { box: 'ruta50', side: 'debit' },   // Beskattningsunderlag import 25%
  '4546': { box: 'ruta50', side: 'debit' },   // Beskattningsunderlag import 12%
  '4547': { box: 'ruta50', side: 'debit' },   // Beskattningsunderlag import 6%
}

const VAT_ACCOUNTS = Object.keys(ACCOUNT_RUTA)

/**
 * Calculate period start and end dates
 */
export function calculatePeriodDates(
  periodType: VatPeriodType,
  year: number,
  period: number
): { start: string; end: string } {
  let startMonth: number
  let endMonth: number

  switch (periodType) {
    case 'monthly':
      // period is 1-12
      startMonth = period
      endMonth = period
      break
    case 'quarterly':
      // period is 1-4
      startMonth = (period - 1) * 3 + 1
      endMonth = period * 3
      break
    case 'yearly':
      // period is 1
      startMonth = 1
      endMonth = 12
      break
    default:
      startMonth = 1
      endMonth = 12
  }

  const startDate = new Date(year, startMonth - 1, 1)
  const endDate = new Date(year, endMonth, 0) // Last day of end month

  return {
    start: formatDate(startDate),
    end: formatDate(endDate),
  }
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Round to 2 decimal places
 */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Resolve the start/end dates for a VAT period.
 *
 * Monthly and quarterly VAT periods are always calendar months/quarters
 * (kalendermånad / kalenderkvartal per SFL 26 kap), so they use the plain
 * calendar calculation.
 *
 * Annual VAT (helårsmoms), however, is reported per *räkenskapsår* — the
 * beskattningsår — not per calendar year (SFL 26 kap 10–11 §§). A räkenskapsår
 * can be extended or shortened (up to 18 months for a first/changed year per
 * BFL 3 kap 3 §), so a calendar Jan–Dec span would silently drop part of an
 * extended year (e.g. a first year 2025-07-03 → 2026-12-31). When the caller
 * supplies the fiscal period we therefore use its actual bounds. If the period
 * can't be resolved we fall back to the calendar span so behaviour degrades
 * gracefully instead of erroring.
 */
async function resolvePeriodDates(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  fiscalPeriodId?: string
): Promise<{ start: string; end: string }> {
  if (periodType === 'yearly' && fiscalPeriodId) {
    const { data: fp } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (fp?.period_start && fp?.period_end) {
      return { start: fp.period_start, end: fp.period_end }
    }
  }
  return calculatePeriodDates(periodType, year, period)
}

/**
 * Calculate VAT declaration from the general ledger.
 *
 * Sums posted journal entry lines on the BAS accounts in ACCOUNT_RUTA per the
 * SKV 4700 form mapping. Pure ledger projection — no supplier classification
 * or other side-channel signals.
 *
 *   - ruta 49 = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48
 *
 * The accounting method parameter is accepted for backward compatibility
 * but not used — the method is already baked into journal entry timing.
 */
export async function calculateVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  _accountingMethod: AccountingMethod = 'accrual',
  options: { fiscalPeriodId?: string } = {}
): Promise<VatDeclaration> {
  // For yearly VAT this resolves to the räkenskapsår bounds (when a fiscal
  // period is supplied), not the calendar year — see resolvePeriodDates.
  const { start, end } = await resolvePeriodDates(
    supabase, companyId, periodType, year, period, options.fiscalPeriodId
  )

  // Fetch all posted journal entry lines on VAT-relevant accounts for the period
  const lines = await fetchAllRows<{
    account_number: string
    debit_amount: number
    credit_amount: number
  }>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select(`
        account_number,
        debit_amount,
        credit_amount,
        journal_entries!inner (company_id, entry_date, status)
      `)
      .in('account_number', VAT_ACCOUNTS)
      .eq('journal_entries.company_id', companyId)
      .in('journal_entries.status', ['posted', 'reversed'])
      .gte('journal_entries.entry_date', start)
      .lte('journal_entries.entry_date', end)
      .range(from, to)
  )

  // Aggregate debit/credit totals per account
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const line of lines) {
    const t = totals.get(line.account_number) || { debit: 0, credit: 0 }
    t.debit += Number(line.debit_amount) || 0
    t.credit += Number(line.credit_amount) || 0
    totals.set(line.account_number, t)
  }

  // Map account balances to momsdeklaration boxes
  const rutor: VatDeclarationRutor = {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
    ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0, ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
  }

  for (const [account, mapping] of Object.entries(ACCOUNT_RUTA)) {
    const t = totals.get(account)
    if (!t) continue
    const balance = mapping.side === 'credit'
      ? t.credit - t.debit
      : t.debit - t.credit
    rutor[mapping.box] = round(rutor[mapping.box] + balance)
  }

  // FK009: summaMoms = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48
  rutor.ruta49 = round(
    rutor.ruta10 + rutor.ruta11 + rutor.ruta12 +
    rutor.ruta30 + rutor.ruta31 + rutor.ruta32 +
    rutor.ruta60 + rutor.ruta61 + rutor.ruta62 -
    rutor.ruta48
  )

  // Compute per-rate base amounts from individual revenue accounts
  const revenueByRate = {
    base25: 0,  // 3001
    base12: 0,  // 3002
    base6: 0,   // 3003
  }
  for (const [account, rate] of [['3001', 'base25'], ['3002', 'base12'], ['3003', 'base6']] as const) {
    const t = totals.get(account)
    if (t) revenueByRate[rate] = round(t.credit - t.debit)
  }

  // Count journal entries by source type for metadata
  const { data: entryCounts } = await supabase
    .from('journal_entries')
    .select('source_type')
    .eq('company_id', companyId)
    .in('status', ['posted', 'reversed'])
    .gte('entry_date', start)
    .lte('entry_date', end)

  const invoiceSources = new Set([
    'invoice_created', 'invoice_paid', 'invoice_cash_payment', 'credit_note',
  ])
  let invoiceCount = 0
  let transactionCount = 0
  for (const e of entryCounts || []) {
    if (invoiceSources.has(e.source_type)) invoiceCount++
    else if (e.source_type === 'bank_transaction') transactionCount++
  }

  return {
    period: { type: periodType, year, period, start, end },
    rutor,
    invoiceCount,
    transactionCount,
    breakdown: {
      invoices: {
        ruta05: rutor.ruta05,
        ruta06: rutor.ruta06,
        ruta07: rutor.ruta07,
        ruta10: rutor.ruta10,
        ruta11: rutor.ruta11,
        ruta12: rutor.ruta12,
        ruta39: rutor.ruta39,
        ruta40: rutor.ruta40,
        base25: revenueByRate.base25,
        base12: revenueByRate.base12,
        base6: revenueByRate.base6,
      },
      transactions: { ruta48: rutor.ruta48 },
      receipts: { ruta48: 0 },
      reverseCharge: {
        ruta20: rutor.ruta20,
        ruta21: rutor.ruta21,
        ruta22: rutor.ruta22,
        ruta23: rutor.ruta23,
        ruta24: rutor.ruta24,
        ruta30: rutor.ruta30,
        ruta31: rutor.ruta31,
        ruta32: rutor.ruta32,
      },
    },
  }
}

/**
 * Get a summary of the VAT declaration for display
 */
export function getVatDeclarationSummary(declaration: VatDeclaration): {
  totalOutputVat: number
  totalInputVat: number
  vatToPay: number
  isRefund: boolean
} {
  const totalOutputVat = round(
    declaration.rutor.ruta10 +
    declaration.rutor.ruta11 +
    declaration.rutor.ruta12 +
    declaration.rutor.ruta30 +
    declaration.rutor.ruta31 +
    declaration.rutor.ruta32 +
    declaration.rutor.ruta60 +
    declaration.rutor.ruta61 +
    declaration.rutor.ruta62
  )

  const totalInputVat = declaration.rutor.ruta48
  const vatToPay = declaration.rutor.ruta49

  return {
    totalOutputVat,
    totalInputVat,
    vatToPay,
    isRefund: vatToPay < 0,
  }
}

/**
 * Format period label for display
 */
export function formatPeriodLabel(
  periodType: VatPeriodType,
  year: number,
  period: number
): string {
  switch (periodType) {
    case 'monthly':
      const monthNames = [
        'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
        'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'
      ]
      return `${monthNames[period - 1]} ${year}`
    case 'quarterly':
      return `Kvartal ${period} ${year}`
    case 'yearly':
      return `Helår ${year}`
    default:
      return `${year}`
  }
}
