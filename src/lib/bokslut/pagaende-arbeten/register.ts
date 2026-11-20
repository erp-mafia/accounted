import type { SupabaseClient } from '@supabase/supabase-js'
import { RUTA_05_EXCLUDED_ACCOUNTS, resolveRevenueDeclarationBox } from '@/lib/reports/vat-revenue-accounts'
import { resolveAccountingFramework } from '@/lib/company/accounting-framework'
import { ContractRevenueRefusedError, type ContractRevenueRefusal } from '@/lib/bookkeeping/errors'
import type { AccountingFramework, JournalEntry } from '@/types'
import {
  DEFAULT_CONTRACT_REVENUE_ACCOUNTS,
  computeContractRevenue,
  type ContractInput,
  type ContractRevenueAccounts,
  type ContractRevenueResult,
} from './calculator'
import {
  ContractRevenueAccountError,
  bookContractRevenueAdjustment,
  fetchLedgerPositionBalances,
  fetchRegisterBalances,
  unregisteredBalances,
} from './posting'
import type { ContractRevenueSettings, ContractRevenueYearPreview, ContractRow, ContractRowInput } from './types'

export type { ContractRevenueSettings, ContractRevenueYearPreview, ContractRow, ContractRowInput } from './types'

/**
 * The pågående uppdrag of a company (contract_revenue_contracts), its choice
 * of method and adjustment account (contract_revenue_settings), and the
 * year's booking: the change in the positions on balansdagen through the
 * posting port (bookContractRevenueAdjustment). Behind
 * NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED.
 *
 * The adjustment account stays outside the momsdeklaration: the rutor are
 * derived from the account, so it is pinned with no momskod, no momsruta and
 * momssats 0 (ingen moms), which no ruta reads. The database keeps it there
 * (20261027180109_contract_revenue.sql, 20261108174501): saving the settings
 * pins it first, and an account a booked year took the adjustment on stays
 * pinned after the settings move or are deleted.
 *
 * Pågående arbeten are booked here under K3 kapitel 23, so only in a year
 * reported under K3 (the year's own framework).
 */

export type ContractRevenueErrorCode =
  | 'CONTRACT_REVENUE_NOT_CONFIGURED'
  | 'CONTRACT_REVENUE_NOT_FOUND'
  | 'CONTRACT_REVENUE_NO_PERIOD'
  | 'CONTRACT_REVENUE_FIGURES_DATE'
  | 'CONTRACT_REVENUE_INCOMPLETE'
  | 'CONTRACT_REVENUE_ACCOUNT_MISSING'
  | 'CONTRACT_REVENUE_ACCOUNT_VAT'
  | 'CONTRACT_REVENUE_ACCOUNT_IN_USE'
  | 'CONTRACT_REVENUE_NOT_K3'
  | 'CONTRACT_REVENUE_STALE'
  | 'CONTRACT_REVENUE_LATER_YEAR_BOOKED'

/** What the database's refusals of a booking answer (commit_contract_revenue). */
const REFUSAL_CODES: Record<ContractRevenueRefusal, ContractRevenueErrorCode> = {
  not_k3: 'CONTRACT_REVENUE_NOT_K3',
  stale: 'CONTRACT_REVENUE_STALE',
  later_year: 'CONTRACT_REVENUE_LATER_YEAR_BOOKED',
}

export class ContractRevenueError extends Error {
  constructor(
    readonly code: ContractRevenueErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'ContractRevenueError'
  }
}

const num = (value: number | string | null): number | null => (value === null ? null : Number(value))

export function contractFromRow(row: ContractRow): ContractInput {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    uppdragsinkomst: Number(row.contract_value),
    beraknade_totala_utgifter: Number(row.expected_total_cost),
    nedlagda_utgifter: Number(row.costs_to_date),
    fakturerat: Number(row.billed_to_date),
    innehallna_belopp: Number(row.retained_amounts),
    tillforlitligt_utfall: row.reliable_outcome,
    fardigstallandegrad_metod: row.grade_method,
    angiven_fardigstallandegrad: num(row.stated_grade),
    ersattningsbara_utgifter: num(row.reimbursable_costs),
    upparbetat_lopande: num(row.value_worked),
    vasentligen_fullgjort: row.substantially_complete,
  }
}

export async function getContractRevenueSettings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ContractRevenueSettings | null> {
  const { data, error } = await supabase
    .from('contract_revenue_settings')
    .select('method, revenue_account')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return (data as ContractRevenueSettings | null) ?? null
}

/**
 * Chooses the method and the adjustment account. The account must be a
 * class 3 account of the chart that no ruta reads today and that carries no
 * posted line outside the register's own verifikat; it is then pinned at
 * momssats 0 (ingen moms). An account with a momskod, a momsruta or a
 * momssats is refused rather than cleared: that configuration is the
 * company's, and a sales account must not become the adjustment account.
 */
