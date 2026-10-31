/**
 * The books as a whole: what must hold between the reports whatever the
 * company did. These read the ledger, the bank rows and the two reskontra
 * against each other, and all of them against the answer key.
 */
import { describe, expect, it } from 'vitest'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { SIM_COMPANY } from './generate'
import { loadSimCompany } from './company'

const { state, plan, key, doors, supabase } = loadSimCompany()

interface BalanceRow {
  account_number: string
  opening_debit: number
  opening_credit: number
  period_debit: number
  period_credit: number
  closing_debit: number
  closing_credit: number
}

const closedYears = plan.events.flatMap((event) => (event.type === 'year_end' ? [event.year] : []))
const allYears = Object.keys(state.fiscalPeriods).map(Number)

const trialBalance = (year: number) => doors.call('gnubok_get_trial_balance', { period_id: state.fiscalPeriods[year] })
const closing = (row: BalanceRow | undefined) => (row ? row.closing_debit - row.closing_credit : 0)
const opening = (row: BalanceRow | undefined) => (row ? row.opening_debit - row.opening_credit : 0)

describe.each(allYears)('books of %i', (year) => {
  it('balance', async () => {
    const balance = await trialBalance(year)
    expect(balance.is_balanced).toBe(true)
    expect(balance.total_debit).toBeCloseTo(balance.total_credit, 2)
  })

  it('have no voucher number gaps', async () => {
    const gaps = await doors.call('gnubok_list_voucher_gaps', { fiscal_period_id: state.fiscalPeriods[year] })
    expect(gaps.gaps).toEqual([])
  })
})

describe.each(closedYears)('the step from %i into the next year', (year) => {
  it('opens every balance account where the year closed it', async () => {
    const [closed, next] = await Promise.all([trialBalance(year), trialBalance(year + 1)])
    const opened = new Map<string, BalanceRow>(next.rows.map((row: BalanceRow) => [row.account_number, row]))
    const differences = (closed.rows as BalanceRow[])
      .filter((row) => row.account_number < '3000')
      .filter((row) => Math.abs(closing(row) - opening(opened.get(row.account_number))) > 0.004)
      .map((row) => [row.account_number, closing(row), opening(opened.get(row.account_number))])
    expect(differences).toEqual([])
  })
})

describe('the bank', () => {
  const lastDay = plan.events.at(-1)!.date

  it('has a booked row behind every krona on 1930', async () => {
    const rows = await fetchAllRows<{ amount: number; journal_entry_id: string | null; date: string }>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('amount, journal_entry_id, date')
        .eq('company_id', state.companyId)
        .range(from, to),
    )
    expect(rows.filter((row) => !row.journal_entry_id)).toEqual([])
    const bank = rows.reduce((total, row) => total + Number(row.amount), 0)
    const year = Number(lastDay.slice(0, 4))
    const { rows: balances } = await trialBalance(year)
    const ledger = closing(balances.find((row: BalanceRow) => row.account_number === '1930'))
    expect(ledger).toBeCloseTo(bank, 2)
    expect(ledger).toBeCloseTo(key.years[year].cash, 2)
  })
})

describe('the reskontra', () => {
  it.each(closedYears)('agree with the balance sheet at the end of %i', async (year) => {
    const asOf = `${year}-12-31`
    const [customers, suppliers] = await Promise.all([
      doors.call('gnubok_get_ar_ledger', { as_of_date: asOf }),
      doors.call('gnubok_get_supplier_ledger', { as_of_date: asOf }),
    ])
    expect(customers.total_outstanding ?? customers.total).toBeCloseTo(key.years[year].receivables, 2)
    expect(suppliers.total_outstanding ?? suppliers.total).toBeCloseTo(key.years[year].supplierPayables, 2)
  })
})

describe('the build', () => {
  it.skipIf(state.until)('played the whole company and closed its years', () => {
    expect(state.events).toBe(plan.events.length)
    expect(closedYears).toEqual(SIM_COMPANY.closedYears)
  })

  // Proof of life: a build that booked next to nothing would pass everything above.
  it('left real books behind', async () => {
    const { count } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', state.companyId)
    expect(count).toBeGreaterThan(plan.events.length / 2)
  })
})
