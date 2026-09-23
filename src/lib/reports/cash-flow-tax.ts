import type { SupabaseClient } from '@supabase/supabase-js'
import type { TrialBalanceRow } from '@/types'
import { fetchEntryLines } from '@/lib/bookkeeping/entry-lines'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

// BAS current income tax, including prior-year adjustments and refunds.
// Deferred tax (894x) has no payment effect. Other 89xx accounts need an
// explicit classification rather than being assumed to be current income tax.
const CURRENT_TAX_EXPENSE = /^(891|892|893)/
// BAS 2026 also places paid/unpaid foreign income tax in operating expenses.
// K3 29.2 includes foreign income taxes, so add these back before the tax line.
const OPERATING_INCOME_TAX_EXPENSE = new Set(['6996', '6997'])
const isCurrentTaxExpense = (account: string) => CURRENT_TAX_EXPENSE.test(account)
  || OPERATING_INCOME_TAX_EXPENSE.has(account)
const CURRENT_TAX_BALANCE = new Set(['1640', '2510', '2512', '2517', '2518'])
const OTHER_TAX_BALANCE = new Set(['2513', '2514', '2515'])
const OTHER_TAX_EXPENSE = new Set(['5191', '7533', '7550'])
const r2 = (value: number) => Math.round(value * 100) / 100 || 0

export class CashFlowTaxAllocationError extends Error {
  readonly code = 'CASH_FLOW_TAX_ALLOCATION_REQUIRED'

  constructor() {
    super('Income tax cannot be separated from other taxes in these postings')
    this.name = 'CashFlowTaxAllocationError'
  }
}

interface TaxLine {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  journal_entries: { reverses_id: string | null; correction_of_id: string | null }
}

/**
 * A transfer of pension/property tax into generic 2510 is not income tax.
 * Balance totals lose that distinction, so inspect the original entries only
 * when generic 2510 and other tax accounts both have activity.
 *
 * Pure tax accruals/reclassifications are unambiguous. If they mix with a
 * settlement on 2510, the payment's income-tax share is not established by
 * account totals. Refuse that allocation instead of silently guessing it.
 */
async function nonIncomeTaxTransfer(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  openingEntryId: string | null,
): Promise<number> {
  const [reversedYearEnd, lines] = await Promise.all([
    fetchAllRows<{ id: string }>(({ from, to }) =>
      supabase.from('journal_entries').select('id')
        .eq('company_id', companyId).eq('source_type', 'year_end').eq('status', 'reversed')
        .order('id', { ascending: true }).range(from, to),
    ),
    fetchEntryLines<TaxLine>({
      supabase,
      entryColumns: 'id, reverses_id, correction_of_id',
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: query => {
        const scoped = query.eq('company_id', companyId).eq('fiscal_period_id', fiscalPeriodId)
          .in('status', ['posted', 'reversed']).neq('source_type', 'year_end')
        return openingEntryId ? scoped.neq('id', openingEntryId) : scoped
      },
    }),
  ])
  const excluded = new Set(reversedYearEnd.map(entry => entry.id))
  const entries = new Map<string, TaxLine[]>()
  for (const line of lines) {
    const entry = line.journal_entries
    if ((entry.reverses_id && excluded.has(entry.reverses_id))
      || (entry.correction_of_id && excluded.has(entry.correction_of_id))) continue
    if (!line.debit_amount && !line.credit_amount) continue
    const group = entries.get(line.journal_entry_id) ?? []
    group.push(line)
    entries.set(line.journal_entry_id, group)
  }

  let transfer = 0
  let hasOtherTaxTransfer = false
  let hasGenericSettlement = false
  for (const group of entries.values()) {
    if (!group.some(line => line.account_number === '2510')) continue
    const other = group.filter(line => OTHER_TAX_BALANCE.has(line.account_number)
      || OTHER_TAX_EXPENSE.has(line.account_number))
    const pureTaxEntry = group.every(line => CURRENT_TAX_BALANCE.has(line.account_number)
      || isCurrentTaxExpense(line.account_number)
      || OTHER_TAX_BALANCE.has(line.account_number) || OTHER_TAX_EXPENSE.has(line.account_number))
    if (other.length > 0) {
      if (!pureTaxEntry) {
        // Separately identified income-tax and other-tax liabilities can be
        // paid together in one voucher. Same-direction liability movements
        // against bank/skattekonto do not need an inferred reclassification.
        const incomeMovement = group.filter(line => CURRENT_TAX_BALANCE.has(line.account_number))
          .reduce((sum, line) => sum + Number(line.debit_amount) - Number(line.credit_amount), 0)
        const otherMovement = other.reduce((sum, line) => sum + Number(line.debit_amount) - Number(line.credit_amount), 0)
        const separateSettlements = incomeMovement * otherMovement > 0
          && group.every(line => CURRENT_TAX_BALANCE.has(line.account_number)
            || OTHER_TAX_BALANCE.has(line.account_number)
            || line.account_number === '1630' || line.account_number.startsWith('19'))
        if (!separateSettlements) throw new CashFlowTaxAllocationError()
        hasGenericSettlement = true
        continue
      }
      hasOtherTaxTransfer = true
      transfer += other.reduce((sum, line) => sum + Number(line.debit_amount) - Number(line.credit_amount), 0)
    } else if (!pureTaxEntry) {
      hasGenericSettlement = true
    }
  }
  if (hasOtherTaxTransfer && hasGenericSettlement) throw new CashFlowTaxAllocationError()
  return r2(transfer)
}

