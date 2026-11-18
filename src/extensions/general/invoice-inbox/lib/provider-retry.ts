/**
 * The inbox sweep's one automatic re-read: a document whose reading failed
 * because the AI provider could not take the call (stamped
 * failed:provider_unavailable, see lib/documents/inbox-extraction/
 * extraction-failure.ts) is read again, a few documents per pass and a capped
 * number of times. Nothing else is ever retried here: a document that failed
 * for any other reason fails the same way again, and keeps its visible
 * failed:no_raw_text and "Läs igen" for a person to act on.
 *
 * Attempts are counted in the document's own stamp, so no column is needed:
 * failed:provider_unavailable is the upload's reading (attempt 1),
 * failed:provider_unavailable:2 and :3 the retries. extracted_at is when the
 * latest attempt started; the gap before the next one is measured from it.
 *
 * One retry:
 *   1. claims the document with a compare-and-set on the stamp and
 *      extracted_at it was selected with, writing the next attempt's stamp
 *      and now. The attempt counts from here, before anything is spent, so a
 *      run that dies mid-reading cannot keep a document in the retry set, and
 *      an overlapping sweep run sees the fresh extracted_at and leaves it.
 *   2. applies the upload path's gates (the ai capability, sandbox): a
 *      company that may not have it read gets the skip stamp its upload would
 *      have had, and no call is made.
 *   3. reads it with readForInbox, the deferred upload worker's reading (the
 *      same page gate and extractInvoiceFields).
 *   4. on a reading, writes it onto the inbox item with a compare-and-set on
 *      the updated_at the item was selected with (still received, still not
 *      booked), and only then mirrors it onto the document: an inbox path's
 *      mirror follows its claim. Any
 *      write to the item in between, a person's correction above all, wins
 *      and the reading is dropped. Another provider failure keeps the claimed
 *      stamp; any other failure or skip gets its own stamp, which ends the
 *      retries.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getAiStatus } from '@/lib/ai'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { keepPersonChoices } from '@/lib/documents/person-corrections'
import { matchSupplierId } from '@/lib/suppliers/match-supplier'
import { proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'
import {
  extractionStamp,
  isReadOutcome,
  mirrorExtractionToDocument,
  providerUnavailableAttempt,
  providerUnavailableStamp,
  type ExtractionOutcome,
} from '@/lib/documents/inbox-extraction/mirror-extraction'
import type { ReadingRetry } from '@/lib/inkorg/items'
import { countPdfPages, isSandboxCompany, maxPagesForAutoExtract, readForInbox } from './upload-and-extract'

const log = createLogger('invoice-inbox/provider-retry')

const MINUTE = 60 * 1000

/**
 * The least time before each retry, measured from the start of the attempt
 * before it: 15 minutes before the second reading, two hours before the
 * third. A short blip (a throttle, a few minutes of 503s) is caught by the
 * first retry; the second still lands after an outage the length of
 * 2026-10-26's (08:35-11:29 UTC) for most documents filed in it.
 */
export const PROVIDER_RETRY_GAPS_MS = [15 * MINUTE, 120 * MINUTE] as const

/** Readings of one document in all, the upload's included. */
export const PROVIDER_RETRY_MAX_ATTEMPTS = PROVIDER_RETRY_GAPS_MS.length + 1

/**
 * Documents read per sweep pass. Each reading may run to the 250 s extraction
 * deadline, and the batch runs side by side inside the cron's 300 s.
 */
export const PROVIDER_RETRY_BATCH = 3

/**
 * Only items filed this recently are retried. The retries themselves end
 * within about two hours of the upload, by the cap; the window is wider so an
 * operator can re-queue an outage's backlog by restamping its documents to
 * failed:provider_unavailable (on 2026-10-27, 130 untouched items from the
 * 10-19 and 10-26 outages). The bound keeps the selection on the inbox's
 * created_at index instead of a sequential scan of every document row
 * (measured read-only in production on 2026-10-27: the 14-day select is a
 * bitmap scan on idx_invoice_inbox_items_company_created, about 65 ms and
 * 20 000 shared buffers, against 140 ms and 27 500 buffers for the
 * document-side scan), so no index is added.
 */
