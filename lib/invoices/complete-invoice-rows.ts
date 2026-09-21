/**
 * completeInvoiceRows: the shared TypeScript writer for completed migrated
 * invoices and their behandlingshistorik. Atomic RPCs wrap the original
 * complete_invoice_rows write (migration 20260906135730).
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
 * Failure semantics: every writer commits rows and history in one RPC. A
 * history failure rolls the rows back, and an already-filled invoice gets no
 * duplicate event. The cron additionally persists a receipt under its lease.
 *
 * PII boundary: the payload carries UUIDs, counts, amounts and enum strings
 * only. Invoice numbers and provider document numbers are deliberately left
 * out: a ten-digit number (2026090001) trips the personnummer guard in
 * appendProcessingHistory, which would lose the event for exactly that
 * invoice. The invoice id is the reference; its number is on the row.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProcessingHistoryActor } from '@/types'
import {
  prepareProcessingHistoryRow,
  type AppendEventInput,
  type ProcessingHistoryEventType,
} from '@/lib/processing-history/append'
import { queryInExecutionBudget } from '@/lib/http/execution-budget'

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
  /** A fenced cron lease enables atomic history and a durable completion receipt. */
  completionWorkerId?: string
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
   * Retained for existing callers. History is now written inside the RPC,
   * with the same caller authorization as the invoice write.
   */
  historyClient?: HistoryClient
}

export type CompleteInvoiceRowsResult =
  /** The rows, optional header and history event landed together. */
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
  event_id?: string
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
  if (input.completionWorkerId) {
    const { data, error } = await queryInExecutionBudget(supabase.rpc('finish_invoice_completion', {
      p_company_id: input.companyId,
      p_worker_id: input.completionWorkerId,
      p_invoice_id: input.invoiceId,
      p_outcome: 'written',
      p_rows: input.rows,
      p_header: header,
      p_event: prepareProcessingHistoryRow(completedEvent(input, input.rows.length, header !== null)),
    }))
    if (error) throw new Error(`Completion receipt not confirmed: ${error.message}`)
    return data as CompleteInvoiceRowsResult
  }
  const { data, error } = await queryInExecutionBudget(supabase.rpc('complete_invoice_rows_with_history', {
    p_company_id: input.companyId,
    p_invoice_id: input.invoiceId,
    p_rows: input.rows,
    p_header: header,
    p_event: prepareProcessingHistoryRow(completedEvent(input, input.rows.length, header !== null)),
  }))
  const outcome = (data ?? null) as CompleteRowsRpcOutcome | null
  if (error || !outcome?.ok) {
    return { status: 'failed', reason: error?.message ?? outcome?.code ?? 'empty RPC response' }
  }
  if (!outcome.wrote) return { status: 'already_filled' }

  const rows = outcome.rows ?? input.rows.length
  const headerUpdated = outcome.header_updated === true
  return { status: 'written', rows, headerUpdated, eventId: outcome.event_id ?? null }
}

function completedEvent(input: CompleteInvoiceRowsInput, rows: number, headerUpdated: boolean): AppendEventInput {
  const { trail } = input
  return {
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
  }
}
