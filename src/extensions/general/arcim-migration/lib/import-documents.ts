/**
 * Provider document (underlag) import: best-effort, re-runnable.
 *
 * The migration imports the GL via SIE and the entity registers via the
 * provider API, but the receipts/underlag attached to each verifikat are not
 * carried by either. This step closes that gap for Bokio and Fortnox: it
 * resolves each receipt's target Accounted verifikat from the SIE-preserved
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
 *  - Never adds to a verifikat that already carries underlag from another
 *    path (the underlag wizard, an API client, a manual upload): those are
 *    skipped without a download. Only this import's own earlier files let a
 *    re-run continue on a verifikat.
 *  - A file links only to the live (posted) copy of its verifikat, never to
 *    a reversed one: the registration linker's rule (isLiveCopy). An SIE
 *    re-sync of a year leaves a reversed copy of every verifikat beside the
 *    live one under the same source ref, and counting that copy left every
 *    file of a re-synced year unmatched. A ref that only reversed copies
 *    carry, or that several live ones carry, stays unmatched with its reason.
 *  - A Bokio receipt links only when Bokio's entry date equals the
 *    verifikat's date; a mismatch is reported as unmatched.
 *  - A receipt whose verifikat sits in a klarmarkerat or locked fiscal year
 *    is reported as locked, without a download: the period-lock trigger
 *    would refuse the link, so it is not a failure a retry could fix. The
 *    exception is a verifikat an earlier run already put files on (the year
 *    was locked after it): there the content tells a file that is already
 *    on it (skipped) from one still missing (locked).
 *  - Best-effort: a per-receipt failure is counted and logged, never thrown,
 *    so one bad download can't abort the sweep. A refusal of the connection
 *    itself is not per-receipt: a Fortnox 401 that a real token refresh
 *    cannot outlive, or a Bokio token it no longer accepts, stops the sweep
 *    once (ProviderConnectionRefusedError) instead of failing every file left.
 *
 * Driven from its own /import-documents route rather than the migration's
 * critical path: provider document APIs are rate-limited and a full sweep can
 * issue hundreds of download calls. Fortnox requires archive and connectfile
 * scopes; existing consents must reconnect before this import can run.
 *
 * Fortnox keeps underlag in two places: on the verifikat (voucher file
 * connections) and on the supplier invoice (supplier-invoice file
 * connections). The second is where a scanned leverantörsfaktura lives, so
 * reading only the first left every supplier-invoice verifikat (the D series
 * by default) without its invoice (crm#1146, PH 176). A supplier-invoice file
 * is linked to the verifikat that booked the invoice, which Fortnox names on
 * the invoice (series, number, financial year) and the SIE import preserved
 * as the source ref: the same resolution as a voucher file. That source is
 * additive: a refusal on it (scope or licence) is reported in
 * `unreachableSources` and never stops the voucher files.
 *
 * A third Fortnox source is the customer invoice itself (#165): each invoice
 * the migration imported from this Fortnox account gets Fortnox's own PDF of
 * it (the preview action; never print or email), recorded as the invoice's
 * archived copy (an `invoice_deliveries` row with channel 'import') and
 * linked to the verifikat that booked it. That verifikat is the invoice's own
 * link when the migration made one to a live migrated verifikat, otherwise
 * the one Fortnox names on the invoice (VoucherSeries + VoucherNumber +
 * VoucherYear) through the SIE-preserved source ref. When neither singles out
 * one verifikat, or that verifikat already carries underlag from another
 * path, the copy goes on the invoice only: a link to the wrong verifikat
 * could never be undone. The copy is stored unlinked, then held by its
 * delivery, then anchored on the verifikat, so a failed delivery leaves a
 * deletable file that is removed again, never an orphan on a verifikat. A
 * re-render is a new file every time, so idempotency is per invoice, not per
 * content: an invoice that holds its imported copy is skipped before any
 * Fortnox call, and the database keeps one imported copy per invoice.
 * Additive like the supplier-invoice files: a refusal is reported in
 * `unreachableSources` and the other files carry on.
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
import { BokioApiError, BokioClient } from '@/lib/providers/bokio/client'
import {
  fetchBokioUploads,
  fetchBokioVoucherIndex,
  downloadBokioUpload,
  type BokioUpload,
} from '@/lib/providers/bokio/attachments'
import {
  FortnoxApiError,
  FortnoxClient,
  fortnoxApiErrorCode,
  fortnoxErrorMessage,
  isFortnoxPermissionError,
} from '@/lib/providers/fortnox/client'
import {
  downloadFortnoxArchiveFile,
  fetchFortnoxFileConnections,
  fetchFortnoxFinancialYears,
  fetchFortnoxInvoiceBookingVoucher,
  fetchFortnoxInvoicePreview,
  fetchFortnoxSupplierInvoiceBookings,
  fetchFortnoxSupplierInvoiceBookingVoucher,
  fetchFortnoxSupplierInvoiceFileConnections,
  type FortnoxBookingVoucher,
  type FortnoxFinancialYear,
} from '@/lib/providers/fortnox/attachments'
import { providerRefusalReason, type ProviderRefusalReason } from '@/lib/providers/with-provider-call'
import {
  uploadDocument,
  computeSHA256,
  deleteDocument,
  detectFileMagic,
  isArchivedForOwnJournalEntry,
  ALLOWED_DOCUMENT_TYPES,
} from '@/lib/core/documents/document-service'
import {
  buildCopyIndexes,
  fetchFiscalPeriods,
  fetchSourceRefVouchers,
  isLiveCopy,
  resolveLiveDatedRef,
  type UnresolvedRefReason,
} from '@/lib/documents/voucher-ref-resolver'
import {
  fetchInvoicesWithImportedCopy,
  recordImportedInvoiceDelivery,
} from '@/lib/invoices/invoice-deliveries'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ExecutionBudgetExceeded } from '@/lib/http/execution-budget'
import { supportsUnderlagImport } from '@/lib/providers/underlag-import'
import { isPeriodLocked } from '@/lib/documents/underlag-import'
import { createLogger } from '@/lib/logger'
import { linkBasisColumns } from '@/lib/links/stamp'
import { recordDocumentArrival } from '@/lib/intake/arrivals'
import { continuationCursor, type DocumentImportRunSummary } from './document-import-run'
import {
  COPY_REFUSAL_RETRY_AFTER_MS,
  copyRefusalCauses,
  keepCopyRefusals,
  permanentCopyRefusal,
  readCopyRefusals,
  type CopyRefusal,
} from './customer-invoice-copy-refusals'

const log = createLogger('extensions/arcim-migration/import-documents')

export class FortnoxDocumentScopesRequiredError extends Error {
  readonly code = 'PROVIDER_DOCUMENT_SCOPES_REQUIRED'

  constructor() {
    super('Fortnox consent lacks archive/connectfile scope: reconnect required')
    this.name = 'FortnoxDocumentScopesRequiredError'
  }
}

/**
 * The provider refused the connection, not one file: a Fortnox token a fresh
 * refresh could not revive (a 401 again, or the grant is gone), or a Bokio
 * integration token it no longer accepts. Every file left would be refused
 * the same way, so the sweep stops at the first one and asks for a reconnect.
 * A run used to try (and log) each remaining file in turn (B11).
 */
