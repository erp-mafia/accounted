/**
 * completeInvoiceRows: the one TypeScript call site for the
 * complete_invoice_rows RPC (migration 20260906135730), and the one place the
 * behandlingshistorik event for a completed migrated invoice is written.
 *
 * Two writers put rows under migrated sales invoices: the migration wizard
 * (extensions/general/arcim-migration/lib/migration-orchestrator.ts, rows
 * written milliseconds after the header) and the hourly row-completion pass
 * (complete-invoice-lines.ts, the rows the wizard's hydration budget did not
 * reach, plus the header VAT split when the stored one held no evidence).
 * The RPC already gives them one write path; this wrapper gives them one
 * trail. Every invoice whose rows the RPC wrote gets one InvoiceRowsCompleted
 * event (BFL 5 kap 11 §, BFNAR 2013:2 p. 9.16: the behandlingshistorik has to
 * say what was processed automatically, when, and by what) naming the writer,
 * the provider the rows came from, the row count and, when the header split
 * was rewritten, the split before and after. The pass writes no
 * bokföringspost, so BFL 5 kap 5 § (rättelse) does not bind it; the migration
 * that wrote the invoice header records no event of its own, so this event
 * is what lets the two writers reconcile per invoice.
 *
 * Failure semantics: the event is written only after the RPC has answered
 * wrote = true, so an invoice whose completion failed, or that another writer
 * had already filled, gets no event. The append itself is best-effort, the
 * convention every processing_history writer follows (the rows are
 * committed; a missing change-log row is logged, not turned into a failed
 * invoice that the next run would try again and find full). The caller sees
 * a null eventId when that happened.
 *
 * PII boundary: the payload carries UUIDs, counts, amounts and enum strings
 * only. Invoice numbers and provider document numbers are deliberately left
 * out: a ten-digit number (2026090001) trips the personnummer guard in
 * appendProcessingHistory, which would lose the event for exactly that
 * invoice. The invoice id is the reference; its number is on the row.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProcessingHistoryActor } from '@/types'
import { createLogger } from '@/lib/logger'
import {
  appendProcessingHistoryWithClient,
  type ProcessingHistoryEventType,
} from '@/lib/processing-history/append'

const log = createLogger('invoices/complete-invoice-rows')

/** Registered in processing_event_types by migration 20260906210100. */
export const INVOICE_ROWS_COMPLETED_EVENT = 'InvoiceRowsCompleted' satisfies ProcessingHistoryEventType

type RpcClient = Pick<SupabaseClient, 'rpc'>
type HistoryClient = Pick<SupabaseClient, 'from'>

/** The six invoice columns the RPC may rewrite: all present or none. */
export interface InvoiceHeaderVatSplit {
  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  vat_rate: number | null
  vat_treatment: string
}

/**
 * What the trail records of a header split. The SEK twins are left out:
 * they are derived from these and the exchange rate the row already carries.
 */
export interface InvoiceHeaderVatSnapshot {
  subtotal: number | null
  vat_amount: number | null
  vat_rate: number | null
  vat_treatment: string | null
}

export interface CompleteInvoiceRowsTrail {
  /** Which writer: 'migration-wizard' or 'complete-invoice-lines'. */
  source: string
  /** The provider the rows came from ('fortnox', 'briox', ...). */
  provider: string
  /** The provider consent the rows were fetched under. */
  consentId: string
  /** One id per run, shared by every invoice the run completed. */
  correlationId: string
  actor: ProcessingHistoryActor
}

export interface CompleteInvoiceRowsInput {
  companyId: string
  invoiceId: string
  /** The invoice_items columns per row; the RPC stamps invoice_id itself. */
  rows: Record<string, unknown>[]
  /** The header split to apply in the same transaction, or null to leave the header alone. */
  header?: InvoiceHeaderVatSplit | null
  /** The stored split before the write; recorded beside the new one when the header is rewritten. */
  headerBefore?: InvoiceHeaderVatSnapshot | null
  trail: CompleteInvoiceRowsTrail
  /**
   * The client the event row is written with. processing_history has no
   * INSERT policy, so this must be a service-role client: the cron's own
   * client already is, the wizard (on the user's session client) passes one.
   */
  historyClient: HistoryClient
}

export type CompleteInvoiceRowsResult =
  /** The rows (and the header, when one was given) landed; eventId is null when the trail append failed. */
  | { status: 'written'; rows: number; headerUpdated: boolean; eventId: string | null }
  /** Another writer filled the invoice first; nothing was written and nothing is recorded. */
  | { status: 'already_filled' }
  /** The RPC errored or refused (its code, or the Postgres message). */
  | { status: 'failed'; reason: string }

/** What complete_invoice_rows returns (migration 20260906135730). */
interface CompleteRowsRpcOutcome {
  ok: boolean
  code?: string
  wrote?: boolean
  rows?: number
  header_updated?: boolean
}

function snapshotOf(split: InvoiceHeaderVatSnapshot | InvoiceHeaderVatSplit | null | undefined): InvoiceHeaderVatSnapshot | null {
  if (!split) return null
  return {
    subtotal: split.subtotal,
    vat_amount: split.vat_amount,
    vat_rate: split.vat_rate,
    vat_treatment: split.vat_treatment,
  }
}

export async function completeInvoiceRows(
  supabase: RpcClient,
  input: CompleteInvoiceRowsInput,
): Promise<CompleteInvoiceRowsResult> {
  const header = input.header ?? null
  const { data, error } = await supabase.rpc('complete_invoice_rows', {
    p_company_id: input.companyId,
    p_invoice_id: input.invoiceId,
    p_rows: input.rows,
    p_header: header,
  })
  const outcome = (data ?? null) as CompleteRowsRpcOutcome | null
  if (error || !outcome?.ok) {
    return { status: 'failed', reason: error?.message ?? outcome?.code ?? 'empty RPC response' }
  }
  if (!outcome.wrote) return { status: 'already_filled' }

  const rows = outcome.rows ?? input.rows.length
  const headerUpdated = outcome.header_updated === true
  const eventId = await appendCompletedEvent(input, rows, headerUpdated)
  return { status: 'written', rows, headerUpdated, eventId }
}

async function appendCompletedEvent(
  input: CompleteInvoiceRowsInput,
  rows: number,
  headerUpdated: boolean,
): Promise<string | null> {
  const { trail } = input
  try {
    return await appendProcessingHistoryWithClient(input.historyClient, {
      companyId: input.companyId,
      correlationId: trail.correlationId,
      aggregateType: 'Invoice',
      aggregateId: input.invoiceId,
      eventType: INVOICE_ROWS_COMPLETED_EVENT,
      payload: {
        source: trail.source,
        provider: trail.provider,
        consent_id: trail.consentId,
        rows,
        header_updated: headerUpdated,
        header_before: headerUpdated ? snapshotOf(input.headerBefore) : null,
        header_after: headerUpdated ? snapshotOf(input.header) : null,
      },
      actor: trail.actor,
      occurredAt: new Date(),
    })
  } catch (err) {
    // The rows are committed; the trail row is what is missing. Logged so
    // the gap is visible, never a reason to report the invoice as failed.
    log.error('InvoiceRowsCompleted append failed; rows written without their behandlingshistorik row', {
      companyId: input.companyId,
      invoiceId: input.invoiceId,
      source: trail.source,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
