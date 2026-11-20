/**
 * The clearing proposers the bank rows' proposals ask (contract:
 * lib/transactions/clearing-proposals.ts), in this order: a hand-written
 * static list, no lazy registration, no lib/init, no event bus. Each lives
 * with the block whose records it reads.
 */
import type { ClearingProposer } from '@/lib/transactions/clearing-proposals'
import { posPayoutProposer } from '@/lib/pos-sales/payout-proposals'

export const CLEARING_PROPOSERS: readonly ClearingProposer[] = Object.freeze([posPayoutProposer])
