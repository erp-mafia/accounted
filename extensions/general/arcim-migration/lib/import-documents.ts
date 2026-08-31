/**
 * Provider document (underlag) import: best-effort, re-runnable.
 *
 * The migration imports the GL via SIE and the entity registers via the
 * provider API, but the receipts/underlag attached to each verifikat are not
 * carried by either. This step closes that gap for Bokio and Fortnox: it
 * resolves each receipt's target gnubok verifikat from the SIE-preserved
 * provider voucher number, and stores it through the document service
 * (storage + document_attachments), linked to the journal entry.
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
 * critical path: provider document APIs are rate-limited and a full sweep can
 * issue hundreds of download calls. Fortnox requires archive and connectfile
 * scopes; existing consents must reconnect before this import can run.
 *
 * Resumable: one call works through the provider's attachment list (sorted
 * by provider id so the order is stable between calls) until `timeBudgetMs`
 * is spent, then returns `partial: true` with `nextCursor` = the id of the
 * last attachment it handled. The caller loops, passing the cursor back,
 * until `partial` is false. The cursor is an id, not an index, so a file the
 * provider adds or removes mid-sweep shifts nothing: the next slice simply
 * continues after the last handled id in sorted order. A 113-file Fortnox
 * import used to run every file inline inside one request and hit the
 * hosted 300 s function limit after ~17 files (2026-08-21); the UI then
 * showed a generic failure even though the files it did reach were linked.
 *
 * No AI extraction: every file here is linked to a posted verifikat on
 * arrival, so the booking is already known. The upload opts out
 * (`extractionOwner: 'none'`); it was the per-file model pass that made the
 * sweep blow its budget in the first place.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveConsent, type ResolvedConsent } from '@/lib/providers/resolve-consent'
import { BokioClient } from '@/lib/providers/bokio/client'
import {
  fetchBokioUploads,
  fetchBokioVoucherIndex,
  downloadBokioUpload,
  type BokioUpload,
} from '@/lib/providers/bokio/attachments'
import {
  FortnoxApiError,
  FortnoxClient,
  isFortnoxPermissionError,
} from '@/lib/providers/fortnox/client'
import {
  downloadFortnoxArchiveFile,
  fetchFortnoxFileConnections,
  fetchFortnoxFinancialYears,
} from '@/lib/providers/fortnox/attachments'
import {
  uploadDocument,
  computeSHA256,
  detectFileMagic,
  ALLOWED_DOCUMENT_TYPES,
} from '@/lib/core/documents/document-service'
import {
  buildVoucherIndex,
  fetchFiscalPeriods,
  fetchSourceRefVouchers,
  resolveDatedRef,
} from '@/lib/documents/voucher-ref-resolver'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'

const log = createLogger('extensions/arcim-migration/import-documents')

export class FortnoxDocumentScopesRequiredError extends Error {
  readonly code = 'PROVIDER_DOCUMENT_SCOPES_REQUIRED'

  constructor() {
    super('Fortnox consent lacks archive/connectfile scope: reconnect required')
    this.name = 'FortnoxDocumentScopesRequiredError'
  }
}

export interface ImportDocumentsOptions {
  supabase: SupabaseClient
  companyId: string
  userId: string
  consentId: string
  /** Resolve + report what would be attached without downloading or writing. */
  dryRun?: boolean
  /** Resume after this provider attachment id (sorted order); omit to start from the top. */
  cursor?: string | null
  /**
   * Wall-clock budget for this call. Once spent, the sweep stops after the
   * attachment in flight and reports `nextCursor`. Default leaves headroom
   * under the hosted 300 s function limit for listing + the final response.
   */
  timeBudgetMs?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

export const DEFAULT_IMPORT_DOCUMENTS_TIME_BUDGET_MS = 200_000

export interface ImportDocumentsResult {
  provider: string
  /** Provider attachments linked to a voucher that were considered. */
  scanned: number
  /** Receipts newly archived and linked to their verifikat. */
  linked: number
  /** Receipts already archived for this verifikat (sha256 + journal entry match): re-run skip. */
  skipped: number
  /** Attachments whose provider voucher resolved to no gnubok verifikat. */
  unmatched: number
  /** Receipts that failed to download/validate/store (counted, not thrown). */
  failed: number
  dryRun: boolean
  /** A few unmatched voucher labels, to aid diagnosis without dumping all. */
  unmatchedSamples: { uploadId: string; voucher: string; date: string }[]
  /** Provider attachments linked to a voucher in total (all calls). */
  total: number
  /** True when the time budget ran out before the end of the list. */
  partial: boolean
  /** Last handled attachment id; pass back as `cursor` to continue. Null when complete. */
  nextCursor: string | null
}

interface ProviderAttachment {
  id: string
  fileName: string | null
  fileNameIsBaseName: boolean
  declaredContentType: string | null
  ref: { series: string; number: number; date: string; dateTo?: string } | null
}

