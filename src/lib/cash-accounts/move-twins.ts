import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * What a bank ledger move asks of the bank rows (crm#1701): a move can put a
 * connected account's feed rows and a statement-file account's rows of the
 * same bank account on one account, and no import ever compared the two, so
 * every movement would read twice. Before the save, while the accounts are
 * still apart, `prepare` plans the copies between the moving account and the
 * accounts on the ledger account it moves to; after the save, `apply` sets
 * aside those that now sit on one account with their twin.
 *
 * The answer lives with the bank rows (lib/transactions/channel-twins.ts)
 * and is plugged in through lib/composition/ledger-move-twins.ts, so the
 * ledger never imports the transactions block.
 */
export interface LedgerMoveTwinsPlan {
  readonly setAside: ReadonlyArray<{ transaction_id: string; twin_transaction_id: string }>
  readonly overBookedBuckets: number
}

export interface LedgerMoveTwins {
  module: 'transactions'
  /** Read only: the copies between the moving account and the target accounts. */
  prepare(
    supabase: SupabaseClient,
    companyId: string,
    movingCashAccountId: string,
    targetCashAccountIds: readonly string[],
  ): Promise<LedgerMoveTwinsPlan>
  /** Sets aside the planned copies now on one account; answers how many. */
  apply(
    supabase: SupabaseClient,
    companyId: string,
    plan: LedgerMoveTwinsPlan,
    record: { actorUserId: string; correlationId: string },
  ): Promise<number>
}
