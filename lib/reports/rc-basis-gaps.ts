import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { calculatePeriodDates } from './vat-declaration'
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

const RC_BASIS_ACCOUNTS = new Set([
  '4515', '4516', '4517', // EU goods 25/12/6%
  '4531', '4532', '4533', // non-EU services 25/12/6%
  '4535', '4536', '4537', // EU services 25/12/6%
  '4415', '4416', '4417', // domestic goods RC
  '4425', '4426', '4427', // domestic services RC
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
): Promise<RcBasisGap[]> {
  const { start, end } = calculatePeriodDates(periodType, year, period)

  const rcLines = (await fetchAllRows<unknown>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select(`
        journal_entry_id,
        account_number,
        debit_amount,
        credit_amount,
        journal_entries!inner (
          id, voucher_number, voucher_series, entry_date, description, status, company_id
        )
      `)
      .in('account_number', RC_OUTPUT_ACCOUNTS as unknown as string[])
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.status', 'posted')
      .gte('journal_entries.entry_date', start)
      .lte('journal_entries.entry_date', end)
      // Stable total order for correct paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to),
  )) as RcLineRow[]

  if (rcLines.length === 0) return []

  const entryIds = [...new Set(rcLines.map((l) => l.journal_entry_id))]

  const siblingLines = await fetchAllRows<SiblingLineRow>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select('id, journal_entry_id, account_number, debit_amount, credit_amount')
      .in('journal_entry_id', entryIds)
      // Stable total order for correct paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to),
    { dedupeBy: (r) => r.id },
  )

  const basisByEntry = new Map<string, number>()
  for (const line of siblingLines) {
    if (RC_BASIS_ACCOUNTS.has(line.account_number)) {
      const prev = basisByEntry.get(line.journal_entry_id) || 0
      basisByEntry.set(
        line.journal_entry_id,
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
    const actualBasis = basisByEntry.get(row.journal_entry_id) || 0
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
