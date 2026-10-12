import type { SupabaseClient } from '@supabase/supabase-js'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { createLogger } from '@/lib/logger'
import { classifyInboxDecision, resultAccounts, type InboxFields, type InboxFinal } from './inbox-classify'
import type { BankLineFinal } from './classify'

/**
 * Writes suggestion_log rows for decisions on inbox items (underlag).
 *
 * Two steps around the registration or booking, as for bank lines
 * (./record.ts):
 *   1. snapshotInboxExtraction() before it: the model's ORIGINAL reading.
 *      That is document_attachments.extracted_data, which only the model
 *      writes (the inbox mirrors each extraction onto the document); the
 *      inbox item's own extracted_data takes the person's edits, so it is
 *      the fallback only for an item whose document carries no reading.
 *   2. recordInboxDecision() after it succeeded.
 *
 * Neither step can fail the booking: errors are logged and dropped.
 *
 * A deleted item is recorded against its document only: the row's
 * inbox_item_id would cascade it away with the item it describes.
 */

const log = createLogger('suggestion-log/inbox')

export interface InboxSnapshot {
  companyId: string
  inboxItemId: string
  documentId: string | null
  extraction: unknown | null
  model: string | null
}

export async function snapshotInboxExtraction(
  supabase: SupabaseClient,
  companyId: string,
  item: { id: string; document_id?: string | null; extracted_data?: unknown },
): Promise<InboxSnapshot> {
  const snapshot: InboxSnapshot = {
    companyId,
    inboxItemId: item.id,
    documentId: item.document_id ?? null,
    extraction: item.extracted_data ?? null,
    model: null,
  }
  if (!snapshot.documentId) return snapshot
  try {
    const { data, error } = await supabase
      .from('document_attachments')
      .select('extracted_data, extraction_model')
      .eq('id', snapshot.documentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const model = (data?.extraction_model as string | null | undefined) ?? null
    // 'skipped:<reason>' and 'failed:<reason>' mark a reading that never happened.
    if (data?.extracted_data && model && !/^(skipped|failed):/.test(model)) {
      snapshot.extraction = data.extracted_data
      snapshot.model = model
    }
  } catch (err) {
    log.warn('extraction snapshot failed; the inbox item reading is used instead', {
      companyId,
      inboxItemId: item.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return snapshot
}

/** The posted lines of a verifikat, for doors that do not have them at hand. */
export async function loadEntryLines(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string | null,
): Promise<BankLineFinal['lines']> {
  if (!journalEntryId) return []
  try {
    // Through the entry, so the company scope is checked on the row that has it.
    const { data, error } = await supabase
      .from('journal_entries')
      .select('lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
      .eq('id', journalEntryId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const lines = ((data as { lines?: unknown } | null)?.lines ?? []) as Array<{
      account_number: string
      debit_amount: number
      credit_amount: number
    }>
    return lines.map((l) => ({
      account: l.account_number,
      debit: Number(l.debit_amount),
      credit: Number(l.credit_amount),
    }))
  } catch (err) {
    log.warn('could not read the booked lines for the decision', {
      companyId,
      journalEntryId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

export interface InboxBooking {
  supplier_invoice_id?: string | null
  journal_entry_id?: string | null
  /** The compared fields as registered; accounts default to the lines' result accounts. */
  fields: InboxFields
  lines?: BankLineFinal['lines']
}

export async function recordInboxDecision(
  supabase: SupabaseClient,
  snapshot: InboxSnapshot,
  booking: InboxBooking | null,
  userId: string | null,
): Promise<void> {
  try {
    if (!booking && !snapshot.documentId) return
    const lines = booking?.lines ?? []
    const booked: Omit<InboxFinal, 'changed_fields'> | null = booking
      ? {
          supplier_invoice_id: booking.supplier_invoice_id ?? null,
          journal_entry_id: booking.journal_entry_id ?? null,
          fields: {
            ...booking.fields,
            // Unknown lines leave the accounts uncompared rather than "none booked".
            accounts: booking.fields.accounts ?? (lines.length > 0 ? resultAccounts(lines.map((l) => l.account)) : undefined),
          },
          lines,
        }
      : null
    const classified = classifyInboxDecision({
      extraction: snapshot.extraction,
      model: snapshot.model,
      sourceId: snapshot.documentId ?? snapshot.inboxItemId,
      booked,
    })
    const { error } = await supabase.from('suggestion_log').insert({
      company_id: snapshot.companyId,
      kind: 'inbox_item',
      inbox_item_id: booking ? snapshot.inboxItemId : null,
      document_id: snapshot.documentId,
      suggestions: classified.suggestions,
      acted_on: classified.acted_on,
      final: classified.final,
      outcome: classified.outcome,
      actor_type: getActor()?.type ?? 'user',
      resolved_by: userId,
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    log.error('failed to record inbox decision (booking unaffected)', {
      companyId: snapshot.companyId,
      inboxItemId: snapshot.inboxItemId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
