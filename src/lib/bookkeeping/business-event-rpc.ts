/**
 * Call a SQL posting function with the posting port's event ids.
 *
 * Six functions draft and commit their verifikat in one transaction
 * (bulk_book_transactions, match_batch_allocate, link_invoice_to_voucher,
 * link_supplier_invoice_to_voucher, create_expense_payout_batch,
 * commit_opening_balance_replacement). Since migrations 20261018210100 to
 * 20261018210600 each takes two defaulted parameters, p_event_ids and
 * p_event_mode, and links the events to its drafts before
 * commit_journal_entry draws the number.
 *
 * Without a link (POSTING_EVENTS off, nothing recorded) the function is
 * called with exactly the parameters it had before. With one, the two are
 * added; migrations reach production through a CI job after the merge, so a
 * deploy that arrives first meets the old signature and PostgREST answers
 * PGRST202. That is retried once without the two parameters: the booking
 * goes through unlinked and the events stay recorded, as a missing
 * business_event_entries table is skipped in either mode
 * (business-event-link.ts), so the deploy order does not matter.
 *
 * Isomorphic like actor-rpc.ts: engine.ts imports it.
 */
import { isMissingRpcSignature } from '@/lib/bookkeeping/actor-rpc'
import type { SqlBusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { createLogger } from '@/lib/logger'

const log = createLogger('bookkeeping.business-event-rpc')

/** The two RPC parameters for a link. */
export interface BusinessEventRpcParams {
  p_event_ids: Array<string | null>
  p_event_mode: SqlBusinessEventLink['mode']
}

/** The two parameters for a link, or none without one. */
export function businessEventRpcParams(link: SqlBusinessEventLink | undefined): BusinessEventRpcParams | Record<string, never> {
  if (!link) return {}
  return { p_event_ids: link.ids, p_event_mode: link.mode }
}

/**
 * `call` with the link's two parameters, and once more without them when
 * the database does not have them yet. `call` spreads what it is given into
 * the function's own parameters.
 */
export async function callWithBusinessEvents<R extends { error: { code?: string } | null }>(
  fn: string,
  link: SqlBusinessEventLink | undefined,
  call: (eventParams: BusinessEventRpcParams | Record<string, never>) => PromiseLike<R>,
): Promise<R> {
  if (!link) return call({})
  const first = await call(businessEventRpcParams(link))
  if (!isMissingRpcSignature(first.error)) return first
  log.warn('RPC without the business event parameters yet: retrying without them, the verifikat is not linked to its events', {
    operation: 'business_event_rpc_fallback',
    rpc: fn,
    mode: link.mode,
    pgCode: first.error?.code,
  })
  return call({})
}
