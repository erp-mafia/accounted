import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchEntryLines,
  fetchLinesByEntryIds,
  type EntryLinesQuery,
} from '@/lib/bookkeeping/entry-lines'
import { resolvePeriodDates } from './vat-declaration'
import { RC_BASIS_ACCOUNTS_BY_RATE } from './vat-filing-gate'
import { fetchDynamicVatAccounts } from './vat-revenue-accounts'
import type { VatPeriodType } from '@/types'

/**
 * Per-voucher detection of FK004: reverse-charge output VAT booked
 * (2614/2624/2634) without a matching basbelopp pair on 44xx/45xx.
 *
 * Used by the momsdeklaration UI to give the user a concrete list of
 * verifikationer to correct, rather than a generic "ruta 30-32 utan
 * ruta 20-24" warning that doesn't tell them what to fix.
 */

const RC_OUTPUT_ACCOUNTS = ['2614', '2624', '2634'] as const
type RcOutputAccount = typeof RC_OUTPUT_ACCOUNTS[number]

// EU goods (4515-4517), non-EU services (4531-4533), EU services (4535-4537),
// domestic goods RC (4415-4417), domestic services RC (4425-4427). Derived
// from the rate-grouped single source in vat-filing-gate.ts so this scan and
// the per-rate downgrade evidence can never disagree on the account set.
const STATIC_RC_BASIS_RATE = new Map<string, number>([
  ...RC_BASIS_ACCOUNTS_BY_RATE.r25.map((account) => [account, 0.25] as const),
  ...RC_BASIS_ACCOUNTS_BY_RATE.r12.map((account) => [account, 0.12] as const),
  ...RC_BASIS_ACCOUNTS_BY_RATE.r6.map((account) => [account, 0.06] as const),
])

const RATE_BY_OUTPUT: Record<RcOutputAccount, number> = {
  '2614': 0.25,
  '2624': 0.12,
  '2634': 0.06,
}

// Default to EU services (matches the booking-template default
// reverse_charge_supplier_type = 'eu_business'). The user can pick a
// different supplier type on the Korrigera form if needed.
const DEFAULT_BASIS_BY_OUTPUT: Record<RcOutputAccount, string> = {
  '2614': '4535',
  '2624': '4536',
  '2634': '4537',
}

export interface RcBasisGap {
  entryId: string
  voucherNumber: number
  voucherSeries: string
  entryDate: string
  description: string
  rcOutputAccount: RcOutputAccount
  rcOutputAmount: number
  expectedBasisAmount: number
  suggestedBasisAccount: string
  rate: number
}

interface RcLineRow {
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  // Supabase typings unpredictably model joined relations as either an object
  // or an array depending on the FK; we accept both and normalize below.
  journal_entries:
    | {
        id: string
        voucher_number: number
        voucher_series: string
        entry_date: string
        description: string
      }
    | {
        id: string
        voucher_number: number
        voucher_series: string
        entry_date: string
        description: string
      }[]
}

interface EntryFields {
  id: string
  voucher_number: number
  voucher_series: string
  entry_date: string
  description: string
}

function pickEntry(row: RcLineRow): EntryFields | null {
  const j = row.journal_entries
  if (Array.isArray(j)) return j.length > 0 ? j[0] : null
  return j ?? null
}

interface SiblingLineRow {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
}

export async function findRcBasisGaps(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  options: { fiscalPeriodId?: string } = {},
): Promise<RcBasisGap[]> {
  // Same period resolution as the declaration itself: helårsmoms covers the
  // räkenskapsår, not the calendar year, so a calendar span would hide gap
  // vouchers from the tail of an extended/broken fiscal year while the
  // declaration totals (and the aggregate check) still include them.
  const { start, end } = await resolvePeriodDates(
    supabase, companyId, periodType, year, period, options.fiscalPeriodId
  )
  const dynamicVatAccounts = await fetchDynamicVatAccounts(supabase, companyId)

  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts).
  const rcLines = (await fetchEntryLines<unknown>({
    supabase,
    entryColumns:
      'id, voucher_number, voucher_series, entry_date, description, status, company_id',
    lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .eq('status', 'posted')
        .gte('entry_date', start)
        .lte('entry_date', end),
    filterLines: (q: EntryLinesQuery) =>
      q.in('account_number', RC_OUTPUT_ACCOUNTS as unknown as string[]),
  })) as RcLineRow[]

  if (rcLines.length === 0) return []

  const entryIds = [...new Set(rcLines.map((l) => l.journal_entry_id))]

  const siblingLines = await fetchLinesByEntryIds<SiblingLineRow>(
    supabase,
    entryIds,
    'id, journal_entry_id, account_number, debit_amount, credit_amount',
  )

  const basisByEntryAndRate = new Map<string, number>()
  for (const line of siblingLines) {
    const rate = dynamicVatAccounts.explicitAccounts.has(line.account_number)
      ? dynamicVatAccounts.rcBasisRateByAccount.get(line.account_number)
      : STATIC_RC_BASIS_RATE.get(line.account_number)
    if (rate) {
      const key = `${line.journal_entry_id}:${rate}`
      const prev = basisByEntryAndRate.get(key) || 0
      basisByEntryAndRate.set(
        key,
        prev + (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0),
      )
    }
  }

  // Aggregate RC output per (entry, account): a voucher may have multiple
  // 2614 lines (rare) and we want to flag the total shortfall.
  const aggregated = new Map<string, { row: RcLineRow; amount: number }>()
  for (const line of rcLines) {
    const key = `${line.journal_entry_id}:${line.account_number}`
    const amount = (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)
    const existing = aggregated.get(key)
    if (existing) {
      existing.amount += amount
    } else {
      aggregated.set(key, { row: line, amount })
    }
  }

  const eps = 0.5
  const gaps: RcBasisGap[] = []
  for (const { row, amount } of aggregated.values()) {
    if (amount <= eps) continue
    const account = row.account_number as RcOutputAccount
    const rate = RATE_BY_OUTPUT[account]
    if (!rate) continue
    const expectedBasis = Math.round((amount / rate) * 100) / 100
    const actualBasis = basisByEntryAndRate.get(`${row.journal_entry_id}:${rate}`) || 0
    if (actualBasis + eps >= expectedBasis) continue

    const entry = pickEntry(row)
    if (!entry) continue
    gaps.push({
      entryId: row.journal_entry_id,
      voucherNumber: entry.voucher_number,
      voucherSeries: entry.voucher_series,
      entryDate: entry.entry_date,
      description: entry.description,
      rcOutputAccount: account,
      rcOutputAmount: amount,
      expectedBasisAmount: expectedBasis,
      suggestedBasisAccount: DEFAULT_BASIS_BY_OUTPUT[account],
      rate,
    })
  }

  gaps.sort((a, b) => {
    if (a.voucherSeries !== b.voucherSeries) {
      return a.voucherSeries.localeCompare(b.voucherSeries)
    }
    return a.voucherNumber - b.voucherNumber
  })

  return gaps
}
