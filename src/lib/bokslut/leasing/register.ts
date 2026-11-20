import type { SupabaseClient } from '@supabase/supabase-js'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingEvidence } from '@/lib/core/bookkeeping/year-end-business-events'
import type { JournalEntry } from '@/types'
import {
  accruedInterestAt,
  initialRecognitionLines,
  leaseSchedule,
  type FinanceLease,
  type LeaseAccounts,
  type LeaseSchedule,
} from './finance-lease'
import { bookFinanceLeasesYearEnd } from './posting'

/**
 * The lessee's register of finansiella leasingavtal (finance_leases) and the
 * year's booking: the start of each new lease (asset and liability, K3 20.5)
 * and the year-end adjustment for all of them (20.9, 20.11), once per year
 * (finance_lease_postings). Opt-in: company_settings.
 * finance_lease_capitalisation, the company's choice against the 20.29
 * relief.
 */

export interface FinanceLeaseRow {
  id: string
  company_id: string
  name: string
  start_date: string
  fair_value: number | string
  payment: number | string
  number_of_payments: number
  periods_per_year: number
  payments_in_advance: boolean
  guaranteed_residual: number | string
  annual_rate_percent: number | string
  direct_costs: number | string
  useful_life_months: number
  ownership_transfers: boolean
  asset_account: string
  accumulated_depreciation_account: string
  liability_account: string
  lease_cost_account: string
  interest_account: string
  accrued_interest_account: string
  depreciation_account: string
  direct_cost_account: string | null
  initial_entry_id: string | null
  created_at?: string
}

export type FinanceLeaseInput = Omit<FinanceLeaseRow, 'id' | 'company_id' | 'initial_entry_id' | 'created_at'>

export class FinanceLeaseError extends Error {
  constructor(
    readonly code:
      | 'FINANCE_LEASE_NOT_ENABLED'
      | 'FINANCE_LEASE_NOT_FOUND'
      | 'FINANCE_LEASE_NO_PERIOD'
      | 'FINANCE_LEASE_YEAR_ALREADY_POSTED'
      | 'FINANCE_LEASE_START_NOT_BOOKED',
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'FinanceLeaseError'
  }
}

export function leaseFromRow(row: FinanceLeaseRow): FinanceLease {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    fairValue: Number(row.fair_value),
    payment: Number(row.payment),
    numberOfPayments: row.number_of_payments,
    periodsPerYear: row.periods_per_year as FinanceLease['periodsPerYear'],
    paymentsInAdvance: row.payments_in_advance,
    guaranteedResidual: Number(row.guaranteed_residual),
    annualRatePercent: Number(row.annual_rate_percent),
    directCosts: Number(row.direct_costs),
    usefulLifeMonths: row.useful_life_months,
    ownershipTransfers: row.ownership_transfers,
  }
}

export function accountsFromRow(row: FinanceLeaseRow): LeaseAccounts {
  return {
    asset: row.asset_account,
    accumulatedDepreciation: row.accumulated_depreciation_account,
    liability: row.liability_account,
    accruedInterest: row.accrued_interest_account,
    leaseCost: row.lease_cost_account,
    interest: row.interest_account,
    depreciation: row.depreciation_account,
  }
}

export async function listFinanceLeases(supabase: SupabaseClient, companyId: string): Promise<FinanceLeaseRow[]> {
  const { data, error } = await supabase
    .from('finance_leases')
    .select('id, company_id, name, start_date, fair_value, payment, number_of_payments, periods_per_year, payments_in_advance, guaranteed_residual, annual_rate_percent, direct_costs, useful_life_months, ownership_transfers, asset_account, accumulated_depreciation_account, liability_account, lease_cost_account, interest_account, accrued_interest_account, depreciation_account, direct_cost_account, initial_entry_id, created_at')
    .eq('company_id', companyId)
    .order('start_date', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as FinanceLeaseRow[]
}

export async function getFinanceLease(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
): Promise<{ row: FinanceLeaseRow; schedule: LeaseSchedule }> {
  const { data, error } = await supabase
    .from('finance_leases')
    .select('id, company_id, name, start_date, fair_value, payment, number_of_payments, periods_per_year, payments_in_advance, guaranteed_residual, annual_rate_percent, direct_costs, useful_life_months, ownership_transfers, asset_account, accumulated_depreciation_account, liability_account, lease_cost_account, interest_account, accrued_interest_account, depreciation_account, direct_cost_account, initial_entry_id, created_at')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new FinanceLeaseError('FINANCE_LEASE_NOT_FOUND')
  const row = data as unknown as FinanceLeaseRow
  return { row, schedule: leaseSchedule(leaseFromRow(row)) }
}

export async function createFinanceLease(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: FinanceLeaseInput,
): Promise<FinanceLeaseRow> {
  const { data, error } = await supabase
    .from('finance_leases')
    .insert({
      company_id: companyId,
      user_id: userId,
      name: input.name,
      start_date: input.start_date,
      fair_value: input.fair_value,
      payment: input.payment,
      number_of_payments: input.number_of_payments,
      periods_per_year: input.periods_per_year,
      payments_in_advance: input.payments_in_advance,
      guaranteed_residual: input.guaranteed_residual,
      annual_rate_percent: input.annual_rate_percent,
      direct_costs: input.direct_costs,
      useful_life_months: input.useful_life_months,
      ownership_transfers: input.ownership_transfers,
      asset_account: input.asset_account,
      accumulated_depreciation_account: input.accumulated_depreciation_account,
      liability_account: input.liability_account,
      lease_cost_account: input.lease_cost_account,
      interest_account: input.interest_account,
      accrued_interest_account: input.accrued_interest_account,
      depreciation_account: input.depreciation_account,
      direct_cost_account: input.direct_cost_account,
    })
    .select('id, company_id, name, start_date, fair_value, payment, number_of_payments, periods_per_year, payments_in_advance, guaranteed_residual, annual_rate_percent, direct_costs, useful_life_months, ownership_transfers, asset_account, accumulated_depreciation_account, liability_account, lease_cost_account, interest_account, accrued_interest_account, depreciation_account, direct_cost_account, initial_entry_id, created_at')
    .single()
  if (error) throw error
  return data as unknown as FinanceLeaseRow
}

/** Whether the company capitalises finansiella leasingavtal (20.5) instead of the 20.29 relief. */
export async function financeLeaseCapitalisationChosen(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('finance_lease_capitalisation')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data?.finance_lease_capitalisation)
}