interface ProviderAttachmentSource {
  list(): Promise<ProviderAttachment[]>
  download(id: string): Promise<{ bytes: ArrayBuffer; contentType: string | null }>
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Remove path/control characters while retaining a readable archive name. */
function sanitizeProviderFileName(fileName: string): string {
  return (
    fileName
      .trim()
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[._ ]+|[. _]+$/g, '')
      .slice(0, 180) || 'file'
  )
}

function normalizedContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized || null
}

/** Keep a provider filename when available, otherwise synthesize one. */
function fileNameFor(
  attachment: ProviderAttachment,
  ref: NonNullable<ProviderAttachment['ref']>,
  contentType: string | null,
): string {
  const ext = (contentType && EXTENSION_BY_TYPE[contentType]) || 'bin'
  const providerName = attachment.fileName?.trim()
  if (!providerName) return `${ref.series}${ref.number}.${ext}`

  const sanitized = sanitizeProviderFileName(providerName)
  return !attachment.fileNameIsBaseName && /\.[A-Za-z0-9]+$/.test(sanitized)
    ? sanitized
    : `${sanitized}.${ext}`
}

function bokioSource(
  client: BokioClient,
  resolved: ResolvedConsent,
): ProviderAttachmentSource {
  const { accessToken, providerCompanyId } = resolved
  if (!providerCompanyId) {
    throw new Error('Consent has no provider_company_id: cannot fetch Bokio uploads')
  }

  return {
    async list() {
      const [uploads, voucherIndex] = await Promise.all([
        fetchBokioUploads(client, accessToken, providerCompanyId),
        fetchBokioVoucherIndex(client, accessToken, providerCompanyId),
      ])

      return uploads
        .filter((upload) => upload.journalEntryId != null)
        .map((upload: BokioUpload): ProviderAttachment => ({
          id: upload.id,
          // Bokio exposes a description rather than a real filename. Treat it
          // as the preferred basename so the adapter preserves current names.
          fileName: upload.description?.trim() || null,
          fileNameIsBaseName: true,
          declaredContentType: upload.contentType,
          ref: voucherIndex.get(upload.journalEntryId as string) ?? null,
        }))
    },
    download(id) {
      return downloadBokioUpload(client, accessToken, providerCompanyId, id)
    },
  }
}

function fortnoxSource(
  client: FortnoxClient,
  accessToken: string,
): ProviderAttachmentSource {
  return {
    async list() {
      try {
        const financialYears = await fetchFortnoxFinancialYears(client, accessToken)
        const connections = await fetchFortnoxFileConnections(
          client,
          accessToken,
          financialYears.map((year) => year.id),
        )
        const financialYearById = new Map(financialYears.map((year) => [year.id, year]))

        return connections.map((connection): ProviderAttachment => {
          const financialYear = financialYearById.get(connection.financialYearId)
          return {
            id: connection.fileId,
            fileName: connection.name,
            fileNameIsBaseName: false,
            declaredContentType: null,
            ref: financialYear
              ? {
                  series: connection.series,
                  number: connection.number,
                  date: financialYear.fromDate,
                  dateTo: financialYear.toDate,
                }
              : null,
          }
        })
      } catch (error) {
        if (isFortnoxPermissionError(error)) {
          throw new FortnoxDocumentScopesRequiredError()
        }
        throw error
      }
    },
    download(id) {
      return downloadFortnoxArchiveFile(client, accessToken, id)
    },
  }
}