export async function saveContractRevenueSettings(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  settings: ContractRevenueSettings,
): Promise<ContractRevenueSettings> {
  const account = settings.revenue_account
  const { data: row, error: rowError } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name, account_class, default_vat_rate, default_vat_treatment, vat_box')
    .eq('company_id', companyId)
    .eq('account_number', account)
    .maybeSingle()
  if (rowError) throw rowError
  if (!row) throw new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_MISSING', { account })

  const rate = row.default_vat_rate === null ? null : Number(row.default_vat_rate)
  // resolveRevenueDeclarationBox covers the fixed BAS map and the inference;
  // a momskod, a momsruta or a momssats other than 0 is refused as it stands.
  const readByRuta =
    RUTA_05_EXCLUDED_ACCOUNTS.has(account) ||
    row.default_vat_treatment !== null ||
    row.vat_box != null ||
    (rate !== null && rate !== 0) ||
    resolveRevenueDeclarationBox(row) !== null
  if (readByRuta) throw new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_VAT', { account })

  // In use for something else: asked before the momssats is pinned, so a
  // refused account keeps its configuration. The settings trigger holds the
  // same rule (contract_revenue_account_in_use).
  const { data: inUse, error: inUseError } = await supabase.rpc('contract_revenue_account_in_use', {
    p_company_id: companyId,
    p_account: account,
  })
  if (inUseError) throw inUseError
  if (inUse === true && (await getContractRevenueSettings(supabase, companyId))?.revenue_account !== account) {
    throw new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_IN_USE', { account })
  }

  if (rate === null) {
    const { error: pinError } = await supabase
      .from('chart_of_accounts')
      .update({ default_vat_rate: 0 })
      .eq('company_id', companyId)
      .eq('account_number', account)
    if (pinError) throw pinError
  }

  const { data, error } = await supabase
    .from('contract_revenue_settings')
    .upsert({ company_id: companyId, user_id: userId, method: settings.method, revenue_account: account }, { onConflict: 'company_id' })
    .select('method, revenue_account')
    .single()
  if (error) {
    if (error.code === 'PT409' && error.message === 'CONTRACT_REVENUE_ACCOUNT_IN_USE') {
      throw new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_IN_USE', { account })
    }
    throw error
  }
  return data as ContractRevenueSettings
}

/**
 * Stops using pågående arbeten: the method and account are removed. The
 * uppdrag stay, and so does the pin on an account a booked year took the
 * adjustment on; any other account is released.
 */
export async function deleteContractRevenueSettings(supabase: SupabaseClient, companyId: string): Promise<void> {
  const { data, error } = await supabase
    .from('contract_revenue_settings')
    .delete()
    .eq('company_id', companyId)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new ContractRevenueError('CONTRACT_REVENUE_NOT_CONFIGURED')
}