function initialRecognitionEvent(args: { startDate: string; amount: number }): BusinessEventDraft {
  return {
    kind: 'ledger.system',
    category: null,
    occurredOn: args.startDate,
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    ...postingEvidence(linkBasisColumns('user_created')),
    mappingVersion: mappingVersion('financeLease'),
    jurisdiction: 'SE',
  }
}

export interface BookFinanceLeaseYearResult {
  initialEntries: JournalEntry[]
  yearEndEntry: JournalEntry | null
}

/**
 * Books one financial year: the start of every lease that begins in it,
 * then the year-end adjustment for every lease running in it. Refused while
 * the company has not chosen capitalisation, for a year already booked, and
 * for a lease that began before the year without its start booked (its
 * earlier year comes first).
 */
export async function bookFinanceLeaseYear(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
): Promise<BookFinanceLeaseYearResult> {
  if (!(await financeLeaseCapitalisationChosen(supabase, companyId))) {
    throw new FinanceLeaseError('FINANCE_LEASE_NOT_ENABLED')
  }
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .eq('id', fiscalPeriodId)
    .maybeSingle()
  if (periodError) throw periodError
  if (!period) throw new FinanceLeaseError('FINANCE_LEASE_NO_PERIOD')

  const { data: posted, error: postedError } = await supabase
    .from('finance_lease_postings')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (postedError) throw postedError
  if (posted) throw new FinanceLeaseError('FINANCE_LEASE_YEAR_ALREADY_POSTED')

  const rows = (await listFinanceLeases(supabase, companyId)).filter((row) => row.start_date <= period.period_end)
  const unbooked = rows.filter((row) => !row.initial_entry_id && row.start_date < period.period_start)
  if (unbooked.length > 0) {
    throw new FinanceLeaseError('FINANCE_LEASE_START_NOT_BOOKED', { leases: unbooked.map((row) => row.name) })
  }

  const initialEntries: JournalEntry[] = []
  for (const row of rows.filter((r) => !r.initial_entry_id)) {
    const lease = leaseFromRow(row)
    const schedule = leaseSchedule(lease)
    const entry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      event: () => initialRecognitionEvent({ startDate: row.start_date, amount: schedule.initialAsset }),
      input: {
        fiscal_period_id: fiscalPeriodId,
        entry_date: row.start_date,
        description: `Finansiellt leasingavtal ${row.name}: tillgång och skuld`,
        source_type: 'system',
        voucher_series: 'A',
        lines: initialRecognitionLines(lease, schedule, accountsFromRow(row), row.direct_cost_account ?? accountsFromRow(row).leaseCost),
      },
    })
    const { error: linkError } = await supabase
      .from('finance_leases')
      .update({ initial_entry_id: entry.id })
      .eq('company_id', companyId)
      .eq('id', row.id)
    if (linkError) throw linkError
    initialEntries.push(entry)
  }

  const yearEndEntry = await bookFinanceLeasesYearEnd({
    supabase,
    companyId,
    userId,
    fiscalPeriodId,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    leases: rows.map((row) => {
      const lease = leaseFromRow(row)
      return {
        lease,
        accounts: accountsFromRow(row),
        openingAccruedInterest: accruedInterestAt(lease, leaseSchedule(lease), period.period_start),
      }
    }),
  })

  const { error: insertError } = await supabase
    .from('finance_lease_postings')
    .insert({ company_id: companyId, fiscal_period_id: fiscalPeriodId, journal_entry_id: yearEndEntry?.id ?? null })
  if (insertError) throw insertError
  return { initialEntries, yearEndEntry }
}
