import type { SupabaseClient } from '@supabase/supabase-js'
import type { reverseEntry } from '@/lib/bookkeeping/engine'
import { voucherStornoBusinessEvent } from '@/lib/bookkeeping/ledger-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { createLogger } from '@/lib/logger'
import { normalizeCollectedPaymentRow, type CollectedPaymentRow } from './collected-payment-record'
import {
  bookCollectedPayment,
  COLLECTED_BOOKING_LEASE_MS,
  type BookCollectedPaymentResult,
  type CollectedPaymentBookingDeps,
} from './collected-payments'

/**
 * The collections rebook ("Bokför om", build spec 3.9 and 4.2): correct a
 * booked payment the collections provider collected (step C). The generic
 * storno of its voucher is refused (reverseEntry,
 * CANNOT_REVERSE_COLLECTED_PAYMENT) and its payment row cannot be deleted
 * (block_delete_collected_payment), so this is the one path:
 *
 *   1. claim the collected payment (its booking lease);
 *   2. storno the C voucher through reverseEntry with the rebook option: the
 *      voucher is reversed (särskild rättelsepost, BFL 5 kap 5 §), the
 *      invoice reopened, and the collections payment row left in place;
 *   3. collections_rebook_release: in one transaction, inside the
 *      gnubok.collections_rebook window and only for a voucher a posted
 *      storno reversed, delete that payment row and put the collected
 *      payment back to pending (remembering the reversed voucher);
 *   4. book it again (bookCollectedPayment), with a new payment record.
 *
 * A payment booked as återvunnen kundförlust (a written-off invoice, see
 * collected-payments.ts) takes the same path: the storno of its customer_loss
 * voucher annuls the recovery decision (lib/customer-loss/reversal.ts) and
 * the invoice stays written off; step 3 has no payment row to delete, so it
 * is one guarded update (releaseRecovery); step 4 books the recovery again.
 *
 * Safe to run again after a crash: a voucher already reversed skips step 2,
 * and a payment already released (pending, with a reversed voucher behind
 * it) is booked. A payment a booked payout already settled is refused: the
 * payout voucher is reversed first, which unties it (settlement-reversal.ts).
 * Always a person's click, never automatic.
 */

const log = createLogger('collections/rebook')

export interface RebookDeps extends CollectedPaymentBookingDeps {
  /** reverseEntry's call, replaceable in tests; reverseThroughPort by default. */
  reverse?: typeof reverseEntry
}

/**
 * The rebook's storno with reverseEntry's own arguments, through the posting
 * port (lib/posting): the engine gets the same call, collectionsRebook
 * included, and while POSTING_EVENTS is on the storno's event (a person
 * asked for the rebook) is recorded and linked first.
 */
const reverseThroughPort: typeof reverseEntry = (supabase, companyId, userId, entryId, reversalDate, options) =>
  postingPort.reverseJournalEntry({
    supabase,
    companyId,
    userId,
    entryId,
    reversalDate,
    options: options?.collectionsRebook ? { collectionsRebook: true } : undefined,
    event: () => voucherStornoBusinessEvent({ entryId, occurredOn: todayIsoStockholm(), linkBasis: linkBasisColumns('user_created') }),
    role: 'reversal',
  })

export type RebookCollectedPaymentResult =
  | { ok: true; reversedEntryId: string; stornoEntryId: string | null; booking: BookCollectedPaymentResult }
  | { ok: false; outcome: 'not_found' | 'not_booked' | 'settled' | 'busy' | 'voucher_not_posted' }

/**
 * Step 3 for a payment booked as a recovery: only for a voucher a posted
 * storno reversed, put the payment back to pending, remembering the reversed
 * voucher. Nothing to delete: the decision rows are append-only and the
 * annulment already stands beside the recovery.
 */
async function releaseRecovery(db: SupabaseClient, row: CollectedPaymentRow, entryId: string, stornoEntryId: string | null): Promise<void> {
  const { data: storno, error: stornoError } = stornoEntryId
    ? await db.from('journal_entries').select('status').eq('company_id', row.company_id).eq('id', stornoEntryId).maybeSingle()
    : { data: null, error: null }
  if (stornoError) throw new Error(`journal_entries lookup failed: ${stornoError.message}`)
  if ((storno as { status?: string } | null)?.status !== 'posted') {
    throw new Error('collections rebook: the recovery voucher must be reversed by a posted storno first')
  }
  const { data: released, error } = await db
    .from('collection_collected_payments')
    .update({
      status: 'pending',
      write_off_id: null,
      journal_entry_id: null,
      payment_record_document_id: null,
      booked_by: null,
      booked_at: null,
      review_reason: null,
      booking_lease_until: null,
      rebooked_entry_ids: [...row.rebooked_entry_ids, entryId],
    })
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .eq('status', 'booked')
    .eq('journal_entry_id', entryId)
    .is('settlement_id', null)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`collection_collected_payments update failed: ${error.message}`)
  if (!released) throw new Error('collections rebook: the collected payment changed under the rebook')
}

