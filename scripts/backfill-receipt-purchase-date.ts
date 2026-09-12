#!/usr/bin/env npx tsx
/**
 * Backfill invoice.invoiceDate on receipts that were extracted before
 * PR #2429 (2026-09-08).
 *
 * Until that PR the extraction prompt described invoice.invoiceDate as a
 * bare ISO date under the invoice block, next to a purchaseTime rule marked
 * "receipts only", and the model returned null for the date on roughly half
 * of all receipts (three quarters of the WhatsApp ones). Those rows never
 * re-extract by themselves: the prompt fix only helps documents read after
 * it shipped.
 *
 * DATE-ONLY BY DESIGN. The script re-reads the stored document with the
 * fixed prompt and writes exactly one field, invoice.invoiceDate, and only
 * where that field is still null at write time. Nothing else in
 * extracted_data (manual edits, matched supplier, totals, line items) is
 * touched. The per-item "Tolka om" action overwrites extracted_data
 * wholesale, which is fine for one item a user is looking at and wrong for
 * a bulk run over 46 companies' inboxes.
 *
 * Idempotent and resumable: a second run finds nothing to do for rows that
 * now carry a date. Every write is conditional on the date still being null,
 * so a user typing the date by hand while the run is in flight wins.
 *
 * Scope: invoice_inbox_items with documentKind = receipt, status received,
 * no supplier invoice created, a document attached, and a null date.
 * Booked items are excluded: their verifikat already carries the date that
 * matters. Sandbox companies are excluded.
 *
 * Usage:
 *   npx tsx scripts/backfill-receipt-purchase-date.ts --env <file> [--apply]
 *       [--limit N] [--concurrency N] [--company <id>] [--log <path>]
 *
 * The default is a dry run: it calls the model and prints what it would
 * write, but writes nothing. --env is mandatory so the target database is a
 * deliberate choice (the banner prints the host). Each processed item costs
 * one model call; budget roughly 1 300 calls for the 2026-09 backlog.
 */

import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

const ENV_FILE = arg('--env')
if (!ENV_FILE) {
  console.error('Pass --env <file> explicitly (this script mutates whatever database that file points at).')
  process.exit(1)
}
config({ path: ENV_FILE })

const APPLY = process.argv.includes('--apply')
const LIMIT = arg('--limit') ? Number(arg('--limit')) : null
const CONCURRENCY = arg('--concurrency') ? Math.max(1, Number(arg('--concurrency'))) : 3
const COMPANY_FILTER = arg('--company')
const LOG_PATH = arg('--log') ?? `./tmp/backfill-receipt-purchase-date-${Date.now()}.jsonl`
const PAGE = 500
const ACTOR = { type: 'system' as const, id: 'backfill-receipt-purchase-date' }

type Outcome =
  | 'dated'
  | 'would_date'
  | 'already_dated'
  | 'no_date_found'
  | 'implausible'
  | 'extraction_failed'
  | 'skipped_media'
  | 'download_failed'
  | 'sandbox'
  | 'error'

interface Candidate {
  id: string
  company_id: string
  document_id: string
  correlation_id: string | null
  created_at: string
}

interface ExtractedShape {
  invoice?: { invoiceDate?: string | null; [k: string]: unknown } | null
  [k: string]: unknown
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A date the receipt could plausibly carry: real calendar date, not before
 *  2015, not after the day the document reached the inbox. */
function plausibleDate(value: string | null | undefined, createdAt: string): string | null {
  if (!value || !ISO_DATE.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null
  if (value < '2015-01-01') return null
  if (value > createdAt.slice(0, 10)) return null
  return value
}

function logLine(record: Record<string, unknown>): void {
  appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
}

async function loadCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const all: Candidate[] = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from('invoice_inbox_items')
      .select('id, company_id, document_id, correlation_id, created_at')
      .eq('status', 'received')
      .is('created_supplier_invoice_id', null)
      .not('document_id', 'is', null)
      .eq('extracted_data->>documentKind', 'receipt')
      .is('extracted_data->invoice->>invoiceDate', null)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1)
    if (COMPANY_FILTER) query = query.eq('company_id', COMPANY_FILTER)
    const { data, error } = await query
    if (error) throw new Error(`candidate query failed: ${error.message}`)
    const rows = (data ?? []) as Candidate[]
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return LIMIT ? all.slice(0, LIMIT) : all
}