export const PROVIDER_RETRY_WINDOW_MS = 14 * 24 * 60 * MINUTE

/**
 * What the Inkorg says about an empty reading, from its document's stamp and
 * the item's age: the same cap and window the selection above uses, so the
 * page never promises a reading the sweep will not make. Pure.
 */
export function readingRetryOf(
  stamp: string | null | undefined,
  itemCreatedAt: string | null | undefined,
  now: number = Date.now(),
): ReadingRetry | null {
  const attempt = providerUnavailableAttempt(stamp)
  if (attempt == null) return null
  const filedAt = itemCreatedAt ? Date.parse(itemCreatedAt) : Number.NaN
  if (attempt >= PROVIDER_RETRY_MAX_ATTEMPTS || !(filedAt > now - PROVIDER_RETRY_WINDOW_MS)) return 'exhausted'
  return attempt === 1 ? 'scheduled' : 'scheduled_later'
}

export interface ProviderRetrySummary {
  /** Documents claimed for a retry this pass. */
  attempted: number
  /** Retries whose reading landed on the inbox item. */
  read: number
  /** Retries the provider again could not take (the claimed stamp stands). */
  unavailable: number
}

/**
 * read: the reading landed. unavailable: the provider failed again. failed /
 * skipped: any other failure or skip, stamped as such. gated: the company may
 * not have it read. refused: the item changed while it was read. lost:
 * another run or a person got to the document first. ineligible: not a
 * provider failure under the cap after all.
 */
type RetryOutcome = 'read' | 'unavailable' | 'failed' | 'skipped' | 'gated' | 'refused' | 'lost' | 'ineligible'

interface CandidateDocument {
  id: string
  storage_path: string | null
  mime_type: string | null
  file_name: string | null
  extraction_model: string | null
  extracted_at: string | null
}

interface Candidate {
  id: string
  company_id: string
  document_id: string
  correlation_id: string | null
  created_at: string
  updated_at: string
  extracted_data: Record<string, unknown> | null
  matched_supplier_id: string | null
  email_subject: string | null
  email_received_at: string | null
  document_attachments: CandidateDocument | CandidateDocument[] | null
}

const CANDIDATE_COLUMNS =
  'id, company_id, document_id, correlation_id, created_at, updated_at, extracted_data, matched_supplier_id, email_subject, email_received_at, document_attachments!inner(id, storage_path, mime_type, file_name, extraction_model, extracted_at)'

function documentOf(row: Candidate): CandidateDocument | null {
  const doc = row.document_attachments
  return Array.isArray(doc) ? (doc[0] ?? null) : doc
}

/**
 * The items due a retry: still received, never booked, read by nothing but
 * the failed call (no person's correction on the item, no reading on the
 * document), filed within the window, whose document's last attempt was a
 * provider failure older than that attempt's gap. One select per attempt
 * number, each with its own gap; nothing is selected at the cap.
 */
async function selectCandidates(supabase: SupabaseClient, now: number): Promise<Candidate[]> {
  const since = new Date(now - PROVIDER_RETRY_WINDOW_MS).toISOString()
  const due: Candidate[] = []
  for (let attempt = 1; attempt < PROVIDER_RETRY_MAX_ATTEMPTS; attempt++) {
    const cutoff = new Date(now - PROVIDER_RETRY_GAPS_MS[attempt - 1]).toISOString()
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select(CANDIDATE_COLUMNS)
      .eq('status', 'received')
      .eq('extraction_skipped', false)
      .is('created_supplier_invoice_id', null)
      .is('created_journal_entry_id', null)
      .is('extracted_data->personFields', null)
      .gt('created_at', since)
      .eq('document_attachments.extraction_model', providerUnavailableStamp(attempt))
      .is('document_attachments.extracted_data', null)
      .lt('document_attachments.extracted_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(PROVIDER_RETRY_BATCH)
    if (error) {
      log.error('provider retry select failed', { attempt, error: error.message })
      continue
    }
    due.push(...((data ?? []) as unknown as Candidate[]))
  }
  return due.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, PROVIDER_RETRY_BATCH)
}

