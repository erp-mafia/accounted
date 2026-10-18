import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

/**
 * The engine's half of the posting port (lib/posting): the link between a
 * recorded business event and the draft verifikat it produced
 * (business_event_entries, migration 20261016220000). The engine writes it
 * right after the draft header and before commit_journal_entry draws a
 * voucher number; the port writes the event itself before that.
 *
 * Here, beside the engine, rather than in lib/posting: the kernel never
 * imports a feature module (the kernel-import guard), and the port imports
 * the engine, never the other way round.
 */

const log = createLogger('bookkeeping.business-event-link')

/** What a link says the verifikat is to its event (business_event_entries_role_check). */
export type BusinessEventEntryRole = 'produced' | 'reversal' | 'correction'

/**
 * The link an engine call carries when a business event was recorded for it.
 * Built by the port; the engine only writes it.
 */
export interface BusinessEventLink {
  /** The business_events row, already written. */
  id: string
  role: BusinessEventEntryRole
  /**
   * shadow ('log'): a failed link write is logged and the posting goes ahead.
   * strict ('abort'): the draft is cancelled and the posting stops before a
   * voucher number is drawn.
   */
  onFailure: 'log' | 'abort'
}

/**
 * The links a SQL posting function writes itself: bulk_book_transactions,
 * match_batch_allocate, link_invoice_to_voucher,
 * link_supplier_invoice_to_voucher, create_expense_payout_batch and
 * commit_opening_balance_replacement draft and commit their verifikat in one
 * transaction, so the engine cannot link between the two. The port records
 * the events first and the engine door hands this to the function, which
 * links each draft it writes before commit_journal_entry draws the number
 * (public.link_business_events_to_draft, migration 20261018210000). Built by
 * the port; the engine only passes it on (business-event-rpc.ts).
 */
export interface SqlBusinessEventLink {
  /**
   * The recorded events' ids, in the order the function reads them (one per
   * bank line, allocation or claim, or by position); null where an event was
   * not recorded under shadow.
   */
  ids: Array<string | null>
  /**
   * strict: a refused link fails the function before a number is drawn.
   * shadow: it is logged and the posting goes ahead.
   */
  mode: 'shadow' | 'strict'
}

interface DbError {
  code?: string
  message?: string
}

/**
 * The table is not there yet: Postgres 42P01 (undefined_table) or PostgREST
 * PGRST205 (not in the schema cache). Code deployed before the migration
 * treats it as "nothing to record", so the deploy order does not matter.
 */
export function isMissingTableError(error: DbError | null | undefined): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205'
}

export type LinkBusinessEventResult =
  | { ok: true; linked: boolean }
  | { ok: false; message: string; code?: string }

/**
 * Link a recorded event to the draft the engine just inserted. Never throws:
 * the engine decides what a refusal means from the result. A missing table
 * is skipped in either mode (deploy-order safety); any other failure is
 * logged and skipped under 'log', and answered as a refusal under 'abort'.
 */
export async function linkBusinessEventToDraft(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
  link: BusinessEventLink,
): Promise<LinkBusinessEventResult> {
  let error: DbError | null = null
  try {
    const result = await supabase.from('business_event_entries').insert({
      business_event_id: link.id,
      journal_entry_id: journalEntryId,
      company_id: companyId,
      role: link.role,
    })
    error = result.error
  } catch (err) {
    error = { message: err instanceof Error ? err.message : String(err) }
  }
  if (!error) return { ok: true, linked: true }
  if (isMissingTableError(error)) return { ok: true, linked: false }
  if (link.onFailure === 'log') {
    log.warn('business event link not written (shadow); the posting goes ahead without it', {
      companyId,
      entityType: 'journal_entry',
      entityId: journalEntryId,
      businessEventId: link.id,
      pgCode: error.code,
      error: error.message,
    })
    return { ok: true, linked: false }
  }
  return { ok: false, message: error.message ?? 'business event link failed', code: error.code }
}
