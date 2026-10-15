/**
 * The one compare-and-set every door uses to settle an inbox item (Underlag)
 * on a verifikat (accounted#14).
 *
 * created_journal_entry_id is the item's "booked" mark. A booking door reads
 * it, posts a verifikat and then writes it. Read-then-write alone lets two
 * concurrent calls for the same item (a double click, a retry, an agent and a
 * person at once) both pass the read and both post a verifikat. No constraint
 * catches that: the race is two UPDATEs of the same row, and several items
 * may legitimately back one verifikat (migration 20260911120500 dropped the
 * UNIQUE for that reason). The guard is the predicate on the write itself:
 * the stamp lands only while the pointer still holds the value the door read
 * (NULL, or a stale pointer at a reversed verifikat the door may replace) and
 * no supplier invoice has claimed the item, so exactly one caller wins.
 *
 * The engine assigns the voucher number when it posts, so the claim can only
 * run after the verifikat exists. A door that loses takes its own verifikat
 * back out of the books through the storno service, the compensation the
 * bank row got in !128 (reverseOrphanedJournalEntry); it never edits or
 * deletes it. The document link and any other follow-up must run after a won
 * claim, never before, or a loser would move the underlag onto its reversed
 * verifikat.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { createLogger } from '@/lib/logger'

const log = createLogger('documents/inbox-item-claim')

/** Gap note used only when the storno itself fails after its number was allocated. */
const LOSER_GAP_EXPLANATION =
  'Verifikation för ett underlag som redan var bokfört; automatisk storno misslyckades. Manuell avstämning krävs.'

/** Verifikat statuses that no longer book anything: a pointer at one is stale. */
const SPENT_ENTRY_STATUSES = new Set(['reversed', 'cancelled'])

export type InboxItemClaim =
  | { status: 'claimed' }
  /** Another verifikat or a supplier invoice holds the item. */
  | { status: 'taken' }
  /** The write errored; it may or may not have landed. */
  | { status: 'failed'; error: { message: string; code?: string } }

export interface ClaimOptions {
  /**
   * The pointer value the door read and may replace: NULL (the default), or
   * a stale pointer at a reversed verifikat. The write lands only while the
   * row still holds exactly this value.
   */
  expected?: string | null
  /** Columns that belong to the same terminal write (the bank row book-direct settled). */
  also?: { matched_transaction_id?: string | null }
  /**
   * Stamp even when a supplier invoice holds the item. Only for a door that
   * posts nothing itself (the v1 stamp of an existing verifikat), which has
   * always allowed it; a booking door never sets this.
   */
  ignoreSupplierInvoice?: boolean
}

/**
 * Stamp `journalEntryId` on the item when, and only when, its pointer still
 * holds `expected` and no supplier invoice has claimed it.
 */
export async function claimInboxItemForEntry(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
  journalEntryId: string,
  options: ClaimOptions = {},
): Promise<InboxItemClaim> {
  const expected = options.expected ?? null
  const base = supabase
    .from('invoice_inbox_items')
    // A literal payload (no spread) so the column guard checks both columns; an
    // absent matched_transaction_id is undefined and drops out of the JSON body.
    .update({ created_journal_entry_id: journalEntryId, matched_transaction_id: options.also?.matched_transaction_id })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
  const guarded = expected === null
    ? base.is('created_journal_entry_id', null)
    : base.eq('created_journal_entry_id', expected)
  const { data, error } = await (
    options.ignoreSupplierInvoice ? guarded : guarded.is('created_supplier_invoice_id', null)
  ).select('id')
  if (error) return { status: 'failed', error }
  return data && data.length > 0 ? { status: 'claimed' } : { status: 'taken' }
}

/**
 * Undo a claim that may have landed, keyed on this verifikat's own id so a
 * winner's stamp is never touched, restoring the value the door replaced.
 * Used after an errored claim write: the UPDATE can commit before the
 * connection drops, and an item left pointing at a verifikat that is about to
 * be reversed would read as booked for good. Never throws; a failure is
 * logged with what an operator needs.
 */
export async function releaseInboxItemClaim(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
  journalEntryId: string,
  restoreTo: string | null = null,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('invoice_inbox_items')
      .update({ created_journal_entry_id: restoreTo })
      .eq('id', inboxItemId)
      .eq('company_id', companyId)
      .eq('created_journal_entry_id', journalEntryId)
    if (error) {
      log.error('failed to release inbox item claim (item may point at a reversed verifikat)', error, {
        companyId,
        inboxItemId,
        journalEntryId,
      })
    }
  } catch (err) {
    log.error('unexpected failure releasing inbox item claim', err as Error, {
      companyId,
      inboxItemId,
      journalEntryId,
    })
  }
}

/**
 * For a door that has just posted `journalEntryId` for the item: claim it,
 * and when the claim does not land, reverse that verifikat (storno) so the
 * books hold one booking of the underlag. The caller answers 409 on 'taken'
 * and an error on 'failed'; both leave nothing of this call in effect.
 */
export async function claimInboxItemOrReverseEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  inboxItemId: string,
  journalEntryId: string,
  options: ClaimOptions = {},
): Promise<InboxItemClaim> {
  const claim = await claimInboxItemForEntry(supabase, companyId, inboxItemId, journalEntryId, options)
  if (claim.status === 'claimed') return claim
  if (claim.status === 'failed') {
    await releaseInboxItemClaim(supabase, companyId, inboxItemId, journalEntryId, options.expected ?? null)
  }
  log.warn('inbox item claim lost; reversing the verifikat posted for it', {
    companyId,
    inboxItemId,
    journalEntryId,
    outcome: claim.status,
  })
  await reverseOrphanedJournalEntry(supabase, companyId, userId, journalEntryId, LOSER_GAP_EXPLANATION)
  return claim
}

export type InboxItemBookingState =
  | { state: 'missing' }
  /** Bookable. `replaces` is a stale pointer at a reversed verifikat, or null. */
  | { state: 'open'; replaces: string | null }
  | { state: 'booked'; journal_entry_id: string | null; supplier_invoice_id: string | null }
  | { state: 'error'; error: { message: string } }

/**
 * Whether the item may be booked, read before posting. Booked means a
 * supplier invoice holds it, or its pointer names a verifikat that still
 * books it (anything but reversed or cancelled). A pointer at a reversed
 * verifikat is stale: the door may replace exactly that value, as a bank row
 * whose pointer names a reversed verifikat may be booked again (!128).
 */
export async function readInboxItemBookingState(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
): Promise<InboxItemBookingState> {
  const { data: item, error } = await supabase
    .from('invoice_inbox_items')
    .select('created_journal_entry_id, created_supplier_invoice_id')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { state: 'error', error }
  if (!item) return { state: 'missing' }
  const pointer = (item.created_journal_entry_id as string | null) ?? null
  const supplierInvoiceId = (item.created_supplier_invoice_id as string | null) ?? null
  if (supplierInvoiceId) {
    return { state: 'booked', journal_entry_id: pointer, supplier_invoice_id: supplierInvoiceId }
  }
  if (!pointer) return { state: 'open', replaces: null }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('status')
    .eq('id', pointer)
    .eq('company_id', companyId)
    .maybeSingle()
  if (entryError) return { state: 'error', error: entryError }
  const status = (entry?.status as string | undefined) ?? null
  if (status && SPENT_ENTRY_STATUSES.has(status)) return { state: 'open', replaces: pointer }
  return { state: 'booked', journal_entry_id: pointer, supplier_invoice_id: null }
}
