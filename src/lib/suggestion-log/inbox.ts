import type { SupabaseClient } from '@supabase/supabase-js'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { traceIdColumn, writeWithTraceId } from '@/lib/observability/trace-column'
import { agentReasonColumn, writeWithAgentReason } from '@/lib/pending-operations/agent-reason'
import { committingAgentReason, committingOperationId } from '@/lib/pending-operations/commit-scope'
import { createLogger } from '@/lib/logger'
import { modelReadingOf, type DocumentReadingRow } from '@/lib/documents/model-reading'
import {
  INBOX_EXTRACTION_RULES_REVISION,
  classifyInboxDecision,
  offeredInboxSuggestions,
  resultAccounts,
  type InboxFields,
  type InboxFinal,
} from './inbox-classify'
import type { BankLineFinal } from './classify'
import type { DecisionCheck } from './checks'
import { inboxInputHash, withProgramVersion } from './provenance'

/**
 * Writes suggestion_log rows for decisions on inbox items (underlag).
 *
 * Two steps around the registration or booking, as for bank lines
 * (./record.ts):
 *   1. snapshotInboxExtraction() before it: the model's ORIGINAL reading.
 *      That is document_attachments.extracted_data until a person corrects
 *      the reading: the correction is mirrored onto the document too, and
 *      the model's reading is kept in document_attachments.model_reading
 *      first (lib/documents/model-reading.ts). The inbox
 *      item's own extracted_data takes the person's edits, so it is the
 *      fallback only for an item whose document carries no model reading. It
 *      also fixes the rules version and the hash of the inputs (the
 *      document's own hash and the suggestion, ./provenance.ts).
 *   2. recordInboxDecision() after it succeeded, with the guards the door
 *      ran and the pending operation whose approval carried it. No approval
 *      policy decides an underlag (every one is registered by a person or an
 *      approved operation, and the reading's score is the model's own), so
 *      policy_version and confidence_band stay null.
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
  /** The rules the suggestion is read with (suggestion_log.rule_version). */
  ruleVersion?: string
  /** SHA-256 of the inputs; null when the document could not be read. */
  inputHash?: string | null
}

function withInputs(snapshot: InboxSnapshot, documentSha256: string | null): InboxSnapshot {
  return {
    ...snapshot,
    ruleVersion: withProgramVersion(INBOX_EXTRACTION_RULES_REVISION),
    inputHash: inboxInputHash({
      documentId: snapshot.documentId,
      documentSha256,
      suggestions: offeredInboxSuggestions({
        extraction: snapshot.extraction,
        model: snapshot.model,
        sourceId: snapshot.documentId ?? snapshot.inboxItemId,
      }),
    }),
  }
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
  if (!snapshot.documentId) return withInputs(snapshot, null)
  try {
    // '*' rather than a column list: a model_reading column a deploy reaches
    // before its migration must not turn every snapshot into a failed read.
    const { data, error } = await supabase
      .from('document_attachments')
      .select('*')
      .eq('id', snapshot.documentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    // 'skipped:<reason>' and 'failed:<reason>' mark a reading that never happened.
    const reading = modelReadingOf(data as DocumentReadingRow | null)
    if (reading) {
      snapshot.extraction = reading.extracted_data
      snapshot.model = reading.extraction_model
    }
    return withInputs(snapshot, (data?.sha256_hash as string | null | undefined) ?? null)
  } catch (err) {
    log.warn('extraction snapshot failed; the inbox item reading is used instead', {
      companyId,
      inboxItemId: item.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // The document's hash is unknown, so the inputs are not fully known either.
  return { ...withInputs(snapshot, null), inputHash: null }
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
  /** The guards the door ran before this decision (./checks.ts); omitted when it does not report them. */
  checks?: DecisionCheck[] | null,
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
    // The approved operation's reason, when an agent staged it with one.
    const { error } = await writeWithTraceId((traceId) => writeWithAgentReason(committingAgentReason(), (agentReason) =>
      supabase.from('suggestion_log').insert({
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
        rule_version: snapshot.ruleVersion ?? null,
        input_hash: snapshot.inputHash ?? null,
        checks: checks ?? null,
        pending_operation_id: committingOperationId(),
        // The request that recorded it (lib/observability/trace-context.ts).
        ...traceIdColumn(traceId),
        ...agentReasonColumn(agentReason),
      }),
    ))
    if (error) throw new Error(error.message)
  } catch (err) {
    log.error('failed to record inbox decision (booking unaffected)', {
      companyId: snapshot.companyId,
      inboxItemId: snapshot.inboxItemId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
