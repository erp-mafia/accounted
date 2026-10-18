/**
 * The arrival of one raw bank feed page.
 *
 * Both bank syncs (Enable Banking, extensions/general/enable-banking/lib/
 * sync.ts, and Open Payments, ./sync.ts) archive every page the bank
 * answered as a document (psd2-response_*.json) before anything is booked
 * from it. That document is the page exactly as it came, so the arrival
 * points at its bytes instead of storing them twice, and links it. The
 * reference is the document id: each sync archives its pages afresh, and a
 * second recording of the same page is the same arrival.
 *
 * No arrival_outputs per row: every row ingested from the page carries
 * raw_document_id, the page's document, which this arrival links.
 *
 * Best effort: never throws, never fails the sync.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordDocumentArrival } from '@/lib/intake/arrivals'
import { createLogger } from '@/lib/logger'

const log = createLogger('bank-feed/page-arrival')

export type BankFeedAggregator = 'enable_banking' | 'open_payments'

export async function recordBankFeedPageArrival(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    documentId: string
    connectionId: string
    accountUid: string
    /** 1-based, as in the archived file name. */
    page: number
    aggregator: BankFeedAggregator
  },
): Promise<void> {
  try {
    await recordDocumentArrival(supabase, {
      companyId: params.companyId,
      source: 'bank_feed',
      documentId: params.documentId,
      fetchedBy: { type: 'system', user_id: params.userId, label: params.aggregator },
      sourceMeta: {
        aggregator: params.aggregator,
        bank_connection_id: params.connectionId,
        account_uid: params.accountUid,
        page: params.page,
      },
    })
  } catch (err) {
    log.warn('bank feed page arrival could not be recorded', {
      companyId: params.companyId,
      entityId: params.documentId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