export async function listContracts(supabase: SupabaseClient, companyId: string): Promise<ContractRow[]> {
  const { data, error } = await supabase
    .from('contract_revenue_contracts')
    .select('id, company_id, name, kind, figures_as_of, contract_value, expected_total_cost, costs_to_date, billed_to_date, retained_amounts, reliable_outcome, grade_method, stated_grade, reimbursable_costs, value_worked, substantially_complete, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as ContractRow[]
}

export async function createContract(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: ContractRowInput,
): Promise<ContractRow> {
  const { data, error } = await supabase
    .from('contract_revenue_contracts')
    .insert({
      company_id: companyId,
      user_id: userId,
      name: input.name,
      kind: input.kind,
      figures_as_of: input.figures_as_of,
      contract_value: input.contract_value,
      expected_total_cost: input.expected_total_cost,
      costs_to_date: input.costs_to_date,
      billed_to_date: input.billed_to_date,
      retained_amounts: input.retained_amounts,
      reliable_outcome: input.reliable_outcome,
      grade_method: input.grade_method,
      stated_grade: input.stated_grade,
      reimbursable_costs: input.reimbursable_costs,
      value_worked: input.value_worked,
      substantially_complete: input.substantially_complete,
    })
    .select('id, company_id, name, kind, figures_as_of, contract_value, expected_total_cost, costs_to_date, billed_to_date, retained_amounts, reliable_outcome, grade_method, stated_grade, reimbursable_costs, value_worked, substantially_complete, created_at')
    .single()
  if (error) throw error
  return data as unknown as ContractRow
}

export async function updateContract(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  input: ContractRowInput,
): Promise<ContractRow> {
  const { data, error } = await supabase
    .from('contract_revenue_contracts')
    .update({
      name: input.name,
      kind: input.kind,
      figures_as_of: input.figures_as_of,
      contract_value: input.contract_value,
      expected_total_cost: input.expected_total_cost,
      costs_to_date: input.costs_to_date,
      billed_to_date: input.billed_to_date,
      retained_amounts: input.retained_amounts,
      reliable_outcome: input.reliable_outcome,
      grade_method: input.grade_method,
      stated_grade: input.stated_grade,
      reimbursable_costs: input.reimbursable_costs,
      value_worked: input.value_worked,
      substantially_complete: input.substantially_complete,
    })
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id, company_id, name, kind, figures_as_of, contract_value, expected_total_cost, costs_to_date, billed_to_date, retained_amounts, reliable_outcome, grade_method, stated_grade, reimbursable_costs, value_worked, substantially_complete, created_at')
    .maybeSingle()
  if (error) throw error
  if (!data) throw new ContractRevenueError('CONTRACT_REVENUE_NOT_FOUND')
  return data as unknown as ContractRow
}

export async function deleteContract(supabase: SupabaseClient, companyId: string, id: string): Promise<void> {
  const { data, error } = await supabase
    .from('contract_revenue_contracts')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new ContractRevenueError('CONTRACT_REVENUE_NOT_FOUND')
}

interface ContractRevenueYear {
  settings: ContractRevenueSettings
  balansdag: string
  framework: AccountingFramework
  rows: ContractRow[]
  accounts: ContractRevenueAccounts
}

async function loadYear(supabase: SupabaseClient, companyId: string, fiscalPeriodId: string): Promise<ContractRevenueYear> {
  const settings = await getContractRevenueSettings(supabase, companyId)
  if (!settings) throw new ContractRevenueError('CONTRACT_REVENUE_NOT_CONFIGURED')
  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_end')
    .eq('company_id', companyId)
    .eq('id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw error
  if (!period) throw new ContractRevenueError('CONTRACT_REVENUE_NO_PERIOD')
  return {
    settings,
    balansdag: period.period_end,
    framework: await resolveAccountingFramework(supabase, companyId, fiscalPeriodId),
    rows: await listContracts(supabase, companyId),
    accounts: { ...DEFAULT_CONTRACT_REVENUE_ACCOUNTS, revenueAdjustment: settings.revenue_account },
  }
}

const statedOnOtherDay = (year: ContractRevenueYear) =>
  year.rows.filter((row) => row.figures_as_of !== year.balansdag).map((row) => row.name)

function namedIssues(year: ContractRevenueYear, result: ContractRevenueResult) {
  const names = new Map(year.rows.map((row) => [row.id, row.name]))
  return result.issues.map((issue) => ({ code: issue.code, contract: names.get(issue.contractId) ?? issue.contractId }))
}

/** What booking the year would do, without booking it. */
export async function previewContractRevenueYear(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<ContractRevenueYearPreview> {
  const year = await loadYear(supabase, companyId, fiscalPeriodId)
  const [register, ledger] = await Promise.all([
    fetchRegisterBalances(supabase, companyId, year.balansdag),
    fetchLedgerPositionBalances(supabase, companyId, fiscalPeriodId, year.accounts),
  ])
  const result = computeContractRevenue(year.settings.method, year.rows.map(contractFromRow), year.accounts, register)
  return {
    method: year.settings.method,
    balansdag: year.balansdag,
    framework: year.framework,
    revenue_account: year.settings.revenue_account,
    positions: result.positions,
    lines: result.lines,
    issues: namedIssues(year, result),
    stated_on_other_day: statedOnOtherDay(year),
    unregistered: unregisteredBalances(ledger, register, year.accounts),
  }
}

export interface BookContractRevenueYearResult {
  result: ContractRevenueResult
  entry: JournalEntry | null
}

/**
 * Books the year's change in the pågående arbeten on balansdagen. The year
 * must be reported under K3 (kapitel 23 is the rule booked here; K2 has its
 * own in kapitel 6), every uppdrag's figures must be stated for that
 * balansdag (a figure for another day would book the wrong year), and the
 * calculation must have no open issue (a missing grade or value, an estimate
 * below the costs already incurred). Booking the same year again books only
 * what changed; a second booking computed from the same state (a double
 * click), or an earlier year while a later year's booking stands, is refused
 * by the database.
 */
export async function bookContractRevenueYear(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
): Promise<BookContractRevenueYearResult> {
  const year = await loadYear(supabase, companyId, fiscalPeriodId)
  if (year.framework !== 'k3') throw new ContractRevenueError('CONTRACT_REVENUE_NOT_K3', { framework: year.framework })
  const otherDay = statedOnOtherDay(year)
  if (otherDay.length > 0) {
    throw new ContractRevenueError('CONTRACT_REVENUE_FIGURES_DATE', { balansdag: year.balansdag, contracts: otherDay })
  }
  let booked: BookContractRevenueYearResult
  try {
    booked = await bookContractRevenueAdjustment({
      supabase,
      companyId,
      userId,
      fiscalPeriodId,
      periodEnd: year.balansdag,
      method: year.settings.method,
      contracts: year.rows.map(contractFromRow),
      accounts: year.accounts,
      refuseWithIssues: true,
    })
  } catch (err) {
    // The database keeps the account outside every ruta; this is the last check before the verifikat.
    if (err instanceof ContractRevenueAccountError) {
      throw new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_VAT', { account: err.account })
    }
    if (err instanceof ContractRevenueRefusedError) throw new ContractRevenueError(REFUSAL_CODES[err.reason])
    throw err
  }
  if (booked.result.issues.length > 0) {
    throw new ContractRevenueError('CONTRACT_REVENUE_INCOMPLETE', { issues: namedIssues(year, booked.result) })
  }
  return booked
}