export class ProviderConnectionRefusedError extends Error {
  constructor(
    readonly provider: string,
    /** PROVIDER_AUTH_EXPIRED: the token is dead. PROVIDER_RESOURCE_FORBIDDEN: it lacks the right. */
    readonly code: 'PROVIDER_AUTH_EXPIRED' | 'PROVIDER_RESOURCE_FORBIDDEN',
    readonly providerStatus: number,
  ) {
    super(`${provider} refused the connection (${providerStatus}): reconnect required`)
    this.name = 'ProviderConnectionRefusedError'
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
   * The unfinished run the server keeps for this company. A continuation
   * starts no earlier than the point that run reached (continuationCursor),
   * so a slice the tab retries after losing its answer is not run twice.
   */
  savedRun?: Pick<DocumentImportRunSummary, 'provider' | 'complete' | 'nextCursor'> | null
  /**
   * Wall-clock budget for the attachment sweep of this call, counted after
   * the listing. Once spent, the sweep stops after the attachment in flight
   * and reports `nextCursor`. The budget sets how often the UI's "x of y"
   * moves, so it stays short; listing + one slice sits far under the hosted
   * 300 s function limit.
   */
  timeBudgetMs?: number
  /**
   * Also stop the sweep at this moment (on `now`'s clock), whichever comes
   * first. The server's continuation (document-import-continuation.ts) sweeps
   * until its function's deadline instead of 30 s: a large Fortnox listing
   * alone takes about two minutes, paid again by every slice (crm#1581).
   */
  sweepDeadline?: number
  /** A server continuation re-checks the run and connection between files. */
  shouldContinue?: () => Promise<boolean>
  /** Clock, injectable for tests. */
  now?: () => number
}

export const DEFAULT_IMPORT_DOCUMENTS_TIME_BUDGET_MS = 30_000

export interface ImportDocumentsResult {
  provider: string
  /** Provider attachments linked to a voucher that were considered. */
  scanned: number
  /**
   * Files newly archived: receipts linked to their verifikat, and customer
   * invoice copies on their invoice (customerInvoicePdfs tells how many of
   * those also reached the verifikat).
   */
  linked: number
  /**
   * Receipts already archived for this verifikat (sha256 + journal entry
   * match: re-run skip), or whose verifikat already carries underlag from
   * another path (left untouched).
   */
  skipped: number
  /** Attachments whose provider voucher resolved to no Accounted verifikat. */
  unmatched: number
  /** Receipts that failed to download/validate/store (counted, not thrown). */
  failed: number
  /**
   * Receipts whose verifikat sits in a closed (klarmarkerat) or locked fiscal
   * year. enforce_period_lock_documents refuses those links, so they are
   * neither downloaded nor written, and never counted as failed: retrying
   * cannot help until the year is reopened.
   */
  locked: number
  /** The fiscal years behind `locked` ("2024", "2022/2023"), oldest first. */
  lockedPeriods: string[]
  dryRun: boolean
  /** A few unmatched voucher labels, to aid diagnosis without dumping all. */
  unmatchedSamples: { uploadId: string; voucher: string; date: string; reason: UnmatchedReason }[]
  /** Provider attachments linked to a voucher in total (all calls). */
  total: number
  /** True when the time budget ran out before the end of the list. */
  partial: boolean
  /** Last handled attachment id; pass back as `cursor` to continue. Null when complete. */
  nextCursor: string | null
  /**
   * The customer invoice copies among the counts above (Fortnox), so the UI
   * can say where they went. Absent from providers without the source.
   */
  customerInvoicePdfs?: CustomerInvoiceCopyCounts
  /**
   * Attachment sources the provider refused in this call, with the scope the
   * refused call needs, so the UI can name it. Empty when every source answered.
   */
  unreachableSources: UnreachableAttachmentSource[]
}

/** Why an attachment was counted as unmatched. */
export type UnmatchedReason =
  /** The provider names no verifikat, or none in a financial year it lists. */
  | 'no_voucher_ref'
  /** Bokio dates the entry otherwise than the verifikat the ref found. */
  | 'date_mismatch'
  | UnresolvedRefReason

/**
 * Customer invoice copies (Fortnox's PDF of each imported invoice). Each one
 * is also in the general counts: linked and invoiceOnly in `linked`, skipped,
 * locked and failed in theirs.
 */
export interface CustomerInvoiceCopyCounts {
  /** Imported invoices considered. */
  scanned: number
  /** Archived on the invoice and on the verifikat that booked it. */
  linked: number
  /**
   * Archived on the invoice only: no verifikat could be singled out for
   * certain, or it already carries underlag from another path.
   */
  invoiceOnly: number
  /** The invoice already holds its imported copy (an earlier run). */
  skipped: number
  /** The verifikat sits in a closed or locked year: not fetched. */
  locked: number
  /** Could not be fetched or stored (counted, not thrown). */
  failed: number
  /**
   * Among `failed`: Fortnox answered that it will not hand this invoice out
   * (a client error on the one invoice), in this run or in an earlier one
   * that is still remembered (customer-invoice-copy-refusals.ts). Asking
   * again does not help, so these are not asked on every run.
   */
  refused: number
}

/** Fortnox scopes behind the document import (Fortnox's scope table). */
export type FortnoxDocumentScope = 'archive' | 'connectfile' | 'supplierinvoice' | 'invoice'

export interface UnreachableAttachmentSource {
  /**
   * supplier_invoice_files: files Fortnox keeps on supplier invoices (not on
   * the verifikat). customer_invoice_files: the customer invoices' own PDFs.
   */
  source: 'supplier_invoice_files' | 'customer_invoice_files'
  /** The scope the refused call needs. */
  scope: FortnoxDocumentScope
  /**
   * license: the Fortnox company lacks the module. permission: the connection
   * lacks the right. error: Fortnox failed otherwise (a retry may help).
   */
  reason: ProviderRefusalReason | 'error'
  /** What Fortnox itself answered, when it said anything. */
  providerMessage: string | null
}

type AttachmentRef = { series: string; number: number; date: string; dateTo?: string }

interface ProviderAttachment {
  /** Unique per attachment: the sweep's sort key and resume cursor. */
  id: string
  /** The provider file to download; the id itself when absent. */
  fileId?: string
  /** A Fortnox supplier-invoice file, linked through the invoice's booking voucher. */
  supplierInvoiceNumber?: string
  fileName: string | null
  fileNameIsBaseName: boolean
  declaredContentType: string | null
  ref: AttachmentRef | null
  /** The ref needs one more provider read (resolveRef) before it is known. */
  refPending?: boolean
  /** A migrated customer invoice whose own PDF the sweep archives (Fortnox). */
  customerInvoice?: CustomerInvoiceCopy
}

/** A customer invoice the migration imported from Fortnox. */
interface CustomerInvoiceCopy {
  invoiceId: string
  /** Fortnox's DocumentNumber: the preview's key and the printed number. */
  documentNumber: string
  /** The registration verifikat the migration linked, when it did. */
  journalEntryId: string | null
  /** The invoice already holds its imported copy: skipped before any call. */
  archived: boolean
}

/** Why a customer invoice copy went on the invoice only (logged, not shown). */
type InvoiceOnlyReason =
  | 'no_voucher_ref'
  | UnresolvedRefReason
  /** The verifikat already carries underlag from another path (crm#200). */
  | 'other_underlag'
  /** The delivery holds the copy, but the verifikat link was refused. */
  | 'anchor_failed'

interface ProviderAttachmentListing {
  attachments: ProviderAttachment[]
  unreachable: UnreachableAttachmentSource[]
}

interface ProviderAttachmentSource {
  list(): Promise<ProviderAttachmentListing>
  download(attachment: ProviderAttachment): Promise<{ bytes: ArrayBuffer; contentType: string | null }>
  /** Resolve a `refPending` attachment; null when the provider names no verifikat. */
  resolveRef?(attachment: ProviderAttachment): Promise<AttachmentRef | null>
}

function unreachableFrom(
  scope: FortnoxDocumentScope,
  error: unknown,
  source: UnreachableAttachmentSource['source'] = 'supplier_invoice_files',
): UnreachableAttachmentSource {
  return {
    source,
    scope,
    reason: isFortnoxPermissionError(error) ? providerRefusalReason(error) : 'error',
    providerMessage: fortnoxErrorMessage(error),
  }
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

/** "2024" for a calendar year, "2022/2023" for a broken or extended one. */
function fiscalYearLabel(period: { period_start: string; period_end: string }): string {
  const startYear = period.period_start.slice(0, 4)
  const endYear = period.period_end.slice(0, 4)
  return startYear === endYear ? startYear : `${startYear}/${endYear}`
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

      const attachments = uploads
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
      return { attachments, unreachable: [] }
    },
    download(attachment) {
      return downloadBokioUpload(client, accessToken, providerCompanyId, attachment.fileId ?? attachment.id)
    },
  }
}

