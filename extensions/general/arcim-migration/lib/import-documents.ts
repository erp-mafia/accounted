/**
 * Provider document (underlag) import: best-effort, re-runnable.
 *
 * The migration imports the GL via SIE and the entity registers via the
 * provider API, but the receipts/underlag attached to each verifikat are not
 * carried by either. This step closes that gap for Bokio: it pages the Bokio
 * `/uploads`, resolves each receipt's target gnubok verifikat from the
 * SIE-preserved Bokio voucher number, and stores it through the document
 * service (storage + document_attachments), linked to the journal entry.
 *
 * Guarantees:
 *  - Idempotent: a receipt already archived for this verifikat (same content
 *    AND same journal entry, keyed on company_id + sha256 + journal_entry_id)
 *    is skipped, so re-runs don't duplicate. The pair matters: the same file
 *    content can legitimately back several verifikat (one arrende contract
 *    attached to each year's arrende verifikat), so content alone must not
 *    dedup across vouchers. This matters because a receipt linked to a posted
 *    verifikat becomes räkenskapsinformation and is undeletable
 *    (BFL 7 kap 2§ / WORM triggers).
 *  - Best-effort: a per-receipt failure is counted and logged, never thrown,
 *    so one bad download can't abort the sweep.
 *
 * Driven from its own /import-documents route rather than the migration's
 * critical path: the Bokio document API is rate-limited (200 req/60s) and a
 * full sweep can issue hundreds of download calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { BokioClient } from '@/lib/providers/bokio/client'
import {
  fetchBokioUploads,
  fetchBokioVoucherIndex,
  downloadBokioUpload,
  type BokioUpload,
  type BokioVoucherRef,
} from '@/lib/providers/bokio/attachments'
import {
  uploadDocument,
  computeSHA256,
  detectFileMagic,
  ALLOWED_DOCUMENT_TYPES,
} from '@/lib/core/documents/document-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'

const log = createLogger('extensions/arcim-migration/import-documents')

export interface ImportDocumentsOptions {
  supabase: SupabaseClient
  companyId: string
  userId: string
  consentId: string
  /** Resolve + report what would be attached without downloading or writing. */
  dryRun?: boolean
}

export interface ImportDocumentsResult {
  provider: string
  /** Uploads carrying a journalEntryId that were considered. */
  scanned: number
  /** Receipts newly archived and linked to their verifikat. */
  linked: number
  /** Receipts already archived for this verifikat (sha256 + journal entry match): re-run skip. */
  skipped: number
  /** Uploads whose Bokio voucher number resolved to no gnubok verifikat. */
  unmatched: number
  /** Receipts that failed to download/validate/store (counted, not thrown). */
  failed: number
  dryRun: boolean
  /** A few unmatched voucher labels, to aid diagnosis without dumping all. */
  unmatchedSamples: { uploadId: string; voucher: string; date: string }[]
}

interface FiscalPeriodRow {
  id: string
  period_start: string
  period_end: string
}