/**
 * Replace the claimed stamp with the attempt's real outcome, guarded so it
 * never lands on a document that got a reading or a correction meanwhile.
 */
async function restamp(supabase: SupabaseClient, documentId: string, claimedStamp: string, stamp: string): Promise<void> {
  const { error } = await supabase
    .from('document_attachments')
    .update({ extraction_model: stamp, extracted_at: new Date().toISOString() })
    .eq('id', documentId)
    .eq('extraction_model', claimedStamp)
    .is('extracted_data', null)
  if (error) log.warn('provider retry restamp failed', { doc: documentId, stamp, error: error.message })
}

async function recordAttempt(row: Candidate, documentId: string, attempt: number, outcome: RetryOutcome): Promise<void> {
  if (!row.correlation_id) return
  try {
    await appendProcessingHistory({
      companyId: row.company_id,
      correlationId: row.correlation_id,
      aggregateType: 'Document',
      aggregateId: documentId,
      eventType: 'DocumentExtractionRetried',
      payload: { inbox_item_id: row.id, document_id: documentId, attempt, outcome, reason: 'provider_unavailable' },
      actor: { type: 'system', id: 'invoice-inbox-sweep' },
      occurredAt: new Date(),
    })
  } catch (err) {
    log.warn('provider retry history append failed', { item: row.id, error: err instanceof Error ? err.message : String(err) })
  }
}