/**
 * A Fortnox voucher pinned to its financial year, as the resolver wants it:
 * the year's window, never a calendar guess. An unknown year id is no ref.
 */
function fortnoxRef(
  voucher: { series: string; number: number; financialYearId: number },
  financialYearById: Map<number, FortnoxFinancialYear>,
): AttachmentRef | null {
  const financialYear = financialYearById.get(voucher.financialYearId)
  return financialYear
    ? {
        series: voucher.series,
        number: voucher.number,
        date: financialYear.fromDate,
        dateTo: financialYear.toDate,
      }
    : null
}

/** Same voucher, same file: the key both Fortnox registers are deduplicated on. */
function fortnoxFileVoucherKey(fileId: string, voucher: FortnoxBookingVoucher): string {
  return `${fileId}|${voucher.financialYearId}|${voucher.series.trim().toUpperCase()}|${voucher.number}`
}

/**
 * Keeps a supplier-invoice attachment's id apart from the bare file id of a
 * voucher attachment, and in practice sorts it after Fortnox's file ids
 * (UUIDs), so voucher files run first. Nothing relies on that order.
 */
const SUPPLIER_INVOICE_ATTACHMENT_PREFIX = 'si:'

/** A customer invoice copy's id: apart from file ids and supplier-invoice files. */
const CUSTOMER_INVOICE_ATTACHMENT_PREFIX = 'ci:'

/**
 * Invoice statuses that were never issued: a draft (Fortnox neither sent nor
 * booked it) and a cancelled one. There is no issued invoice to keep a copy
 * of, and a copy would put a 'sent' delivery on an invoice nobody received.
 */
const NEVER_ISSUED_INVOICE_STATUSES = new Set(['draft', 'cancelled'])

/** PostgREST puts `.in()` lists in the URL, so invoice ids are read in chunks. */
const INVOICE_ID_CHUNK = 200

/** The reference an imported copy's delivery carries: unique per invoice. */
function importedCopyReference(copy: CustomerInvoiceCopy): string {
  return `invoice:${copy.documentNumber}:${copy.invoiceId}`
}