interface VoucherRow {
  id: string
  fiscal_period_id: string
  source_voucher_series: string | null
  source_voucher_number: number | null
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Find the fiscal period whose date range contains a given date. */
function periodIdForDate(periods: FiscalPeriodRow[], date: string): string | null {
  const period = periods.find((p) => p.period_start <= date && date <= p.period_end)
  return period?.id ?? null
}

/**
 * In-memory key for a verifikat: fiscal period + series + number. Scoping by
 * period is essential: Bokio reuses voucher numbers across fiscal years.
 */
function voucherKey(periodId: string, series: string, number: number): string {
  return `${periodId}|${series}|${number}`
}

/** Synthesise a readable filename: the Bokio uploads list carries none. */
function fileNameFor(upload: BokioUpload, ref: BokioVoucherRef, contentType: string | null): string {
  const ext = (contentType && EXTENSION_BY_TYPE[contentType]) || 'bin'
  const label = upload.description?.trim() || `${ref.series}${ref.number}`
  return `${label}.${ext}`
}

export async function importProviderDocuments(
  opts: ImportDocumentsOptions,
): Promise<ImportDocumentsResult> {
  const { supabase, companyId, userId, consentId, dryRun = false } = opts

  const resolved = await resolveConsent(companyId, consentId)
  const provider = resolved.consent.provider as string

  const result: ImportDocumentsResult = {
    provider,
    scanned: 0,
    linked: 0,
    skipped: 0,
    unmatched: 0,
    failed: 0,
    dryRun,
    unmatchedSamples: [],
  }

  // v1 supports Bokio only. Other providers are a no-op rather than an error
  // so a mixed-provider caller can invoke this unconditionally.
  if (provider !== 'bokio') {
    log.info('document import skipped: provider not supported in v1', { provider })
    return result
  }

  const { accessToken, providerCompanyId } = resolved
  if (!providerCompanyId) {
    throw new Error('Consent has no provider_company_id: cannot fetch Bokio uploads')
  }

  const client = new BokioClient()

  // ── Bulk reads (one round of paged requests each, no per-item N+1) ──
  const [uploads, voucherIndex, periods, vouchers, existingAttachments] = await Promise.all([
    fetchBokioUploads(client, accessToken, providerCompanyId),
    fetchBokioVoucherIndex(client, accessToken, providerCompanyId),
    // A stable `.order('id')` is required: fetchAllRows pages with `.range()`,
    // and PostgREST paging without a deterministic order can skip or repeat
    // rows once a table exceeds one page (journal_entries crosses 1000 once
    // several years are migrated), which would defeat both resolution and the
    // hash dedup below.
    fetchAllRows<FiscalPeriodRow>(({ from, to }) =>
      supabase
        .from('fiscal_periods')
        .select('id, period_start, period_end')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<VoucherRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, fiscal_period_id, source_voucher_series, source_voucher_number')
        .eq('company_id', companyId)
        .not('source_voucher_number', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{ sha256_hash: string; journal_entry_id: string | null }>(({ from, to }) =>
      supabase
        .from('document_attachments')
        .select('sha256_hash, journal_entry_id')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  // Index gnubok verifikat by (period, series, number) for in-memory resolution.
  const journalEntryByKey = new Map<string, string>()
  for (const v of vouchers) {
    if (v.source_voucher_series == null || v.source_voucher_number == null) continue
    journalEntryByKey.set(
      voucherKey(v.fiscal_period_id, v.source_voucher_series, v.source_voucher_number),
      v.id,
    )
  }

  // (content, verifikat) pairs already archived → idempotent skip set. Keyed
  // on hash + journal entry, NOT hash alone: the same content may back
  // several verifikat and each deserves its own attachment.
  const attachmentKey = (sha256: string, journalEntryId: string) => `${sha256}|${journalEntryId}`
  const seenAttachments = new Set(
    existingAttachments
      .filter((r) => r.journal_entry_id != null)
      .map((r) => attachmentKey(r.sha256_hash, r.journal_entry_id as string)),
  )

  // Every upload that carries a journalEntryId is a receipt we're responsible
  // for. Keep them all in scope (don't pre-filter on a resolvable voucher ref)
  // so an upload whose Bokio entry number didn't parse, or resolves to no
  // verifikat, is counted as unmatched rather than silently dropped.
  const linkedUploads = uploads.filter((u) => u.journalEntryId != null)

  const recordUnmatched = (uploadId: string, voucher: string, date: string) => {
    result.unmatched++
    if (result.unmatchedSamples.length < 20) {
      result.unmatchedSamples.push({ uploadId, voucher, date })
    }
  }

  for (const upload of linkedUploads) {
    result.scanned++
    const ref = voucherIndex.get(upload.journalEntryId as string)

    if (!ref) {
      // journalEntryId not in the Bokio voucher index (unparseable number, or
      // an entry the API didn't return): can't resolve a target verifikat.
      recordUnmatched(upload.id, '(unresolved)', '')
      continue
    }

    const periodId = periodIdForDate(periods, ref.date)
    const journalEntryId = periodId
      ? journalEntryByKey.get(voucherKey(periodId, ref.series, ref.number))
      : undefined

    if (!journalEntryId) {
      recordUnmatched(upload.id, `${ref.series}${ref.number}`, ref.date)
      continue
    }

    if (dryRun) {
      // We can resolve the target without spending a download: count it as a
      // would-link so the preview reflects the real plan.
      result.linked++
      continue
    }

    try {
      const { bytes } = await downloadBokioUpload(
        client,
        accessToken,
        providerCompanyId,
        upload.id,
      )

      const sha256 = await computeSHA256(bytes)
      if (seenAttachments.has(attachmentKey(sha256, journalEntryId))) {
        result.skipped++
        continue
      }

      // Trust the bytes over Bokio's metadata: the uploads list occasionally
      // declares the wrong contentType (a JPEG stored as image/png), which
      // would fail magic validation. Sniff the real format first and fall
      // back to the declared type only when no signature is recognised; if
      // neither yields an allowed type, store without a declared type so
      // uploadDocument skips magic validation rather than rejecting.
      const sniffedType = detectFileMagic(new Uint8Array(bytes))
      const effectiveType =
        sniffedType ??
        (upload.contentType && ALLOWED_DOCUMENT_TYPES.includes(upload.contentType)
          ? upload.contentType
          : undefined)

      await uploadDocument(
        supabase,
        userId,
        companyId,
        { name: fileNameFor(upload, ref, effectiveType ?? upload.contentType), buffer: bytes, type: effectiveType },
        { upload_source: 'api', journal_entry_id: journalEntryId },
      )

      seenAttachments.add(attachmentKey(sha256, journalEntryId))
      result.linked++
    } catch (err) {
      result.failed++
      log.error('failed to import a receipt', err as Error, {
        uploadId: upload.id,
        voucher: `${ref.series}${ref.number}`,
      })
    }
  }

  log.info('document import complete', {
    companyId,
    dryRun,
    scanned: result.scanned,
    linked: result.linked,
    skipped: result.skipped,
    unmatched: result.unmatched,
    failed: result.failed,
  })

  return result
}
