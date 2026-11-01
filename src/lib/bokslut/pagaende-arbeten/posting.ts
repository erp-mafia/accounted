import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingEvidence } from '@/lib/core/bookkeeping/year-end-business-events'
import type { JournalEntry } from '@/types'
import {
  computeContractRevenue,
  type ContractInput,
  type ContractRevenueAccounts,
  type ContractRevenueMethod,
  type ContractRevenueResult,
} from './calculator'

/**
 * Books the pågående-arbeten adjustment on balansdagen through the posting
 * port: the engine draws the voucher number, the period lock and the
 * balance trigger apply as to every verifikat. The adjustment is the
 * difference between the positions computeContractRevenue derives and what
 * the position accounts already hold, so running it twice books nothing the
 * second time; a change in an estimate books only the change (K3 23.21).
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

/** The position accounts' balances on balansdagen (debit positive), every posted entry included. */
export async function fetchPositionBalances(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  accounts: ContractRevenueAccounts,
): Promise<Record<string, number>> {
  const positionAccounts = new Set([
    accounts.accruedRevenue, accounts.billedInAdvance, accounts.lossProvision, accounts.wipCosts, accounts.wipBilling,
  ])
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' })
  const balances: Record<string, number> = {}
  for (const row of rows) {
    if (!positionAccounts.has(row.account_number)) continue
    balances[row.account_number] = (row.closing_debit || 0) - (row.closing_credit || 0)
  }
  return balances
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
  const balances = await fetchPositionBalances(supabase, companyId, fiscalPeriodId, args.accounts)
  const result = computeContractRevenue(args.method, args.contracts, args.accounts, balances)
  if (result.lines.length === 0 || (args.refuseWithIssues && result.issues.length > 0)) return { result, entry: null }

  const amount = result.lines.reduce((sum, line) => sum + line.debit_amount, 0)
  const entry = await postingPort.postJournalEntry({
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
  return { result, entry }
}
