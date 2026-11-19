/**
 * The bank rows' answer to a ledger move (contract:
 * lib/cash-accounts/move-twins.ts). Written out by hand and imported
 * statically by lib/cash-accounts/ledger-change.ts: no lazy loading, no
 * lib/init, no event bus. One answer, the transactions block's
 * (lib/transactions/channel-twins.ts).
 */
import type { LedgerMoveTwins } from '@/lib/cash-accounts/move-twins'
import { applyTwins, prepareMoveTwins } from '@/lib/transactions/channel-twins'

export const LEDGER_MOVE_TWINS: LedgerMoveTwins = Object.freeze<LedgerMoveTwins>({
  module: 'transactions',
  prepare: (supabase, companyId, movingCashAccountId, targetCashAccountIds) =>
    prepareMoveTwins(supabase, companyId, movingCashAccountId, targetCashAccountIds),
  apply: async (supabase, companyId, plan, record) => {
    const done = await applyTwins(
      supabase,
      companyId,
      { setAside: [...plan.setAside], overBookedBuckets: plan.overBookedBuckets },
      { actor: { type: 'user', id: record.actorUserId }, correlationId: record.correlationId, reason: 'ledger_move' },
    )
    return done.length
  },
})
