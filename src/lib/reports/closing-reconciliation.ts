/**
 * Closing reconciliation: the ledger's question to the bank side, "what did
 * the reconciliation of each account hold at the balansdag?".
 *
 * The bokslutsbilagor (the pärm for one räkenskapsår) print, per account
 * the reconciliation rail lists, the balances it was reconciled on, the
 * system specification of the outside side and the underlag attached to its
 * sign-offs, so the pärm shows exactly what the Avstämning page showed. All
 * of that is the bank transactions block's (lib/reconciliation). This file
 * is the ledger's side of the contract and imports nothing at runtime; the
 * implementation is wired in lib/composition/closing-reconciliation.ts,
 * which the ledger imports statically (no lib/init, no event bus).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import type { ListAccountsOptions } from '@/lib/reconciliation/service'
import type {
  BalanceSheetSnapshot,
  SpecificationAmounts,
  SpecificationProvider,
} from '@/lib/reconciliation/manual-reconciliation'
import type { AttachmentRow, ListAttachmentsOptions } from '@/lib/reconciliation/attachments-store'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'

export interface ClosingReconciliation {
  /** The module that owns the code behind the answers (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /** Every account the reconciliation rail lists (bank, skattekonto, manual), with its state. */
  listAccounts(supabase: SupabaseClient, companyId: string, options?: ListAccountsOptions): Promise<ReconciliationAccount[]>
  /** Class 1-2 balances through the date, from the fiscal period that contains it; null when none does. */
  balanceSheetSnapshot(supabase: SupabaseClient, companyId: string, asOfDate: string): Promise<BalanceSheetSnapshot | null>
  /** The system specification of each provider account (the reskontra tie-outs, the vacation liability). */
  specificationAmounts(
    supabase: SupabaseClient,
    companyId: string,
    snapshot: BalanceSheetSnapshot,
    onlyAccounts?: ReadonlySet<string>,
  ): Promise<SpecificationAmounts>
  /** The accounts that have a system specification, by account number. */
  readonly specificationProviders: Readonly<Record<string, SpecificationProvider>>
  /** Every attached file with a balansdag inside [from, to]. */
  attachmentRowsInRange(
    supabase: SupabaseClient,
    companyId: string,
    from: string,
    to: string,
    options?: ListAttachmentsOptions,
  ): Promise<AttachmentRow[]>
}