async function retryOne(supabase: SupabaseClient, row: Candidate): Promise<RetryOutcome> {
  const doc = documentOf(row)
  const selectedStamp = doc?.extraction_model ?? null
  const selectedAt = doc?.extracted_at ?? null
  const attempt = providerUnavailableAttempt(selectedStamp)
  // Belt and braces: the select asks for exactly this, and the cap holds even if it did not.
  if (!doc || !selectedStamp || !selectedAt || attempt == null || attempt >= PROVIDER_RETRY_MAX_ATTEMPTS) {
    return 'ineligible'
  }
  const nextAttempt = attempt + 1
  const claimedStamp = providerUnavailableStamp(nextAttempt)

  const { data: claimed, error: claimError } = await supabase
    .from('document_attachments')
    .update({ extraction_model: claimedStamp, extracted_at: new Date().toISOString() })
    .eq('id', doc.id)
    .eq('extraction_model', selectedStamp)
    .eq('extracted_at', selectedAt)
    .is('extracted_data', null)
    .select('id')
  if (claimError) {
    log.warn('provider retry claim failed', { doc: doc.id, error: claimError.message })
    return 'lost'
  }
  if (!Array.isArray(claimed) || claimed.length === 0) return 'lost'

  // The upload path's gates, decided now: the company may have lost the ai
  // capability or turned into a sandbox since the upload.
  const gate = !(await hasCapability(supabase, row.company_id, CAPABILITY.ai))
    ? 'no_ai_entitlement'
    : (await isSandboxCompany(supabase, row.company_id))
      ? 'sandbox'
      : null
  if (gate) {
    await restamp(supabase, doc.id, claimedStamp, extractionStamp({ data: null, rawText: null, skipped: gate }))
    return 'gated'
  }

  const { data: blob, error: downloadError } = doc.storage_path
    ? await supabase.storage.from('documents').download(doc.storage_path)
    : { data: null, error: { message: 'no storage path' } }
  if (downloadError || !blob) {
    // Storage is ours, not the document's: the claimed stamp stands, and the
    // capped attempts still bound how often this is tried.
    log.error('provider retry download failed', { doc: doc.id, error: downloadError?.message ?? 'empty' })
    return 'failed'
  }

  const file = {
    name: doc.file_name ?? 'document',
    buffer: await blob.arrayBuffer(),
    type: doc.mime_type ?? 'application/octet-stream',
  }
  const maxAutoExtractPages = maxPagesForAutoExtract()
  const pageCount = file.type === 'application/pdf' ? await countPdfPages(file.buffer) : null
  const reading = await readForInbox(supabase, {
    companyId: row.company_id,
    file,
    pageCount,
    gatedByPageCount: pageCount != null && pageCount > maxAutoExtractPages,
    maxAutoExtractPages,
    // The mail it came with, as on its first reading (crm#1749).
    emailContext: { subject: row.email_subject ?? null, receivedAt: row.email_received_at ?? null },
  })
  const outcome: ExtractionOutcome = {
    data: reading.extracted,
    rawText: reading.rawText,
    model: reading.model,
    skipped: reading.skipReason,
    failure: reading.failure,
    attempt: nextAttempt,
  }

  if (!isReadOutcome(outcome)) {
    if (reading.failure === 'provider_unavailable' && !reading.extractionSkipped) {
      await recordAttempt(row, doc.id, nextAttempt, 'unavailable')
      return 'unavailable'
    }
    await restamp(supabase, doc.id, claimedStamp, extractionStamp(outcome))
    await recordAttempt(row, doc.id, nextAttempt, reading.extractionSkipped ? 'skipped' : 'failed')
    return reading.extractionSkipped ? 'skipped' : 'failed'
  }

  // A purchase category a person chose on the empty item rides along, as on
  // every replacement of a reading.
  const next = keepPersonChoices(row.extracted_data, reading.extracted)
  const matchedSupplierId = await matchSupplierId(supabase, row.company_id, next.supplier)
  const { data: written, error: writeError } = await supabase
    .from('invoice_inbox_items')
    .update({
      extracted_data: next as unknown as Record<string, unknown>,
      // Only a positive match is written: a supplier picked by hand stays.
      matched_supplier_id: matchedSupplierId ?? row.matched_supplier_id,
    })
    .eq('id', row.id)
    .eq('company_id', row.company_id)
    .eq('status', 'received')
    .eq('updated_at', row.updated_at)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .select('id')
  if (writeError || !Array.isArray(written) || written.length === 0) {
    if (writeError) log.warn('provider retry write failed', { item: row.id, error: writeError.message })
    await recordAttempt(row, doc.id, nextAttempt, 'refused')
    return 'refused'
  }

  await mirrorExtractionToDocument(doc.id, outcome)
  await recordAttempt(row, doc.id, nextAttempt, 'read')
  await proposeBankMatchForInboxItem(supabase, row.company_id, row.id)
  return 'read'
}

/**
 * Read again the inbox documents the AI provider could not read, within the
 * attempt cap and the gaps. Never throws.
 */
export async function retryProviderUnavailableReadings(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<ProviderRetrySummary> {
  const summary: ProviderRetrySummary = { attempted: 0, read: 0, unavailable: 0 }
  try {
    // A deployment with no AI backend has nothing to retry with.
    if (!getAiStatus().configured) return summary
    const candidates = await selectCandidates(supabase, now)
    if (candidates.length === 0) return summary

    const outcomes = await Promise.all(
      candidates.map((row) =>
        retryOne(supabase, row).catch((err: unknown): RetryOutcome => {
          log.error('provider retry threw', { item: row.id, error: err instanceof Error ? err.message : String(err) })
          return 'failed'
        }),
      ),
    )
    const tally: Record<RetryOutcome, number> = {
      read: 0,
      unavailable: 0,
      failed: 0,
      skipped: 0,
      gated: 0,
      refused: 0,
      lost: 0,
      ineligible: 0,
    }
    for (const outcome of outcomes) tally[outcome] += 1
    summary.attempted = outcomes.length - tally.lost - tally.ineligible
    summary.read = tally.read
    summary.unavailable = tally.unavailable
    log.info('provider retry pass', { candidates: candidates.length, ...tally })
  } catch (err) {
    log.error('provider retry pass failed', { error: err instanceof Error ? err.message : String(err) })
  }
  return summary
}