async function loadRow(db: SupabaseClient, companyId: string, id: string): Promise<CollectedPaymentRow | null> {
  const { data, error } = await db
    .from('collection_collected_payments')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`collection_collected_payments lookup failed: ${error.message}`)
  return data ? normalizeCollectedPaymentRow(data as Record<string, unknown>) : null
}

export async function rebookCollectedPayment(
  deps: RebookDeps,
  collectedPaymentId: string,
  actor: { userId: string },
): Promise<RebookCollectedPaymentResult> {
  const { db, companyId } = deps
  const logger = deps.log ?? log
  const now = deps.now ? deps.now() : new Date()
  const row = await loadRow(db, companyId, collectedPaymentId)
  if (!row) return { ok: false, outcome: 'not_found' }

  // A rebook that died after the release: the payment waits to be booked again.
  const rebooked = row.rebooked_entry_ids
  if ((row.status === 'pending' || row.status === 'needs_review') && rebooked.length > 0) {
    const booking = await bookCollectedPayment(deps, row.id, actor)
    return { ok: true, reversedEntryId: rebooked[rebooked.length - 1]!, stornoEntryId: null, booking }
  }
  if (row.status !== 'booked' || !row.journal_entry_id) return { ok: false, outcome: 'not_booked' }
  if (row.settlement_id) return { ok: false, outcome: 'settled' }
  const entryId = row.journal_entry_id

  const nowIso = now.toISOString()
  const leaseUntil = new Date(now.getTime() + COLLECTED_BOOKING_LEASE_MS).toISOString()
  // A free lease was never taken or has run out: two conditional updates with
  // literal filters (the schema guard checks every column), the run-out one
  // only when no never-taken lease was there to claim.
  const claim = (runOut: boolean) => {
    let query = db
      .from('collection_collected_payments')
      .update({ booking_lease_until: leaseUntil })
      .eq('company_id', companyId)
      .eq('id', row.id)
      .eq('status', 'booked')
      .is('settlement_id', null)
    query = runOut ? query.lt('booking_lease_until', nowIso) : query.is('booking_lease_until', null)
    return query.select('id').maybeSingle()
  }
  let { data: claimed, error: claimError } = await claim(false)
  if (!claimError && !claimed) ({ data: claimed, error: claimError } = await claim(true))
  if (claimError) throw new Error(`collection_collected_payments claim failed: ${claimError.message}`)
  if (!claimed) return { ok: false, outcome: 'busy' }

  const releaseLease = async () => {
    const { error } = await db
      .from('collection_collected_payments')
      .update({ booking_lease_until: null })
      .eq('company_id', companyId)
      .eq('id', row.id)
    if (error) throw new Error(`collection_collected_payments update failed: ${error.message}`)
  }

  let stornoEntryId: string | null = null
  try {
    const { data: entry, error: entryError } = await db
      .from('journal_entries')
      .select('id, status, reversed_by_id')
      .eq('company_id', companyId)
      .eq('id', entryId)
      .maybeSingle()
    if (entryError) throw new Error(`journal_entries lookup failed: ${entryError.message}`)
    const status = (entry as { status?: string } | null)?.status
    if (status === 'posted') {
      // A refusal (a locked period, a closed year) changes nothing and reaches the caller as it is.
      const storno = await (deps.reverse ?? reverseThroughPort)(db, companyId, actor.userId, entryId, undefined, { collectionsRebook: true })
      stornoEntryId = storno.id
    } else if (status === 'reversed') {
      // A rebook that died after the storno.
      stornoEntryId = (entry as { reversed_by_id?: string | null }).reversed_by_id ?? null
    } else {
      await releaseLease()
      return { ok: false, outcome: 'voucher_not_posted' }
    }

    if (row.write_off_id) {
      await releaseRecovery(db, row, entryId, stornoEntryId)
    } else {
      const { error: releaseError } = await db.rpc('collections_rebook_release', {
        p_company_id: companyId,
        p_collected_payment_id: row.id,
      })
      if (releaseError) throw new Error(`collections_rebook_release failed: ${releaseError.message}`)
    }
  } catch (error) {
    await releaseLease().catch(() => undefined)
    throw error
  }
  logger.info('collected payment released for rebooking', { collectedPaymentId: row.id, reversedEntryId: entryId, stornoEntryId })

  const booking = await bookCollectedPayment(deps, row.id, actor)
  return { ok: true, reversedEntryId: entryId, stornoEntryId, booking }
}
