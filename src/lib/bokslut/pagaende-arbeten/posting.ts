import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingEvidence } from '@/lib/core/bookkeeping/year-end-business-events'
import { roundOre } from '@/lib/money'
import type { JournalEntry } from '@/types'
import {
  computeContractRevenue,
  type ContractInput,
  type ContractRevenueAccounts,
  type ContractRevenueMethod,
  type ContractRevenueResult,
} from './calculator'

/**
 * Books the pågående-arbeten adjustment on balansdagen: a year_end draft
 * through the posting port, committed with what it was computed from by
 * commit_contract_revenue (one transaction; the engine draws the voucher
 * number, the period lock and the balance trigger apply as to every
 * verifikat). The adjustment is the difference between the positions
 * computeContractRevenue derives and what the register's own verifikat
 * already hold on the position accounts (contract_revenue_register_balances),
 * so running it twice books nothing the second time, a change in an estimate
 * books only the change (K3 23.21), and a balance the register did not book
 * (another provision on 2290, pågående arbeten booked by hand) is never moved.
 */

export class ContractRevenueAccountError extends Error {
  readonly code = 'CONTRACT_REVENUE_ACCOUNT_INVALID'
  constructor(readonly account: string, readonly reason: 'not_revenue' | 'vat_ruta') {
    super(reason === 'vat_ruta'
      ? `Konto ${account} ingår i momsdeklarationen och kan inte ta upparbetade intäkter`
      : `Konto ${account} är inte ett intäktskonto (kontoklass 3)`)
    this.name = 'ContractRevenueAccountError'
  }
}

/**
 * The revenue adjustment must be a class 3 account no momsdeklaration ruta
 * reads: upparbetad intäkt is not a supply, and on 3001 it would change
 * ruta 05 of the period that holds balansdagen.
 */
export async function assertRevenueAdjustmentAccount(
  supabase: SupabaseClient,
  companyId: string,
  account: string,
): Promise<void> {
  if (!account.startsWith('3')) throw new ContractRevenueAccountError(account, 'not_revenue')
  const dynamic = await fetchDynamicVatAccounts(supabase, companyId)
  const inFixedMap = Object.prototype.hasOwnProperty.call(ACCOUNT_RUTA, account) && !dynamic.explicitAccounts.has(account)
  if (inFixedMap || dynamic.mappingByAccount.has(account)) {
    throw new ContractRevenueAccountError(account, 'vat_ruta')
  }
}

/**
 * What the register's own verifikat (its bookings, their stornos and their
 * rättelse verifikat) hold per account on a day, debit positive: the base the
 * adjustment is computed from.
 */
export async function fetchRegisterBalances(
  supabase: SupabaseClient,
  companyId: string,
  asOf: string,
): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc('contract_revenue_register_balances', {
    p_company_id: companyId,
    p_as_of: asOf,
  })
  if (error) throw new Error(`Kunde inte läsa registrets verifikationer: ${error.message}`)
  const balances: Record<string, number> = {}
  for (const row of (data ?? []) as Array<{ account_number: string; balance: number | string }>) {
    balances[row.account_number] = Number(row.balance)
  }
  return balances
}

/** The position accounts' whole ledger balances on balansdagen (debit positive), every posted entry included. */
export async function fetchLedgerPositionBalances(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  accounts: ContractRevenueAccounts,
): Promise<Record<string, number>> {
  const positionAccounts = new Set(positionAccountsOf(accounts))
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' })
  const balances: Record<string, number> = {}
  for (const row of rows) {
    if (!positionAccounts.has(row.account_number)) continue
    balances[row.account_number] = (row.closing_debit || 0) - (row.closing_credit || 0)
  }
  return balances
}

function positionAccountsOf(accounts: ContractRevenueAccounts): string[] {
  return [accounts.accruedRevenue, accounts.billedInAdvance, accounts.lossProvision, accounts.wipCosts, accounts.wipBilling]
}

/**
 * What the position accounts hold beyond the register's own verifikat on
 * balansdagen (debit positive): another provision on 2290, pågående arbeten
 * booked by hand or brought in with the opening balances. The adjustment
 * leaves it as it is; the page shows it so the company can judge it.
 */
export function unregisteredBalances(
  ledger: Readonly<Record<string, number>>,
  register: Readonly<Record<string, number>>,
  accounts: ContractRevenueAccounts,
): Array<{ account: string; amount: number }> {
  return positionAccountsOf(accounts)
    .map((account) => ({ account, amount: roundOre((ledger[account] ?? 0) - (register[account] ?? 0)) || 0 }))
    .filter((row) => row.amount !== 0)
}

/** What happened, for the posting port: income from pågående arbeten recognised on balansdagen. */
export function contractRevenueBusinessEvent(args: {
  fiscalPeriodId: string
  periodEnd: string
  amount: number
}): BusinessEventDraft {
  return {
    kind: 'ledger.accrual',
    category: null,
    occurredOn: args.periodEnd,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    ...postingEvidence(linkBasisColumns('user_created')),
    mappingVersion: mappingVersion('contractRevenue'),
    jurisdiction: 'SE',
  }
}

export interface BookContractRevenueArgs {
  supabase: SupabaseClient
  companyId: string
  userId: string
  fiscalPeriodId: string
  /** Balansdagen: the entry's date. */
  periodEnd: string
  method: ContractRevenueMethod
  contracts: readonly ContractInput[]
  accounts: ContractRevenueAccounts
  /** Book nothing while a contract has an open issue (a missing grade or value, an estimate below the incurred costs). */
  refuseWithIssues?: boolean
}

export interface BookContractRevenueResult {
  result: ContractRevenueResult
  /** The posted verifikat, or null when the ledger already held the positions. */
  entry: JournalEntry | null
}

export async function bookContractRevenueAdjustment(args: BookContractRevenueArgs): Promise<BookContractRevenueResult> {
  const { supabase, companyId, fiscalPeriodId } = args
  await assertRevenueAdjustmentAccount(supabase, companyId, args.accounts.revenueAdjustment)
  const balances = await fetchRegisterBalances(supabase, companyId, args.periodEnd)
  const result = computeContractRevenue(args.method, args.contracts, args.accounts, balances)
  if (result.lines.length === 0 || (args.refuseWithIssues && result.issues.length > 0)) return { result, entry: null }

  const amount = result.lines.reduce((sum, line) => sum + line.debit_amount, 0)
  const draft = await postingPort.draftJournalEntry({
    supabase,
    companyId,
    userId: args.userId,
    event: () => contractRevenueBusinessEvent({ fiscalPeriodId, periodEnd: args.periodEnd, amount }),
    input: {
      fiscal_period_id: fiscalPeriodId,
      entry_date: args.periodEnd,
      description: args.method === 'successiv'
        ? `Successiv vinstavräkning pågående arbeten ${args.periodEnd}`
        : `Pågående arbeten enligt färdigställandemetoden ${args.periodEnd}`,
      source_type: 'year_end',
      lines: result.lines,
    },
  })
  // The verifikat and what it was computed from, in one transaction: the
  // uppdrag can be stated anew for the next balansdag, the booking cannot.
  const { entry } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId: args.userId,
    fn: 'commit_contract_revenue',
    args: [
      draft,
      {
        method: args.method,
        accounts: { ...args.accounts },
        contracts: [...args.contracts],
        positions: result.positions,
        targets: result.targets,
      },
    ],
  })
  return { result, entry }
}