/**
 * Indirect-method income-tax bridge: signed current tax expense minus the
 * debit-side change in tax liabilities, prepayments and tax receivables.
 * All inputs use the report's existing exclude-all-year-end scope.
 *
 * Generic 2510 follows the report's BAS income-tax convention except where
 * current-period entries explicitly identify other taxes. Historical/custom
 * subdivisions of an imported generic opening balance are not inferable here.
 */
export async function calculateCashFlowTax(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  openingEntryId: string | null,
  rows: TrialBalanceRow[],
): Promise<{ paidIncomeTax: number; otherTaxLiabilityChange: number; expenseInOperatingProfit: number }> {
  let expense = 0
  let expenseInOperatingProfit = 0
  let incomeTaxDelta = 0
  let otherTaxDelta = 0
  for (const row of rows) {
    const account = row.account_number
    const movement = row.period_debit - row.period_credit
    if (isCurrentTaxExpense(account)) expense -= movement
    else if (account.startsWith('89') && !account.startsWith('894') && account !== '8999' && r2(movement) !== 0) {
      throw new CashFlowTaxAllocationError()
    }
    if (OPERATING_INCOME_TAX_EXPENSE.has(account)) expenseInOperatingProfit += movement
    const delta = row.closing_debit - row.closing_credit - row.opening_debit + row.opening_credit
    if (CURRENT_TAX_BALANCE.has(account)) incomeTaxDelta += delta
    if (OTHER_TAX_BALANCE.has(account)) otherTaxDelta += delta
  }
  const active = (row: TrialBalanceRow) => row.period_debit !== 0 || row.period_credit !== 0
  const needsEvidence = rows.some(row => row.account_number === '2510' && active(row))
    && rows.some(row => (OTHER_TAX_BALANCE.has(row.account_number) || OTHER_TAX_EXPENSE.has(row.account_number)) && active(row))
  const transferred = needsEvidence
    ? await nonIncomeTaxTransfer(supabase, companyId, fiscalPeriodId, openingEntryId)
    : 0
  return {
    paidIncomeTax: r2(expense - incomeTaxDelta - transferred),
    otherTaxLiabilityChange: r2(-otherTaxDelta + transferred),
    expenseInOperatingProfit: r2(expenseInOperatingProfit),
  }
}