function fortnoxSource(
  client: FortnoxClient,
  accessToken: () => string,
  supabase: SupabaseClient,
  companyId: string,
  /** The migration's account key for this connection (migration_source_records.account_key). */
  accountKey: string,
): ProviderAttachmentSource {
  // Read by resolveRef on later attachments of the same call.
  let financialYearById = new Map<number, FortnoxFinancialYear>()

  /**
   * The register's list form, read as an index of booking vouchers, or null
   * when Fortnox did not answer it. The index only saves calls: an invoice it
   * does not name is asked on its own detail form (resolveRef), which names
   * the booking voucher by definition. So a list that failed for a reason a
   * retry may cure (a timeout, a 5xx) turns every file's booking into that
   * question instead of dropping the files. It used to drop them: a large
   * register's list timed out on 3 of 65 slices over three runs, and each
   * such slice ended its run with its supplier-invoice files unreached
   * (crm#1642). A refusal still propagates: the detail form would be refused
   * the same way, and the caller names the scope.
   */
  const supplierInvoiceBookingIndex = async () => {
    try {
      return await fetchFortnoxSupplierInvoiceBookings(client, accessToken())
    } catch (error) {
      if (isFortnoxPermissionError(error) || error instanceof ExecutionBudgetExceeded) throw error
      log.warn('fortnox supplier-invoice list not read: each file asks its invoice instead', {
        providerStatus: error instanceof FortnoxApiError ? error.statusCode : undefined,
        providerMessage: fortnoxErrorMessage(error),
        reason: error instanceof Error ? error.name : 'unknown',
      })
      return null
    }
  }

  /**
   * Files on supplier invoices, linked through each invoice's booking
   * voucher. Additive to the voucher files: any refusal or failure here is
   * reported and the voucher files carry on, because this source must never
   * take away what the voucher sweep already delivers.
   */
  const supplierInvoiceAttachments = async (
    voucherFileKeys: Set<string>,
  ): Promise<ProviderAttachmentListing> => {
    let scope: FortnoxDocumentScope = 'connectfile'
    try {
      const connections = await fetchFortnoxSupplierInvoiceFileConnections(client, accessToken())
      if (connections.length === 0) return { attachments: [], unreachable: [] }

      scope = 'supplierinvoice'
      const bookings = await supplierInvoiceBookingIndex()

      const attachments: ProviderAttachment[] = []
      for (const connection of connections) {
        const booking = bookings?.get(connection.givenNumber) ?? { state: 'unknown' as const }
        // A file on an unbooked or cancelled invoice has no verifikat to sit
        // on, so it is not an attachment "linked to a voucher" (the listing's
        // definition, as Bokio uploads without a journal entry).
        if (booking.state === 'unbooked') continue
        if (
          booking.state === 'booked' &&
          voucherFileKeys.has(fortnoxFileVoucherKey(connection.fileId, booking.voucher))
        ) {
          continue
        }
        attachments.push({
          id: `${SUPPLIER_INVOICE_ATTACHMENT_PREFIX}${connection.givenNumber}:${connection.fileId}`,
          fileId: connection.fileId,
          supplierInvoiceNumber: connection.givenNumber,
          fileName: connection.name,
          fileNameIsBaseName: false,
          declaredContentType: null,
          ref: booking.state === 'booked' ? fortnoxRef(booking.voucher, financialYearById) : null,
          refPending: booking.state === 'unknown',
        })
      }
      return { attachments, unreachable: [] }
    } catch (error) {
      log.error('fortnox supplier-invoice files not listed', error as Error, {
        scope,
        providerStatus: error instanceof FortnoxApiError ? error.statusCode : undefined,
        providerMessage: fortnoxErrorMessage(error),
      })
      return { attachments: [], unreachable: [unreachableFrom(scope, error)] }
    }
  }

  /**
   * One attachment per customer invoice this Fortnox account's migration
   * imported: the invoice's own PDF. Read from the migration's source records,
   * so a native invoice, or one from another connection, is never touched.
   * Read from the database alone; the invoices that already hold their
   * imported copy are marked so the sweep skips them without a Fortnox call.
   * Additive like the supplier-invoice files: a failure is reported and the
   * other files carry on.
   */
  const customerInvoiceAttachments = async (): Promise<ProviderAttachmentListing> => {
    try {
      const sourceRecords = await fetchAllRows<{ id: string; source_id: string; target_id: string }>(
        ({ from, to }) =>
          supabase
            .from('migration_source_records')
            .select('id, source_id, target_id')
            .eq('company_id', companyId)
            .eq('provider', 'fortnox')
            .eq('account_key', accountKey)
            .eq('resource', 'salesInvoices')
            .order('id', { ascending: true })
            .range(from, to),
      )
      if (sourceRecords.length === 0) return { attachments: [], unreachable: [] }

      const documentNumberByInvoice = new Map(
        sourceRecords.map((record) => [record.target_id, String(record.source_id).trim()]),
      )
      const invoiceIds = [...documentNumberByInvoice.keys()]
      const invoices: { id: string; status: string | null; journal_entry_id: string | null }[] = []
      for (let index = 0; index < invoiceIds.length; index += INVOICE_ID_CHUNK) {
        const chunk = invoiceIds.slice(index, index + INVOICE_ID_CHUNK)
        invoices.push(
          ...(await fetchAllRows<{ id: string; status: string | null; journal_entry_id: string | null }>(
            ({ from, to }) =>
              supabase
                .from('invoices')
                .select('id, status, journal_entry_id')
                .eq('company_id', companyId)
                .in('id', chunk)
                .order('id', { ascending: true })
                .range(from, to),
          )),
        )
      }
      const archived = await fetchInvoicesWithImportedCopy(companyId)

      const attachments: ProviderAttachment[] = []
      for (const invoice of invoices) {
        if (invoice.status && NEVER_ISSUED_INVOICE_STATUSES.has(invoice.status)) continue
        const documentNumber = documentNumberByInvoice.get(invoice.id) ?? ''
        if (!/^\d+$/.test(documentNumber)) continue
        attachments.push({
          id: `${CUSTOMER_INVOICE_ATTACHMENT_PREFIX}${documentNumber}`,
          fileName: `Faktura ${documentNumber}.pdf`,
          fileNameIsBaseName: false,
          declaredContentType: 'application/pdf',
          ref: null,
          customerInvoice: {
            invoiceId: invoice.id,
            documentNumber,
            journalEntryId: invoice.journal_entry_id,
            archived: archived.has(invoice.id),
          },
        })
      }
      return { attachments, unreachable: [] }
    } catch (error) {
      if (error instanceof ExecutionBudgetExceeded) throw error
      log.error('fortnox customer invoices not listed', error as Error, {
        providerStatus: error instanceof FortnoxApiError ? error.statusCode : undefined,
        providerMessage: fortnoxErrorMessage(error),
      })
      return { attachments: [], unreachable: [unreachableFrom('invoice', error, 'customer_invoice_files')] }
    }
  }

  return {
    async list() {
      let voucherAttachments: ProviderAttachment[]
      const voucherFileKeys = new Set<string>()
      try {
        const financialYears = await fetchFortnoxFinancialYears(client, accessToken())
        const connections = await fetchFortnoxFileConnections(
          client,
          accessToken(),
          financialYears.map((year) => year.id),
        )
        financialYearById = new Map(financialYears.map((year) => [year.id, year]))

        voucherAttachments = connections.map((connection): ProviderAttachment => {
          voucherFileKeys.add(fortnoxFileVoucherKey(connection.fileId, connection))
          return {
            id: connection.fileId,
            fileName: connection.name,
            fileNameIsBaseName: false,
            declaredContentType: null,
            ref: fortnoxRef(connection, financialYearById),
          }
        })
      } catch (error) {
        if (isFortnoxPermissionError(error)) {
          throw new FortnoxDocumentScopesRequiredError()
        }
        throw error
      }

      const [supplierInvoiceFiles, customerInvoiceCopies] = await Promise.all([
        supplierInvoiceAttachments(voucherFileKeys),
        customerInvoiceAttachments(),
      ])
      return {
        attachments: [
          ...voucherAttachments,
          ...supplierInvoiceFiles.attachments,
          ...customerInvoiceCopies.attachments,
        ],
        unreachable: [...supplierInvoiceFiles.unreachable, ...customerInvoiceCopies.unreachable],
      }
    },
    download(attachment) {
      if (attachment.customerInvoice) {
        return fetchFortnoxInvoicePreview(client, accessToken(), attachment.customerInvoice.documentNumber)
      }
      return downloadFortnoxArchiveFile(client, accessToken(), attachment.fileId ?? attachment.id)
    },
    async resolveRef(attachment) {
      if (attachment.customerInvoice) {
        // The verifikat Fortnox says booked the invoice: series, number and
        // financial year, never the invoice number read as a voucher number.
        const voucher = await fetchFortnoxInvoiceBookingVoucher(
          client,
          accessToken(),
          attachment.customerInvoice.documentNumber,
        )
        return voucher ? fortnoxRef(voucher, financialYearById) : null
      }
      if (!attachment.supplierInvoiceNumber) return null
      const voucher = await fetchFortnoxSupplierInvoiceBookingVoucher(
        client,
        accessToken(),
        attachment.supplierInvoiceNumber,
      )
      return voucher ? fortnoxRef(voucher, financialYearById) : null
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
    savedRun = null,
    timeBudgetMs = DEFAULT_IMPORT_DOCUMENTS_TIME_BUDGET_MS,
    sweepDeadline,
    shouldContinue,
    now = Date.now,
  } = opts
  const startedAt = now()

  let resolved = await resolveConsent(companyId, consentId)
  const provider = resolved.consent.provider as string
  const startCursor = continuationCursor(savedRun, provider, cursor)

  const result: ImportDocumentsResult = {
    provider,
    scanned: 0,
    linked: 0,
    skipped: 0,
    unmatched: 0,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    dryRun,
    unmatchedSamples: [],
    total: 0,
    partial: false,
    nextCursor: null,
    unreachableSources: [],
  }
  const copyCounts: CustomerInvoiceCopyCounts = {
    scanned: 0,
    linked: 0,
    invoiceOnly: 0,
    skipped: 0,
    locked: 0,
    failed: 0,
    refused: 0,
  }
  if (provider === 'fortnox') result.customerInvoicePdfs = copyCounts

  // Unsupported providers are a no-op rather than an error
  // so a mixed-provider caller can invoke this unconditionally. The migration
  // UI offers the import from the same definition.
  if (!supportsUnderlagImport(provider)) {
    log.info('document import skipped: provider not supported', { provider })
    return result
  }

  const bokioClient = provider === 'bokio' ? new BokioClient() : null
  // One Fortnox source per call: it keeps the financial years its listing read
  // for resolveRef, and reads the token on every request, so a refresh after
  // a 401 reaches it.
  // The account key the migration recorded its source records under: the
  // connection's organisation number, else the provider's company id (as the
  // migration job worker derives it).
  const fortnoxAccountKey =
    String(resolved.consent.org_number ?? '').replace(/[^a-z0-9]/gi, '') || resolved.providerCompanyId || ''
  const fortnox =
    provider === 'fortnox'
      ? fortnoxSource(new FortnoxClient(), () => resolved.accessToken, supabase, companyId, fortnoxAccountKey)
      : null
  const source = (): ProviderAttachmentSource =>
    provider === 'bokio'
      ? bokioSource(bokioClient as BokioClient, resolved)
      : (fortnox as ProviderAttachmentSource)

  // The token a refresh after a Fortnox 401 handed out. A 401 on that very
  // token means the grant itself is gone, not that the token aged out.
  let tokenFromRefresh: string | null = null
  // Whatever stopped that refresh: a dead grant (PROVIDER_AUTH_EXPIRED), a
  // provider blink, a timeout. Every file left would meet the same dead token.
  let refreshFailure: unknown = undefined
  /**
   * Errors that end the sweep instead of counting one file as failed: a
   * refused connection, or a refresh that failed (the route answers it, and
   * the page retries a blink as a whole slice).
   */
  const stopsTheSweep = (error: unknown): boolean =>
    error instanceof ProviderConnectionRefusedError || (refreshFailure !== undefined && error === refreshFailure)
  const refusal = (error: unknown): ProviderConnectionRefusedError | null => {
    if (provider === 'fortnox' && error instanceof FortnoxApiError && error.statusCode === 401) {
      return new ProviderConnectionRefusedError(provider, 'PROVIDER_AUTH_EXPIRED', 401)
    }
    // Bokio tokens never expire and cannot be refreshed: a refusal is final.
    if (provider === 'bokio' && error instanceof BokioApiError && (error.statusCode === 401 || error.statusCode === 403)) {
      return new ProviderConnectionRefusedError(
        provider,
        error.statusCode === 401 ? 'PROVIDER_AUTH_EXPIRED' : 'PROVIDER_RESOURCE_FORBIDDEN',
        error.statusCode,
      )
    }
    return null
  }
  /**
   * Runs a provider call; after a Fortnox 401 it refreshes the token for real
   * and runs the call once more. The refresh used to re-read the consent, which
   * refreshes only once our clock says the token expired: Fortnox retires it a
   * moment earlier, so the re-read handed the same dead token back and every
   * file left in the slice failed (one 401 burst per hour of a long run, B11).
   * A 401 that a fresh token cannot outlive is a refused connection.
   */
  const withUnauthorizedRefresh = async <T,>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (error) {
      const refused = refusal(error)
      if (!refused) throw error
      if (provider !== 'fortnox' || tokenFromRefresh === resolved.accessToken) throw refused
      try {
        resolved = await resolveConsent(companyId, consentId, { rejectedAccessToken: resolved.accessToken })
      } catch (refreshError) {
        refreshFailure = refreshError
        throw refreshError
      }
      tokenFromRefresh = resolved.accessToken
      try {
        return await call()
      } catch (retryError) {
        throw refusal(retryError) ?? retryError
      }
    }
  }

  // ── Bulk reads (one round of paged requests each, no per-item N+1) ──
  const [listing, periods, vouchers, existingAttachments] = await Promise.all([
    withUnauthorizedRefresh(() => source().list()),
    fetchFiscalPeriods(supabase, companyId),
    fetchSourceRefVouchers(supabase, companyId),
    // A stable `.order('id')` is required: fetchAllRows pages with `.range()`,
    // and PostgREST paging without a deterministic order can skip or repeat
    // rows once a table exceeds one page, which would defeat the hash dedup.
    fetchAllRows<{
      id: string
      sha256_hash: string
      journal_entry_id: string | null
      upload_source: string | null
    }>(({ from, to }) =>
      supabase
        .from('document_attachments')
        .select('id, sha256_hash, journal_entry_id, upload_source')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  // Stable order across calls: a provider may page its listing differently
  // from one call to the next, and the cursor is "continue after this id".
  const attachments = [...listing.attachments].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  result.total = attachments.length
  result.unreachableSources = [...listing.unreachable]
  const firstAfterCursor = startCursor ? attachments.findIndex((a) => a.id > startCursor) : 0
  const startIndex = firstAfterCursor === -1 ? attachments.length : firstAfterCursor

  // Index Accounted verifikat by (period, series, number) for in-memory
  // resolution, the live copies apart from the reversed ones (isLiveCopy).
  const voucherCopies = buildCopyIndexes(vouchers)
  const entryDateById = new Map(vouchers.map((v) => [v.id, v.entry_date]))
  const periodIdByEntry = new Map(vouchers.map((v) => [v.id, v.fiscal_period_id]))
  const periodById = new Map(periods.map((p) => [p.id, p]))
  const lockedPeriodIds = new Set<string>()

  // Verifikat that already carry underlag from another path: the underlag
  // wizard, an API client, a manual upload. The import never adds to them. A
  // linked file is permanent (BFL 7 kap 2§), so the provider's copy of a
  // receipt the user already attached in other bytes could never be removed
  // again (crm#200). This import's own earlier files do not count: they are
  // upload_source 'api' with the verifikat-keyed id, and a re-run must still
  // reach the rest of a verifikat that has several provider files.
  const verifikatWithOtherUnderlag = new Set<string>()
  // Verifikat this import's earlier runs already put files on.
  const verifikatWithOwnUnderlag = new Set<string>()
  for (const row of existingAttachments) {
    if (!row.journal_entry_id || verifikatWithOtherUnderlag.has(row.journal_entry_id)) continue
    const archivedByThisImport =
      row.upload_source === 'api' && (await isArchivedForOwnJournalEntry(companyId, row))
    if (archivedByThisImport) verifikatWithOwnUnderlag.add(row.journal_entry_id)
    else verifikatWithOtherUnderlag.add(row.journal_entry_id)
  }

  // (content, verifikat) pairs already archived → idempotent skip set. Keyed
  // on hash + journal entry, NOT hash alone: the same content may back
  // several verifikat and each deserves its own attachment.
  const attachmentKey = (sha256: string, journalEntryId: string) => `${sha256}|${journalEntryId}`
  const seenAttachments = new Map(
    existingAttachments
      .filter((r) => r.journal_entry_id != null)
      .map((r) => [attachmentKey(r.sha256_hash, r.journal_entry_id as string), r.id]),
  )
  // Content an earlier run archived on a copy a re-run migration has since
  // reversed (#51). The run before the re-run recorded each Bokio upload
  // against that document, and record_bokio_upload keeps an upload's first
  // document, so it refuses the live copy's document for the same upload.
  const reversedEntryIds = new Set(vouchers.filter((voucher) => !isLiveCopy(voucher)).map((voucher) => voucher.id))
  const contentOnReversedCopy = new Set(
    existingAttachments
      .filter((row) => row.journal_entry_id != null && reversedEntryIds.has(row.journal_entry_id))
      .map((row) => row.sha256_hash),
  )
  const recordUpload = async (uploadId: string, documentId: string, sha256: string) => {
    if (provider !== 'bokio') return
    const { error } = await supabase.rpc('record_bokio_upload', {
      p_company_id: companyId, p_consent_id: consentId, p_upload_id: uploadId, p_document_id: documentId,
    })
    if (!error) return
    // The file is on its live verifikat already; the upload keeps naming the
    // same content on the reversed copy. Counting it failed would make every
    // run after a re-run report these files as missing.
    if (error.message?.includes('BOKIO_UPLOAD_IDENTITY_CONFLICT') && contentOnReversedCopy.has(sha256)) {
      log.info('bokio upload keeps its document on the reversed copy', { uploadId, documentId })
      return
    }
    throw new Error('BOKIO_UPLOAD_MAPPING_FAILED')
  }

  const unmatchedByReason: Partial<Record<UnmatchedReason, number>> = {}
  const recordUnmatched = (uploadId: string, voucher: string, date: string, reason: UnmatchedReason) => {
    result.unmatched++
    unmatchedByReason[reason] = (unmatchedByReason[reason] ?? 0) + 1
    if (result.unmatchedSamples.length < 20) {
      result.unmatchedSamples.push({ uploadId, voucher, date, reason })
    }
  }

  // Scopes Fortnox refused for supplier-invoice files in this call: the rest
  // of those files are not tried again (each would be refused the same way),
  // and the refusal is reported once instead of failing the whole sweep.
  const refusedSupplierInvoiceScopes = new Set<FortnoxDocumentScope>()
  const refuseSupplierInvoiceScope = (scope: FortnoxDocumentScope, error: unknown) => {
    if (refusedSupplierInvoiceScopes.has(scope)) return
    refusedSupplierInvoiceScopes.add(scope)
    result.unreachableSources.push(unreachableFrom(scope, error))
    log.warn('fortnox refused supplier-invoice files', {
      scope,
      providerStatus: error instanceof FortnoxApiError ? error.statusCode : undefined,
      providerMessage: fortnoxErrorMessage(error),
    })
  }

  /**
   * Whether this file already sits on its verifikat in a locked year, by its
   * content (the same dedup a re-run does in an open year). A failed download
   * answers no: the year refuses the link either way, so the file stays
   * reported as locked.
   */
  const isArchivedOnLockedVerifikat = async (
    attachment: ProviderAttachment,
    journalEntryId: string,
  ): Promise<boolean> => {
    try {
      const { bytes } = await withUnauthorizedRefresh(() =>
        source().download(attachment),
      )
      const sha256 = await computeSHA256(bytes)
      const archivedId = seenAttachments.get(attachmentKey(sha256, journalEntryId))
      if (!archivedId) return false
      await recordUpload(attachment.id, archivedId, sha256)
      return true
    } catch (error) {
      if (stopsTheSweep(error)) throw error
      log.warn('could not check a file on a locked verifikat', {
        uploadId: attachment.id,
        reason: error instanceof Error ? error.message : 'unknown',
      })
      return false
    }
  }

  // ── Customer invoice copies (Fortnox) ──
  // Live migrated verifikat: the only ones an invoice's own link may hand its
  // copy to (isLiveCopy: never a reversed copy left by an SIE re-sync).
  const liveEntryIds = new Set(vouchers.filter(isLiveCopy).map((voucher) => voucher.id))
  const invoiceOnlyByReason: Partial<Record<InvoiceOnlyReason, number>> = {}
  // A refusal (scope or licence) of the invoice register in this call: the
  // rest of the copies are not tried, and it is reported once.
  let customerInvoiceCopiesRefused = false
  const refuseCustomerInvoiceCopies = (error: unknown) => {
    if (customerInvoiceCopiesRefused) return
    customerInvoiceCopiesRefused = true
    result.unreachableSources.push(unreachableFrom('invoice', error, 'customer_invoice_files'))
    log.warn('fortnox refused customer invoice copies', {
      providerStatus: error instanceof FortnoxApiError ? error.statusCode : undefined,
      providerMessage: fortnoxErrorMessage(error),
    })
  }

  // Copies Fortnox would not hand out (customer-invoice-copy-refusals.ts):
  // the ones an earlier run was told about are counted without a call, the
  // ones this call is told about are kept for the next run. Best effort both
  // ways: without the memory every copy is simply asked, as before.
  const copyRefusalScope = { companyId, userId, accountKey: fortnoxAccountKey }
  let knownCopyRefusals = new Map<string, CopyRefusal>()
  if (provider === 'fortnox' && attachments.some((a) => a.customerInvoice && !a.customerInvoice.archived)) {
    try {
      knownCopyRefusals = await readCopyRefusals(supabase, companyId, fortnoxAccountKey, now())
    } catch (error) {
      log.warn('customer invoice copy refusals not read: every copy is asked', {
        reason: error instanceof Error ? error.message : 'unknown',
      })
    }
  }
  const newCopyRefusals = new Map<string, CopyRefusal>()
  // Invoices that hold their copy by now: a refusal kept for one is dropped.
  const settledCopies = new Set<string>()
  let copyRefusalsUnkept = 0
  const keepNewCopyRefusals = async () => {
    if (dryRun || newCopyRefusals.size === copyRefusalsUnkept) return
    try {
      await keepCopyRefusals(supabase, copyRefusalScope, newCopyRefusals, settledCopies, now())
      copyRefusalsUnkept = newCopyRefusals.size
    } catch (error) {
      log.warn('customer invoice copy refusals not kept: the next run asks them again', {
        reason: error instanceof Error ? error.message : 'unknown',
      })
    }
  }
  /**
   * A failed copy: counted, and when Fortnox's answer is about this one
   * invoice and final, remembered instead of logged. One line per call names
   * the answers (below the sweep); an error per invoice per run said nothing
   * new 297 times in two days.
   */
  const copyFailed = async (copy: CustomerInvoiceCopy, error: unknown, what: string, uploadId: string) => {
    result.failed++
    copyCounts.failed++
    const refused = permanentCopyRefusal(error, now())
    if (!refused) {
      log.error(what, error as Error, {
        uploadId,
        providerStatus: error instanceof FortnoxApiError ? error.statusCode : undefined,
        providerCode: fortnoxApiErrorCode(error),
        providerMessage: fortnoxErrorMessage(error),
      })
      return
    }
    copyCounts.refused++
    newCopyRefusals.set(copy.documentNumber, refused)
    // Kept in batches too, so a sweep that ends on a refused connection
    // still leaves most of what it learned.
    if (newCopyRefusals.size - copyRefusalsUnkept >= 50) await keepNewCopyRefusals()
  }

  /**
   * Remove a copy this call stored before any delivery held it. It is
   * unlinked, so deletable; best effort, because one left behind is only a
   * stray file in the archive's unlinked documents, never on a verifikat.
   */
  const discardUnheldCopy = async (documentId: string) => {
    try {
      const outcome = await deleteDocument(supabase, companyId, documentId)
      if (!outcome.ok) {
        log.warn('unheld invoice copy not discarded', { documentId, reason: outcome.reason })
      }
    } catch (error) {
      log.warn('unheld invoice copy not discarded', {
        documentId,
        reason: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  /**
   * Link a held copy to its verifikat (NULL to the entry, which the
   * document immutability trigger allows). False when the database refused:
   * the copy then stays on the invoice only.
   */
  const anchorCopyOnVerifikat = async (documentId: string, journalEntryId: string): Promise<boolean> => {
    try {
      const { data, error } = await supabase
        .from('document_attachments')
        .update({
          journal_entry_id: journalEntryId,
          // The old system's own copy of the invoice this verifikat booked.
          ...linkBasisColumns('import_carried_over', { source_system: 'provider_migration' }),
        })
        .eq('id', documentId)
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .select('id')
      if (error || !data || data.length === 0) {
        log.warn('invoice copy left on the invoice only: verifikat link refused', {
          documentId,
          journalEntryId,
          reason: error?.message ?? 'no row updated',
        })
        return false
      }
      return true
    } catch (error) {
      log.warn('invoice copy left on the invoice only: verifikat link failed', {
        documentId,
        journalEntryId,
        reason: error instanceof Error ? error.message : 'unknown',
      })
      return false
    }
  }

  const archiveOnInvoiceOnly = (reason: InvoiceOnlyReason) => {
    result.linked++
    copyCounts.invoiceOnly++
    invoiceOnlyByReason[reason] = (invoiceOnlyByReason[reason] ?? 0) + 1
  }

  /**
   * One customer invoice's own PDF: onto the invoice as its archived copy,
   * and onto the verifikat that booked it when exactly one can be named.
   */
  // 'cut' when the hard stop cut this copy in flight and the slice stops
  // before it (cutInFlight in the loop below): the next slice retries it.
  const importCustomerInvoiceCopy = async (
    attachment: ProviderAttachment,
    copy: CustomerInvoiceCopy,
    cutInFlight: (error: unknown) => boolean,
  ): Promise<'cut' | void> => {
    copyCounts.scanned++
    const cut = (error: unknown): boolean => {
      if (!cutInFlight(error)) return false
      copyCounts.scanned--
      return true
    }
    // Idempotent per invoice, not per content: a new preview is a new
    // rendering, so a re-run would otherwise add a second copy that could
    // never be removed. Decided before any Fortnox call.
    if (copy.archived) {
      result.skipped++
      copyCounts.skipped++
      if (knownCopyRefusals.has(copy.documentNumber)) settledCopies.add(copy.documentNumber)
      return
    }
    if (customerInvoiceCopiesRefused) return
    // Fortnox refused this very invoice lately: counted, not asked again.
    if (knownCopyRefusals.has(copy.documentNumber)) {
      result.failed++
      copyCounts.failed++
      copyCounts.refused++
      return
    }

    // Which verifikat the copy may go on: the invoice's own link when the
    // migration made it to a live migrated verifikat (it corroborated the
    // ref with the amount), else the one Fortnox names on the invoice by
    // series, number and financial year. Nothing else, and no guess.
    let journalEntryId: string | null = null
    let invoiceOnlyReason: InvoiceOnlyReason | null = null
    if (copy.journalEntryId && liveEntryIds.has(copy.journalEntryId)) {
      journalEntryId = copy.journalEntryId
    } else {
      // The dry run spends no provider calls past the listing.
      if (dryRun) return
      let ref: AttachmentRef | null
      try {
        ref = await withUnauthorizedRefresh(() => source().resolveRef!(attachment))
      } catch (error) {
        if (cut(error)) return 'cut'
        if (stopsTheSweep(error)) throw error
        if (isFortnoxPermissionError(error)) {
          refuseCustomerInvoiceCopies(error)
          return
        }
        await copyFailed(copy, error, 'failed to read a customer invoice voucher', attachment.id)
        return
      }
      const resolution = ref
        ? resolveLiveDatedRef(voucherCopies, periods, ref)
        : { resolved: false as const, reason: 'no_voucher_ref' as const }
      if (resolution.resolved) journalEntryId = resolution.entryId
      else invoiceOnlyReason = resolution.reason
    }

    if (journalEntryId) {
      // The underlag rule: a klarmarkerat or locked year refuses the link,
      // so the copy waits, undownloaded, until the year is reopened (a copy
      // on the invoice alone now would be skipped by every later run).
      const periodId = periodIdByEntry.get(journalEntryId)
      if (periodId && isPeriodLocked(periodById.get(periodId))) {
        result.locked++
        copyCounts.locked++
        lockedPeriodIds.add(periodId)
        return
      }
      // Never add to a verifikat that carries underlag from another path
      // (crm#200): the copy goes on the invoice only.
      if (verifikatWithOtherUnderlag.has(journalEntryId)) {
        journalEntryId = null
        invoiceOnlyReason = 'other_underlag'
      }
    }

    if (dryRun) {
      result.linked++
      if (journalEntryId) copyCounts.linked++
      else copyCounts.invoiceOnly++
      return
    }

    // A copy this call stored that no delivery holds yet: discarded on any
    // failure before the delivery is recorded.
    let unheldCopyId: string | null = null
    try {
      const { bytes } = await withUnauthorizedRefresh(() => source().download(attachment))
      // Only a PDF is the invoice's copy: an error page or an empty body is not.
      if (detectFileMagic(new Uint8Array(bytes)) !== 'application/pdf') {
        throw new Error('CUSTOMER_INVOICE_PREVIEW_NOT_PDF')
      }
      const sha256 = await computeSHA256(bytes)
      // The same bytes already on that verifikat (this import's or another
      // file) are the copy: the delivery points at them, nothing is stored.
      const alreadyOnVerifikat = journalEntryId
        ? seenAttachments.get(attachmentKey(sha256, journalEntryId))
        : undefined
      let documentId = alreadyOnVerifikat
      if (!documentId) {
        const document = await uploadDocument(
          supabase,
          userId,
          companyId,
          { name: `Faktura ${copy.documentNumber}.pdf`, buffer: bytes, type: 'application/pdf' },
          {
            upload_source: 'api',
            // Unlinked until its delivery holds it. Keyed to the verifikat it
            // is meant for, as this import keys every file, so a later run
            // knows it as its own once it is anchored there.
            ...(journalEntryId ? { idempotency_key: journalEntryId } : {}),
            extractionOwner: 'none',
          },
        )
        documentId = document.id
        unheldCopyId = document.id
      }

      const deliveryId = await recordImportedInvoiceDelivery({
        companyId,
        userId,
        invoiceId: copy.invoiceId,
        provider: 'fortnox',
        providerMessageId: importedCopyReference(copy),
        documentId,
      })
      if (!deliveryId) {
        // Another run archived this invoice's copy in the meantime.
        if (unheldCopyId) await discardUnheldCopy(unheldCopyId)
        unheldCopyId = null
        result.skipped++
        copyCounts.skipped++
        return
      }
      const storedHere = unheldCopyId !== null
      // Held by its delivery now (block_sent_invoice_document_deletion).
      unheldCopyId = null

      let onEntry: string | null = null
      if (!journalEntryId) {
        archiveOnInvoiceOnly(invoiceOnlyReason ?? 'no_voucher_ref')
      } else if (!storedHere || (await anchorCopyOnVerifikat(documentId, journalEntryId))) {
        onEntry = journalEntryId
        seenAttachments.set(attachmentKey(sha256, journalEntryId), documentId)
        result.linked++
        copyCounts.linked++
      } else {
        archiveOnInvoiceOnly('anchor_failed')
      }

      if (storedHere) {
        // How it came in: Fortnox's rendering, fetched by the migration.
        await recordDocumentArrival(supabase, {
          companyId,
          source: 'migration',
          documentId,
          fetchedBy: { type: 'user', user_id: userId, label: `${provider}-migration` },
          sourceMeta: {
            provider,
            provider_attachment_id: attachment.id,
            invoice_id: copy.invoiceId,
            ...(onEntry ? { journal_entry_id: onEntry } : {}),
          },
        })
      }
    } catch (error) {
      if (unheldCopyId) await discardUnheldCopy(unheldCopyId)
      if (cut(error)) return 'cut'
      if (stopsTheSweep(error)) throw error
      if (isFortnoxPermissionError(error)) {
        refuseCustomerInvoiceCopies(error)
        return
      }
      await copyFailed(copy, error, 'failed to import a customer invoice copy', attachment.id)
    }
  }

  // The listing above is paid again by every slice; it must not eat the
  // slice itself (or cut the in-memory dry run short).
  const sweepStartedAt = now()

  for (let index = startIndex; index < attachments.length; index++) {
    if (shouldContinue && !(await shouldContinue())) {
      result.partial = true
      result.nextCursor = index > startIndex ? attachments[index - 1].id : startCursor
      break
    }
    // Always make progress: at least one attachment per call, then stop at
    // the budget so the caller can report progress and resume after the
    // last handled id.
    if (
      index > startIndex &&
      (now() - sweepStartedAt >= timeBudgetMs || (sweepDeadline !== undefined && now() >= sweepDeadline))
    ) {
      result.partial = true
      result.nextCursor = attachments[index - 1].id
      break
    }
    const attachment = attachments[index]
    result.scanned++
    // The hard stop cut this file in flight (crm#1581): that is not a failure
    // of the file. When this slice already moved past other files, stop before
    // it, so the next slice retries it with a full budget. A file that a fresh
    // slice could not finish either is counted failed and passed, as before,
    // so one slow file never holds the run (the server refuses a slice that
    // does not advance).
    const cutInFlight = (error: unknown): boolean => {
      if (!(error instanceof ExecutionBudgetExceeded) || index === startIndex) return false
      result.scanned--
      result.partial = true
      result.nextCursor = attachments[index - 1].id
      return true
    }
    if (attachment.customerInvoice) {
      if ((await importCustomerInvoiceCopy(attachment, attachment.customerInvoice, cutInFlight)) === 'cut') break
      continue
    }
    const isSupplierInvoiceFile = attachment.supplierInvoiceNumber != null
    if (isSupplierInvoiceFile && refusedSupplierInvoiceScopes.has('archive')) continue

    let ref = attachment.ref
    if (attachment.refPending) {
      // The dry run spends no provider calls past the listing: it counts the
      // file as found, and the real run resolves it.
      if (dryRun || refusedSupplierInvoiceScopes.has('supplierinvoice')) continue
      try {
        ref = (await withUnauthorizedRefresh(() => source().resolveRef!(attachment))) ?? null
      } catch (error) {
        if (cutInFlight(error)) break
        if (stopsTheSweep(error)) throw error
        if (provider === 'fortnox' && isFortnoxPermissionError(error)) {
          refuseSupplierInvoiceScope('supplierinvoice', error)
          continue
        }
        result.failed++
        log.error('failed to resolve a supplier invoice voucher', error as Error, {
          uploadId: attachment.id,
        })
        continue
      }
    }

    if (!ref) {
      recordUnmatched(
        attachment.id,
        isSupplierInvoiceFile ? `(supplier invoice ${attachment.supplierInvoiceNumber})` : '(unresolved)',
        '',
        'no_voucher_ref',
      )
      continue
    }

    const target: AttachmentRef = ref
    const resolution = resolveLiveDatedRef(voucherCopies, periods, target)
    if (!resolution.resolved) {
      recordUnmatched(attachment.id, `${target.series}${target.number}`, target.date, resolution.reason)
      continue
    }
    const journalEntryId = resolution.entryId

    // A source that dates the entry itself (Bokio) must agree with the
    // verifikat on that date: the number alone is unique only within a
    // fiscal year, and a wrong link can never be undone.
    if (!target.dateTo && entryDateById.get(journalEntryId)?.slice(0, 10) !== target.date.slice(0, 10)) {
      recordUnmatched(attachment.id, `${target.series}${target.number}`, target.date, 'date_mismatch')
      continue
    }

    if (verifikatWithOtherUnderlag.has(journalEntryId)) {
      result.skipped++
      continue
    }

    // A klarmarkerat or locked year refuses every link (the trigger's own
    // predicate, shared with the filename underlag plan). Checked before the
    // download: a migration whose earlier years were closed first used to
    // spend its whole time budget downloading files the database then refused,
    // and reported them as retryable failures (crm#251).
    const periodId = periodIdByEntry.get(journalEntryId)
    if (periodId && isPeriodLocked(periodById.get(periodId))) {
      // A year locked after an earlier run reached it: the files that run
      // put there are on their verifikat, and a re-run counted every one of
      // them as locked, so a byrå read 154 missing where 5 were (crm#1410).
      // Only such verifikat cost a download, to tell an archived file from a
      // missing one by its hash; the dry run, which downloads nothing, takes
      // them as already there.
      if (verifikatWithOwnUnderlag.has(journalEntryId)) {
        const alreadyArchived = dryRun || (await isArchivedOnLockedVerifikat(attachment, journalEntryId))
        if (alreadyArchived) {
          result.skipped++
          continue
        }
      }
      result.locked++
      lockedPeriodIds.add(periodId)
      continue
    }

    if (dryRun) {
      // We can resolve the target without spending a download: count it as a
      // would-link so the preview reflects the real plan.
      result.linked++
      continue
    }

    const importAttachment = async () => {
      const { bytes, contentType } = await source().download(attachment)

      const sha256 = await computeSHA256(bytes)
      if (seenAttachments.has(attachmentKey(sha256, journalEntryId))) {
        await recordUpload(attachment.id, seenAttachments.get(attachmentKey(sha256, journalEntryId))!, sha256)
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

      const document = await uploadDocument(
        supabase,
        userId,
        companyId,
        {
          name: fileNameFor(attachment, target, effectiveType ?? declaredType),
          buffer: bytes,
          type: effectiveType,
        },
        {
          upload_source: 'api',
          journal_entry_id: journalEntryId,
          // The old system attached this file to the verifikat migrated here.
          linkBasis: linkBasisColumns('import_carried_over', { source_system: 'provider_migration' }),
          idempotency_key: journalEntryId,
          // Already booked: the verifikat is the booking. No model pass.
          extractionOwner: 'none',
        },
      )

      seenAttachments.set(attachmentKey(sha256, journalEntryId), document.id)
      await recordUpload(attachment.id, document.id, sha256)
      // How it came in: the provider's file, fetched by the migration. The
      // document is its own original; best effort, never fails the sweep.
      await recordDocumentArrival(supabase, {
        companyId,
        source: 'migration',
        documentId: document.id,
        fetchedBy: { type: 'user', user_id: userId, label: `${provider}-migration` },
        sourceMeta: { provider, provider_attachment_id: attachment.id, journal_entry_id: journalEntryId },
      })
      result.linked++
    }

    try {
      await withUnauthorizedRefresh(importAttachment)
    } catch (error) {
      if (cutInFlight(error)) break
      if (stopsTheSweep(error)) throw error
      if (provider === 'fortnox' && isFortnoxPermissionError(error)) {
        // A supplier-invoice file is an addition to the voucher files: a
        // refused download stops those files only, and says which scope.
        if (isSupplierInvoiceFile) {
          refuseSupplierInvoiceScope('archive', error)
          continue
        }
        throw new FortnoxDocumentScopesRequiredError()
      }

      result.failed++
      log.error('failed to import a receipt', error as Error, {
        uploadId: attachment.id,
        voucher: `${target.series}${target.number}`,
      })
    }
  }

  // A source that failed for now (not refused: a timeout, a 5xx) left its
  // files out of this listing, so the end of the listing is not the end of
  // the provider's list. The run stays open at the last handled file and the
  // next slice lists again. It used to report the run complete, so a run past
  // its voucher files ended on a failed listing with the supplier-invoice
  // files it had not reached, and the user started over from the top
  // (crm#1642). A slice that moved nothing reads as stalled to both drivers,
  // which retry it from the saved point (bounded), never as a finished run.
  if (!dryRun && !result.partial && result.unreachableSources.some((entry) => entry.reason === 'error')) {
    result.partial = true
    result.nextCursor =
      startIndex < attachments.length ? attachments[attachments.length - 1].id : startCursor
  }

  await keepNewCopyRefusals()
  if (newCopyRefusals.size > 0) {
    // Once per call, with Fortnox's own code and sentence: what is needed to
    // know the cause. No invoice is named.
    log.warn('fortnox would not hand out customer invoice copies: kept, not asked again for a while', {
      companyId,
      refused: newCopyRefusals.size,
      retryAfterDays: COPY_REFUSAL_RETRY_AFTER_MS / 86_400_000,
      causes: copyRefusalCauses(newCopyRefusals.values()),
    })
  }

  result.lockedPeriods = [...lockedPeriodIds]
    .map((id) => periodById.get(id))
    .filter((period): period is NonNullable<typeof period> => period != null)
    .sort((a, b) => (a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : 0))
    .map(fiscalYearLabel)

  log.info('document import complete', {
    companyId,
    dryRun,
    cursor,
    startCursor,
    total: result.total,
    scanned: result.scanned,
    linked: result.linked,
    skipped: result.skipped,
    unmatched: result.unmatched,
    unmatchedByReason,
    failed: result.failed,
    locked: result.locked,
    customerInvoicePdfs: result.customerInvoicePdfs,
    invoiceOnlyByReason,
    partial: result.partial,
    nextCursor: result.nextCursor,
    unreachableScopes: result.unreachableSources.map((s) => `${s.scope}:${s.reason}`),
    elapsedMs: now() - startedAt,
  })

  return result
}