export async function importProviderDocuments(
  opts: ImportDocumentsOptions,
): Promise<ImportDocumentsResult> {
  const {
    supabase,
    companyId,
    userId,
    consentId,
    dryRun = false,
    cursor = null,
    timeBudgetMs = DEFAULT_IMPORT_DOCUMENTS_TIME_BUDGET_MS,
    now = Date.now,
  } = opts
  const startedAt = now()

  let resolved = await resolveConsent(companyId, consentId)
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
    total: 0,
    partial: false,
    nextCursor: null,
  }

  // Unsupported providers are a no-op rather than an error
  // so a mixed-provider caller can invoke this unconditionally.
  if (provider !== 'bokio' && provider !== 'fortnox') {
    log.info('document import skipped: provider not supported', { provider })
    return result
  }

  const bokioClient = provider === 'bokio' ? new BokioClient() : null
  const fortnoxClient = provider === 'fortnox' ? new FortnoxClient() : null
  const source = (): ProviderAttachmentSource =>
    provider === 'bokio'
      ? bokioSource(bokioClient as BokioClient, resolved)
      : fortnoxSource(fortnoxClient as FortnoxClient, resolved.accessToken)

  // ── Bulk reads (one round of paged requests each, no per-item N+1) ──
  const [listedAttachments, periods, vouchers, existingAttachments] = await Promise.all([
    source().list(),
    fetchFiscalPeriods(supabase, companyId),
    fetchSourceRefVouchers(supabase, companyId),
    // A stable `.order('id')` is required: fetchAllRows pages with `.range()`,
    // and PostgREST paging without a deterministic order can skip or repeat
    // rows once a table exceeds one page, which would defeat the hash dedup.
    fetchAllRows<{ sha256_hash: string; journal_entry_id: string | null }>(({ from, to }) =>
      supabase
        .from('document_attachments')
        .select('sha256_hash, journal_entry_id')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  // Stable order across calls: a provider may page its listing differently
  // from one call to the next, and the cursor is "continue after this id".
  const attachments = [...listedAttachments].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  result.total = attachments.length
  const firstAfterCursor = cursor ? attachments.findIndex((a) => a.id > cursor) : 0
  const startIndex = firstAfterCursor === -1 ? attachments.length : firstAfterCursor

  // Index gnubok verifikat by (period, series, number) for in-memory resolution.
  const voucherIndex = buildVoucherIndex(vouchers)

  // (content, verifikat) pairs already archived → idempotent skip set. Keyed
  // on hash + journal entry, NOT hash alone: the same content may back
  // several verifikat and each deserves its own attachment.
  const attachmentKey = (sha256: string, journalEntryId: string) => `${sha256}|${journalEntryId}`
  const seenAttachments = new Set(
    existingAttachments
      .filter((r) => r.journal_entry_id != null)
      .map((r) => attachmentKey(r.sha256_hash, r.journal_entry_id as string)),
  )

  const recordUnmatched = (uploadId: string, voucher: string, date: string) => {
    result.unmatched++
    if (result.unmatchedSamples.length < 20) {
      result.unmatchedSamples.push({ uploadId, voucher, date })
    }
  }

  let refreshedAfterUnauthorized = false

  for (let index = startIndex; index < attachments.length; index++) {
    // Always make progress: at least one attachment per call, then stop at
    // the budget so the route answers well inside the function limit and the
    // caller resumes after the last handled id.
    if (index > startIndex && now() - startedAt >= timeBudgetMs) {
      result.partial = true
      result.nextCursor = attachments[index - 1].id
      break
    }
    const attachment = attachments[index]
    result.scanned++
    const ref = attachment.ref

    if (!ref) {
      recordUnmatched(attachment.id, '(unresolved)', '')
      continue
    }

    const journalEntryId = resolveDatedRef(voucherIndex, periods, ref)

    if (!journalEntryId) {
      recordUnmatched(attachment.id, `${ref.series}${ref.number}`, ref.date)
      continue
    }

    if (dryRun) {
      // We can resolve the target without spending a download: count it as a
      // would-link so the preview reflects the real plan.
      result.linked++
      continue
    }

    const importAttachment = async () => {
      const { bytes, contentType } = await source().download(attachment.id)

      const sha256 = await computeSHA256(bytes)
      if (seenAttachments.has(attachmentKey(sha256, journalEntryId))) {
        result.skipped++
        return
      }

      // Trust the bytes over provider metadata: APIs occasionally declare the
      // wrong content type (a JPEG stored as image/png), which
      // would fail magic validation. Sniff the real format first and fall
      // back to the declared type only when no signature is recognised; if
      // neither yields an allowed type, store without a declared type so
      // uploadDocument skips magic validation rather than rejecting.
      const declaredType = normalizedContentType(
        attachment.declaredContentType ?? contentType,
      )
      const sniffedType = detectFileMagic(new Uint8Array(bytes))
      const effectiveType =
        sniffedType ??
        (declaredType && ALLOWED_DOCUMENT_TYPES.includes(declaredType)
          ? declaredType
          : undefined)

      await uploadDocument(
        supabase,
        userId,
        companyId,
        {
          name: fileNameFor(attachment, ref, effectiveType ?? declaredType),
          buffer: bytes,
          type: effectiveType,
        },
        {
          upload_source: 'api',
          journal_entry_id: journalEntryId,
          idempotency_key: journalEntryId,
          // Already booked: the verifikat is the booking. No model pass.
          extractionOwner: 'none',
        },
      )

      seenAttachments.add(attachmentKey(sha256, journalEntryId))
      result.linked++
    }

    try {
      await importAttachment()
    } catch (error) {
      let finalError = error
      if (
        provider === 'fortnox' &&
        error instanceof FortnoxApiError &&
        error.statusCode === 401 &&
        !refreshedAfterUnauthorized
      ) {
        refreshedAfterUnauthorized = true
        try {
          resolved = await resolveConsent(companyId, consentId)
          await importAttachment()
          continue
        } catch (retryError) {
          finalError = retryError
        }
      }

      if (provider === 'fortnox' && isFortnoxPermissionError(finalError)) {
        throw new FortnoxDocumentScopesRequiredError()
      }

      result.failed++
      log.error('failed to import a receipt', finalError as Error, {
        uploadId: attachment.id,
        voucher: `${ref.series}${ref.number}`,
      })
    }
  }

  log.info('document import complete', {
    companyId,
    dryRun,
    cursor,
    total: result.total,
    scanned: result.scanned,
    linked: result.linked,
    skipped: result.skipped,
    unmatched: result.unmatched,
    failed: result.failed,
    partial: result.partial,
    nextCursor: result.nextCursor,
    elapsedMs: now() - startedAt,
  })

  return result
}
