/**
 * The clearing proposers the bank rows' proposals ask (contract:
 * lib/transactions/clearing-proposals.ts), in this order: a hand-written
 * static list, no lazy registration, no lib/init, no event bus. Each lives
 * with the block whose records it reads. The bank row's booking asks the
 * same list for a proposer's booking (a payout's lines), by its id.
 */
import type { ClearingProposer } from '@/lib/transactions/clearing-proposals'
import { posPayoutProposer } from '@/lib/pos-sales/payout-proposals'
import { webshopPayoutProposer } from '@/lib/webshop-orders/payout-proposals'

export const CLEARING_PROPOSERS: readonly ClearingProposer[] = Object.freeze([posPayoutProposer, webshopPayoutProposer])