async function loadSandboxCompanies(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('company_id')
    .eq('is_sandbox', true)
  if (error) throw new Error(`sandbox lookup failed: ${error.message}`)
  return new Set(((data ?? []) as { company_id: string }[]).map((r) => r.company_id))
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in the env file.')
    process.exit(1)
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  // Dynamic imports so the env file is loaded before any module that reads
  // configuration at import time.
  const { extractInvoiceFields, fetchOwnCompanyIdentity } = await import(
    '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
  )
  const { appendProcessingHistoryWithClient } = await import('@/lib/processing-history/append')
  const { readAiConfig } = await import('@/lib/ai/config')
  const ai = readAiConfig()

  mkdirSync(dirname(LOG_PATH), { recursive: true })

  console.log('============================================================')
  console.log(`Target:      ${new URL(url).host}`)
  console.log(`Mode:        ${APPLY ? 'APPLY (writes invoice.invoiceDate)' : 'DRY RUN (no writes)'}`)
  console.log(`AI:          ${ai.provider} / ${ai.models.extraction ?? '(none)'} configured=${ai.configured}`)
  console.log(`Concurrency: ${CONCURRENCY}${LIMIT ? `  Limit: ${LIMIT}` : ''}${COMPANY_FILTER ? `  Company: ${COMPANY_FILTER}` : ''}`)
  console.log(`Log:         ${LOG_PATH}`)
  console.log('============================================================')
  if (!ai.configured) {
    console.error('AI is not configured in this env file; nothing to do.')
    process.exit(1)
  }

  const sandbox = await loadSandboxCompanies(supabase)
  const candidates = await loadCandidates(supabase)
  console.log(`Candidates:  ${candidates.length} undated receipts`)

  const counts: Record<Outcome, number> = {
    dated: 0,
    would_date: 0,
    already_dated: 0,
    no_date_found: 0,
    implausible: 0,
    extraction_failed: 0,
    skipped_media: 0,
    download_failed: 0,
    sandbox: 0,
    error: 0,
  }
  const ownCompanyCache = new Map<string, Awaited<ReturnType<typeof fetchOwnCompanyIdentity>>>()
  let consecutiveFailures = 0
  let processed = 0

  async function record(outcome: Outcome, item: Candidate, extra: Record<string, unknown> = {}) {
    counts[outcome]++
    processed++
    logLine({ outcome, inbox_item_id: item.id, company_id: item.company_id, ...extra })
    if (processed % 25 === 0 || processed === candidates.length) {
      console.log(`[${processed}/${candidates.length}] ${JSON.stringify(counts)}`)
    }
  }

  async function handle(item: Candidate): Promise<void> {
    if (sandbox.has(item.company_id)) return record('sandbox', item)
    try {
      const { data: doc, error: docError } = await supabase
        .from('document_attachments')
        .select('id, storage_path, mime_type, file_name, extracted_data')
        .eq('id', item.document_id)
        .maybeSingle()
      if (docError || !doc) return record('download_failed', item, { reason: docError?.message ?? 'no document row' })

      const { data: blob, error: dlError } = await supabase.storage
        .from('documents')
        .download(doc.storage_path as string)
      if (dlError || !blob) return record('download_failed', item, { reason: dlError?.message ?? 'empty blob' })

      let ownCompany = ownCompanyCache.get(item.company_id)
      if (!ownCompany) {
        ownCompany = await fetchOwnCompanyIdentity(supabase, item.company_id)
        ownCompanyCache.set(item.company_id, ownCompany)
      }

      const extraction = await extractInvoiceFields({
        buffer: Buffer.from(await blob.arrayBuffer()),
        mimeType: doc.mime_type as string,
        fileName: doc.file_name as string,
        ownCompany,
      })
      if (extraction.skipped) return record('skipped_media', item, { reason: extraction.skipped })
      if (extraction.rawText == null) {
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
          console.warn('three extraction failures in a row; pausing 30 s (throttling?)')
          await new Promise((r) => setTimeout(r, 30_000))
        }
        return record('extraction_failed', item)
      }
      consecutiveFailures = 0

      const raw = extraction.data.invoice?.invoiceDate ?? null
      if (!raw) return record('no_date_found', item, { model: extraction.model ?? null })
      const date = plausibleDate(raw, item.created_at)
      if (!date) return record('implausible', item, { raw, created_at: item.created_at })

      if (!APPLY) return record('would_date', item, { date, model: extraction.model ?? null })

      // Re-read right before writing so the merge is against the freshest
      // extracted_data, then write conditionally on the date still being null.
      const { data: fresh } = await supabase
        .from('invoice_inbox_items')
        .select('extracted_data')
        .eq('id', item.id)
        .maybeSingle()
      const current = ((fresh as { extracted_data: ExtractedShape | null } | null)?.extracted_data) ?? null
      if (!current) return record('error', item, { reason: 'extracted_data vanished' })
      if (current.invoice?.invoiceDate) return record('already_dated', item)
      const merged: ExtractedShape = { ...current, invoice: { ...(current.invoice ?? {}), invoiceDate: date } }

      const { data: updated, error: updateError } = await supabase
        .from('invoice_inbox_items')
        .update({ extracted_data: merged as Record<string, unknown> })
        .eq('id', item.id)
        .is('extracted_data->invoice->>invoiceDate', null)
        .select('id')
      if (updateError) return record('error', item, { reason: updateError.message })
      if (!updated || updated.length === 0) return record('already_dated', item)

      // Keep the document-level mirror (read by the assistant's underlag
      // context) consistent, under the same null-only guard.
      const mirror = (doc.extracted_data as ExtractedShape | null) ?? null
      if (mirror && !mirror.invoice?.invoiceDate) {
        await supabase
          .from('document_attachments')
          .update({
            extracted_data: {
              ...mirror,
              invoice: { ...(mirror.invoice ?? {}), invoiceDate: date },
            } as Record<string, unknown>,
          })
          .eq('id', item.document_id)
          .is('extracted_data->invoice->>invoiceDate', null)
      }

      try {
        await appendProcessingHistoryWithClient(supabase, {
          companyId: item.company_id,
          correlationId: item.correlation_id ?? item.id,
          aggregateType: 'Document',
          aggregateId: item.document_id,
          eventType: 'DocumentExtractionRetried',
          payload: {
            backfill: 'receipt-purchase-date',
            inbox_item_id: item.id,
            document_id: item.document_id,
            field: 'invoice.invoiceDate',
            invoice_date: date,
          },
          actor: ACTOR,
          occurredAt: new Date(),
        })
      } catch (historyError) {
        logLine({
          outcome: 'history_failed',
          inbox_item_id: item.id,
          reason: historyError instanceof Error ? historyError.message : String(historyError),
        })
      }
      return record('dated', item, { date, model: extraction.model ?? null })
    } catch (err) {
      return record('error', item, { reason: err instanceof Error ? err.message : String(err) })
    }
  }

  const queue = [...candidates]
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      await handle(next)
    }
  })
  await Promise.all(workers)

  console.log('============================================================')
  console.log(`Done. ${APPLY ? 'Wrote' : 'Would write'} ${APPLY ? counts.dated : counts.would_date} dates.`)
  console.log(JSON.stringify(counts, null, 2))
  console.log(`Per-item log: ${LOG_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
