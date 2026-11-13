import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveConsent } from '@/lib/providers/resolve-consent'
import {
  fetchBokioUploads,
  fetchBokioVoucherIndex,
  downloadBokioUpload,
  type BokioVoucherRef,
} from '@/lib/providers/bokio/attachments'
import { FortnoxApiError } from '@/lib/providers/fortnox/client'
import {
  downloadFortnoxArchiveFile,
  fetchFortnoxFileConnections,
  fetchFortnoxFinancialYears,
  fetchFortnoxInvoiceBookingVoucher,
  fetchFortnoxInvoicePreview,
  type FortnoxFileConnection,
  type FortnoxFinancialYear,
} from '@/lib/providers/fortnox/attachments'
import {
  uploadDocument,
  computeSHA256,
  deleteDocument,
  detectFileMagic,
  isArchivedForOwnJournalEntry,
} from '@/lib/core/documents/document-service'
import {
  fetchInvoicesWithImportedCopy,
  recordImportedInvoiceDelivery,
} from '@/lib/invoices/invoice-deliveries'
import { BokioApiError } from '@/lib/providers/bokio/client'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { importProviderDocuments, ProviderConnectionRefusedError } from '../lib/import-documents'
import { ExecutionBudgetExceeded } from '@/lib/http/execution-budget'

// The Bokio client is constructed but never called directly (the attachments
// module is mocked), so a bare stub avoids touching real config/rate-limiter.
// The error class stays real: a refused Bokio token is told apart by it.
vi.mock('@/lib/providers/bokio/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/bokio/client')>()
  return { ...actual, BokioClient: class {} }
})
vi.mock('@/lib/providers/fortnox/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/fortnox/client')>()
  return { ...actual, FortnoxClient: class {} }
})
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/providers/bokio/attachments', () => ({
  fetchBokioUploads: vi.fn(),
  fetchBokioVoucherIndex: vi.fn(),
  downloadBokioUpload: vi.fn(),
}))
vi.mock('@/lib/providers/fortnox/attachments', () => ({
  fetchFortnoxFinancialYears: vi.fn(),
  fetchFortnoxFileConnections: vi.fn(),
  downloadFortnoxArchiveFile: vi.fn(),
  // Supplier-invoice files have their own suite against Fortnox HTTP shapes
  // (import-documents-fortnox-supplier-invoices.test.ts); here the register is empty.
  fetchFortnoxSupplierInvoiceFileConnections: vi.fn(async () => []),
  fetchFortnoxSupplierInvoiceBookings: vi.fn(async () => new Map()),
  fetchFortnoxSupplierInvoiceBookingVoucher: vi.fn(async () => null),
  fetchFortnoxInvoiceBookingVoucher: vi.fn(async () => null),
  fetchFortnoxInvoicePreview: vi.fn(),
}))
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  fetchInvoicesWithImportedCopy: vi.fn(async () => new Set()),
  recordImportedInvoiceDelivery: vi.fn(),
}))
const { mockRecordDocumentArrival } = vi.hoisted(() => ({ mockRecordDocumentArrival: vi.fn() }))
vi.mock('@/lib/intake/arrivals', () => ({ recordDocumentArrival: mockRecordDocumentArrival }))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
  computeSHA256: vi.fn(),
  deleteDocument: vi.fn(),
  detectFileMagic: vi.fn(),
  isArchivedForOwnJournalEntry: vi.fn(),
  ALLOWED_DOCUMENT_TYPES: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
}))

const mockResolveConsent = vi.mocked(resolveConsent)
const mockFetchUploads = vi.mocked(fetchBokioUploads)
const mockFetchVoucherIndex = vi.mocked(fetchBokioVoucherIndex)
const mockDownload = vi.mocked(downloadBokioUpload)
const mockFetchFortnoxFinancialYears = vi.mocked(fetchFortnoxFinancialYears)
const mockFetchFortnoxFileConnections = vi.mocked(fetchFortnoxFileConnections)
const mockDownloadFortnoxArchiveFile = vi.mocked(downloadFortnoxArchiveFile)
const mockUpload = vi.mocked(uploadDocument)
const mockSha256 = vi.mocked(computeSHA256)
const mockDetectMagic = vi.mocked(detectFileMagic)
const mockArchivedForOwnEntry = vi.mocked(isArchivedForOwnJournalEntry)
const mockInvoiceBookingVoucher = vi.mocked(fetchFortnoxInvoiceBookingVoucher)
const mockInvoicePreview = vi.mocked(fetchFortnoxInvoicePreview)
const mockDeleteDocument = vi.mocked(deleteDocument)
const mockInvoicesWithImportedCopy = vi.mocked(fetchInvoicesWithImportedCopy)
const mockRecordImportedDelivery = vi.mocked(recordImportedInvoiceDelivery)

const COMPANY = 'company-1'
const USER = 'user-1'

/** Supabase mock whose chained `.range()` resolves to the rows for that table. */
function rangeMockSupabase(byTable: Record<string, unknown[]>): SupabaseClient {
  const builder = (table: string) => {
    const node = {
      select: () => node,
      eq: () => node,
      not: () => node,
      in: () => node,
      order: () => node,
      range: () => Promise.resolve({ data: byTable[table] ?? [], error: null }),
    }
    return node
  }
  return { from: (table: string) => builder(table), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as unknown as SupabaseClient
}

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: a Bokio consent.
  mockResolveConsent.mockResolvedValue({
    consent: { provider: 'bokio' },
    accessToken: 'tok',
    providerCompanyId: 'bokio-co',
  } as never)
  // Default: sha256 derived from the bytes so dedup is deterministic.
  mockSha256.mockImplementation(async (buf: ArrayBuffer) => 'sha-' + Buffer.from(buf).toString('utf8'))
  // Default: no recognisable signature, so the declared contentType is used.
  mockDetectMagic.mockReturnValue(null)
  mockUpload.mockResolvedValue({ id: 'doc-1' } as never)
  // Default: no existing document was archived by this import.
  mockArchivedForOwnEntry.mockResolvedValue(false)
})

// A receipt linked to Bokio entry "V33", dated inside FY2021.
const VOUCHER_REF: BokioVoucherRef = { series: 'V', number: 33, date: '2021-03-01' }
// Every row carries the lock columns, as fetchFiscalPeriods selects them:
// a row without them would read as locked under the trigger's predicate.
type PeriodFixture = { id: string; period_start: string; period_end: string; is_closed: boolean; locked_at: string | null }
const PERIODS: PeriodFixture[] = [
  { id: 'fp-2021', period_start: '2021-02-04', period_end: '2021-12-31', is_closed: false, locked_at: null },
]
const GNUBOK_VOUCHERS = [
  { id: 'je-1', fiscal_period_id: 'fp-2021', entry_date: '2021-03-01', source_voucher_series: 'V', source_voucher_number: 33 },
]
const UPLOAD = { id: 'up-1', description: 'Kvitto', contentType: 'application/pdf', journalEntryId: 'bokio-je-1' }
const FORTNOX_YEAR: FortnoxFinancialYear = {
  id: 3,
  fromDate: '2021-02-04',
  toDate: '2021-12-31',
}
const FORTNOX_CONNECTION: FortnoxFileConnection = {
  fileId: 'fortnox-file-1',
  name: 'kvitto.pdf',
  series: 'A',
  number: 12,
  financialYearId: 3,
}

interface ExistingAttachment {
  id: string
  sha256_hash: string
  journal_entry_id: string | null
  upload_source?: string | null
}

function wireBokio(
  opts: { existingAttachments?: ExistingAttachment[]; voucherRef?: BokioVoucherRef } = {},
) {
  mockFetchUploads.mockResolvedValue([UPLOAD] as never)
  mockFetchVoucherIndex.mockResolvedValue(new Map([['bokio-je-1', opts.voucherRef ?? VOUCHER_REF]]))
  mockDownload.mockResolvedValue({ bytes: bytesOf('PDFBYTES'), contentType: 'application/octet-stream' })
  return rangeMockSupabase({
    fiscal_periods: PERIODS,
    journal_entries: GNUBOK_VOUCHERS,
    document_attachments: opts.existingAttachments ?? [],
  })
}

function wireFortnox(
  opts: {
    years?: FortnoxFinancialYear[]
    connections?: FortnoxFileConnection[]
    periods?: typeof PERIODS
    vouchers?: typeof GNUBOK_VOUCHERS
    providerCompanyId?: string
    existingAttachments?: ExistingAttachment[]
  } = {},
) {
  mockResolveConsent.mockResolvedValue({
    consent: { provider: 'fortnox' },
    accessToken: 'fortnox-token',
    providerCompanyId: opts.providerCompanyId,
  } as never)
  mockFetchFortnoxFinancialYears.mockResolvedValue(opts.years ?? [FORTNOX_YEAR])
  mockFetchFortnoxFileConnections.mockResolvedValue(
    opts.connections ?? [FORTNOX_CONNECTION],
  )
  mockDownloadFortnoxArchiveFile.mockResolvedValue({
    bytes: bytesOf('FORTNOX-PDF'),
    contentType: 'application/pdf',
  })
  return rangeMockSupabase({
    fiscal_periods: opts.periods ?? PERIODS,
    journal_entries:
      opts.vouchers ??
      [
        {
          id: 'je-1',
          fiscal_period_id: 'fp-2021',
          entry_date: '2021-03-01',
          source_voucher_series: 'A',
          source_voucher_number: 12,
        },
      ],
    document_attachments: opts.existingAttachments ?? [],
  })
}

describe('importProviderDocuments', () => {
  it('resolves a receipt to its verifikat and archives it linked via upload_source=api', async () => {
    const supabase = wireBokio()

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ provider: 'bokio', scanned: 1, linked: 1, skipped: 0, unmatched: 0, failed: 0 })
    expect(mockUpload).toHaveBeenCalledTimes(1)
    const [, userId, companyId, file, metadata] = mockUpload.mock.calls[0]
    expect(userId).toBe(USER)
    expect(companyId).toBe(COMPANY)
    expect(file).toMatchObject({ name: 'Kvitto.pdf', type: 'application/pdf' })
    // extractionOwner 'none': the file arrives linked to its posted
    // verifikat, so no paid model pass (it was the inline extraction that
    // blew the hosted function budget on a 113-file import).
    expect(metadata).toEqual({
      upload_source: 'api',
      journal_entry_id: 'je-1',
      linkBasis: { link_basis: 'import_carried_over', link_evidence: { source_system: 'provider_migration' } },
      idempotency_key: 'je-1',
      extractionOwner: 'none',
    })
    expect(result).toMatchObject({ total: 1, partial: false, nextCursor: null })
    // How it came in: a 'migration' arrival pointing at the archived document.
    expect(mockRecordDocumentArrival).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY,
      source: 'migration',
      documentId: 'doc-1',
      fetchedBy: { type: 'user', user_id: USER, label: 'bokio-migration' },
      sourceMeta: { provider: 'bokio', provider_attachment_id: 'up-1', journal_entry_id: 'je-1' },
    })
  })

  it('skips a receipt already archived on the same verifikat (sha256 + journal entry idempotency)', async () => {
    const supabase = wireBokio({
      existingAttachments: [
        { id: 'existing-doc', sha256_hash: 'sha-PDFBYTES', journal_entry_id: 'je-1', upload_source: 'api' },
      ],
    })
    mockArchivedForOwnEntry.mockResolvedValue(true)

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 0, skipped: 1 })
    expect(supabase.rpc).toHaveBeenCalledWith('record_bokio_upload', {
      p_company_id: COMPANY, p_consent_id: 'c1', p_upload_id: 'up-1', p_document_id: 'existing-doc',
    })
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockRecordDocumentArrival).not.toHaveBeenCalled()
  })

  it('still archives content already attached to a DIFFERENT verifikat (same contract, several vouchers)', async () => {
    const supabase = wireBokio({
      existingAttachments: [{ id: 'existing-doc', sha256_hash: 'sha-PDFBYTES', journal_entry_id: 'je-other' }],
    })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 1, skipped: 0 })
    expect(mockUpload).toHaveBeenCalledTimes(1)
  })

  describe('a verifikat that already carries underlag from another path (crm#200)', () => {
    it('is left untouched, without a download, when the underlag wizard attached a file', async () => {
      const supabase = wireBokio({
        existingAttachments: [
          { id: 'wizard-doc', sha256_hash: 'sha-MERGED', journal_entry_id: 'je-1', upload_source: 'file_upload' },
        ],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ scanned: 1, linked: 0, skipped: 1, unmatched: 0, failed: 0 })
      expect(mockDownload).not.toHaveBeenCalled()
      expect(mockUpload).not.toHaveBeenCalled()
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('is left untouched when an API client uploaded the file (upload_source api, not keyed to the verifikat)', async () => {
      const supabase = wireBokio({
        existingAttachments: [
          { id: 'script-doc', sha256_hash: 'sha-MERGED', journal_entry_id: 'je-1', upload_source: 'api' },
        ],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 0, skipped: 1 })
      expect(mockArchivedForOwnEntry).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ id: 'script-doc' }))
      expect(mockDownload).not.toHaveBeenCalled()
    })

    it('does not count a wizard file as this import even though it is keyed to the verifikat', async () => {
      const supabase = wireBokio({
        existingAttachments: [
          { id: 'wizard-doc', sha256_hash: 'sha-MERGED', journal_entry_id: 'je-1', upload_source: 'file_upload' },
        ],
      })
      mockArchivedForOwnEntry.mockResolvedValue(true)

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 0, skipped: 1 })
      expect(mockUpload).not.toHaveBeenCalled()
    })

    it('still lets a re-run add the rest of a verifikat whose only files came from this import', async () => {
      const supabase = wireBokio({
        existingAttachments: [
          { id: 'first-upload', sha256_hash: 'sha-FIRST', journal_entry_id: 'je-1', upload_source: 'api' },
        ],
      })
      mockArchivedForOwnEntry.mockResolvedValue(true)

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 1, skipped: 0 })
      expect(mockUpload).toHaveBeenCalledTimes(1)
    })

    it('reports the untouched verifikat as skipped in the dry run, not as a would-link', async () => {
      const supabase = wireBokio({
        existingAttachments: [
          { id: 'wizard-doc', sha256_hash: 'sha-MERGED', journal_entry_id: 'je-1', upload_source: 'file_upload' },
        ],
      })

      const result = await importProviderDocuments({
        supabase, companyId: COMPANY, userId: USER, consentId: 'c1', dryRun: true,
      })

      expect(result).toMatchObject({ dryRun: true, scanned: 1, linked: 0, skipped: 1 })
    })

    it('applies to Fortnox too: the adapter is shared', async () => {
      const supabase = wireFortnox({
        existingAttachments: [
          { id: 'manual-doc', sha256_hash: 'sha-OTHER', journal_entry_id: 'je-1', upload_source: 'file_upload' },
        ],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ provider: 'fortnox', linked: 0, skipped: 1 })
      expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    })

    it('ignores unlinked archive documents', async () => {
      const supabase = wireBokio({
        existingAttachments: [
          { id: 'inbox-doc', sha256_hash: 'sha-OTHER', journal_entry_id: null, upload_source: 'file_upload' },
        ],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 1, skipped: 0 })
    })
  })

  it('does not link a Bokio receipt whose Bokio entry date differs from the verifikat date', async () => {
    // Same fiscal year, series and number, but Bokio dates the entry a day
    // later than the migrated verifikat: not provably the same voucher.
    const supabase = wireBokio({ voucherRef: { series: 'V', number: 33, date: '2021-03-02' } })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1, failed: 0 })
    expect(result.unmatchedSamples[0]).toMatchObject({ voucher: 'V33', date: '2021-03-02' })
    expect(mockDownload).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('accepts a Bokio entry date that carries a time part', async () => {
    const supabase = wireBokio({ voucherRef: { series: 'V', number: 33, date: '2021-03-01T00:00:00' } })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ linked: 1, unmatched: 0 })
  })

  it('counts a receipt as unmatched when no gnubok verifikat resolves', async () => {
    // gnubok has the number in a DIFFERENT fiscal period: must not match.
    const supabase = rangeMockSupabase({
      fiscal_periods: PERIODS,
      journal_entries: [
        { id: 'je-x', fiscal_period_id: 'fp-2020', source_voucher_series: 'V', source_voucher_number: 33 },
      ],
      document_attachments: [],
    })
    mockFetchUploads.mockResolvedValue([UPLOAD] as never)
    mockFetchVoucherIndex.mockResolvedValue(new Map([['bokio-je-1', VOUCHER_REF]]))

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1 })
    expect(result.unmatchedSamples[0]).toMatchObject({ voucher: 'V33', date: '2021-03-01' })
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('dry run resolves the plan without downloading or writing', async () => {
    const supabase = wireBokio()

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1', dryRun: true })

    expect(result).toMatchObject({ dryRun: true, scanned: 1, linked: 1 })
    expect(mockDownload).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('imports a Fortnox receipt with its real filename and no provider company id', async () => {
    const supabase = wireFortnox()

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    expect(result).toMatchObject({
      provider: 'fortnox',
      scanned: 1,
      linked: 1,
      skipped: 0,
      unmatched: 0,
      failed: 0,
    })
    expect(mockFetchFortnoxFinancialYears).toHaveBeenCalledWith(
      expect.anything(),
      'fortnox-token',
    )
    expect(mockFetchFortnoxFileConnections).toHaveBeenCalledWith(
      expect.anything(),
      'fortnox-token',
      [3],
    )
    const [, , , file, metadata] = mockUpload.mock.calls[0]
    expect(file).toMatchObject({ name: 'kvitto.pdf', type: 'application/pdf' })
    expect(metadata).toEqual({
      upload_source: 'api',
      journal_entry_id: 'je-1',
      linkBasis: { link_basis: 'import_carried_over', link_evidence: { source_system: 'provider_migration' } },
      idempotency_key: 'je-1',
      extractionOwner: 'none',
    })
  })

  it('is a no-op for unsupported providers', async () => {
    mockResolveConsent.mockResolvedValue({
      consent: { provider: 'visma' },
      accessToken: 'tok',
      providerCompanyId: 'co',
    } as never)

    const result = await importProviderDocuments({ supabase: rangeMockSupabase({}), companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ provider: 'visma', scanned: 0, linked: 0 })
    expect(mockFetchUploads).not.toHaveBeenCalled()
    expect(mockFetchFortnoxFinancialYears).not.toHaveBeenCalled()
  })

  it('counts a Fortnox connection with an unknown financial year as unmatched', async () => {
    const supabase = wireFortnox({
      connections: [{ ...FORTNOX_CONNECTION, financialYearId: 99 }],
    })

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1, failed: 0 })
    expect(result.unmatchedSamples[0]).toEqual({
      uploadId: 'fortnox-file-1',
      voucher: '(unresolved)',
      date: '',
      reason: 'no_voucher_ref',
    })
    expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
  })

  it('counts a Fortnox financial year outside every local period as unmatched', async () => {
    const supabase = wireFortnox({
      years: [{ id: 3, fromDate: '2020-01-01', toDate: '2020-12-31' }],
    })

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1, failed: 0 })
    expect(result.unmatchedSamples[0]).toMatchObject({ voucher: 'A12', date: '2020-01-01' })
    expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
  })

  it('dry-runs Fortnox matches without downloading or writing', async () => {
    const supabase = wireFortnox()

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
      dryRun: true,
    })

    expect(result).toMatchObject({ dryRun: true, scanned: 1, linked: 1, failed: 0 })
    expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('matches a Fortnox voucher by its booking date across split local periods', async () => {
    const supabase = wireFortnox({
      periods: [
        { id: 'fp-2021-h1', period_start: '2021-02-04', period_end: '2021-06-30', is_closed: false, locked_at: null },
        { id: 'fp-2021-h2', period_start: '2021-07-01', period_end: '2021-12-31', is_closed: false, locked_at: null },
      ],
      vouchers: [
        {
          id: 'je-h2',
          fiscal_period_id: 'fp-2021-h2',
          entry_date: '2021-09-15',
          source_voucher_series: 'A',
          source_voucher_number: 12,
        },
      ],
    })

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
      dryRun: true,
    })

    expect(result).toMatchObject({ scanned: 1, linked: 1, unmatched: 0 })
  })

  describe('verifikat in a klarmarkerat or locked year (crm#251)', () => {
    // A broken first year and a calendar year after it, as a migrated
    // company's books look. The second Fortnox file belongs to 2024.
    const BROKEN_YEAR: PeriodFixture = {
      id: 'fp-2023', period_start: '2022-12-29', period_end: '2023-12-31', is_closed: false, locked_at: null,
    }
    const OPEN_YEAR: PeriodFixture = {
      id: 'fp-2024', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false, locked_at: null,
    }
    const TWO_YEARS = {
      years: [
        { id: 7, fromDate: '2022-12-29', toDate: '2023-12-31' },
        { id: 8, fromDate: '2024-01-01', toDate: '2024-12-31' },
      ],
      connections: [
        { ...FORTNOX_CONNECTION, fileId: 'file-a', number: 12, financialYearId: 7 },
        { ...FORTNOX_CONNECTION, fileId: 'file-b', number: 3, financialYearId: 8 },
      ],
      vouchers: [
        { id: 'je-2023', fiscal_period_id: 'fp-2023', entry_date: '2023-05-02', source_voucher_series: 'A', source_voucher_number: 12 },
        { id: 'je-2024', fiscal_period_id: 'fp-2024', entry_date: '2024-02-01', source_voucher_series: 'A', source_voucher_number: 3 },
      ],
    }

    it('reports a receipt in a klarmarkerat year as locked, without a download, and links the rest', async () => {
      const supabase = wireFortnox({
        ...TWO_YEARS,
        periods: [
          { ...BROKEN_YEAR, is_closed: true, locked_at: '2026-09-30T11:52:22Z' },
          OPEN_YEAR,
        ],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      // Not a failure: the period-lock trigger would refuse the link, so a
      // retry cannot help until the year is reopened.
      expect(result).toMatchObject({ scanned: 2, linked: 1, locked: 1, failed: 0, lockedPeriods: ['2022/2023'] })
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(1)
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledWith(expect.anything(), 'fortnox-token', 'file-b')
      expect(mockUpload).toHaveBeenCalledTimes(1)
      expect(mockUpload.mock.calls[0][4]).toMatchObject({ journal_entry_id: 'je-2024' })
    })

    it('treats a locked year that is not closed (locked_at only) as locked too', async () => {
      const supabase = wireFortnox({
        ...TWO_YEARS,
        periods: [BROKEN_YEAR, { ...OPEN_YEAR, locked_at: '2026-09-30T12:00:00Z' }],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 1, locked: 1, failed: 0, lockedPeriods: ['2024'] })
      expect(mockUpload.mock.calls[0][4]).toMatchObject({ journal_entry_id: 'je-2023' })
    })

    it('counts locked receipts apart from would-link ones in the dry run, oldest year first', async () => {
      const supabase = wireFortnox({
        ...TWO_YEARS,
        periods: [
          { ...OPEN_YEAR, is_closed: true, locked_at: '2026-09-30T11:52:23Z' },
          { ...BROKEN_YEAR, is_closed: true, locked_at: '2026-09-30T11:52:22Z' },
        ],
      })

      const result = await importProviderDocuments({
        supabase, companyId: COMPANY, userId: USER, consentId: 'c1', dryRun: true,
      })

      expect(result).toMatchObject({
        dryRun: true, scanned: 2, linked: 0, locked: 2, failed: 0, lockedPeriods: ['2022/2023', '2024'],
      })
      expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    })

    it('leaves a locked verifikat that already carries other underlag as skipped, not locked', async () => {
      const supabase = wireFortnox({
        ...TWO_YEARS,
        periods: [{ ...BROKEN_YEAR, is_closed: true, locked_at: '2026-09-30T11:52:22Z' }, OPEN_YEAR],
        existingAttachments: [
          { id: 'doc-manual', sha256_hash: 'sha-other', journal_entry_id: 'je-2023', upload_source: 'upload' },
        ],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 1, skipped: 1, locked: 0, lockedPeriods: [] })
    })

    describe('a year locked after an earlier run reached it (crm#1410)', () => {
      // The earlier run put file-a on je-2023 while the year was open; the
      // year was klarmarkerat afterwards. Its stored hash is the content the
      // Fortnox mock serves.
      const OWN_FILE: ExistingAttachment = {
        id: 'doc-own', sha256_hash: 'sha-FORTNOX-PDF', journal_entry_id: 'je-2023', upload_source: 'api',
      }
      const LOCKED_BROKEN_YEAR = { ...BROKEN_YEAR, is_closed: true, locked_at: '2026-10-21T20:13:00Z' }

      beforeEach(() => {
        mockArchivedForOwnEntry.mockImplementation(async (_company, row) => row.id === 'doc-own')
      })

      it('counts a file already on its verifikat as already there, not as locked', async () => {
        const supabase = wireFortnox({
          ...TWO_YEARS,
          periods: [LOCKED_BROKEN_YEAR, OPEN_YEAR],
          existingAttachments: [OWN_FILE],
        })

        const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

        expect(result).toMatchObject({ scanned: 2, linked: 1, skipped: 1, locked: 0, lockedPeriods: [] })
        // The locked verifikat's file is read only to compare its content; it
        // is never written again.
        expect(mockUpload).toHaveBeenCalledTimes(1)
        expect(mockUpload.mock.calls[0][4]).toMatchObject({ journal_entry_id: 'je-2024' })
      })

      it('still reports a file that never reached the verifikat as locked', async () => {
        const supabase = wireFortnox({
          ...TWO_YEARS,
          periods: [LOCKED_BROKEN_YEAR, OPEN_YEAR],
          existingAttachments: [{ ...OWN_FILE, sha256_hash: 'sha-another-file' }],
        })

        const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

        expect(result).toMatchObject({ linked: 1, skipped: 0, locked: 1, lockedPeriods: ['2022/2023'] })
        expect(mockUpload).toHaveBeenCalledTimes(1)
      })

      it('keeps a file locked when its content cannot be read', async () => {
        const supabase = wireFortnox({
          ...TWO_YEARS,
          periods: [LOCKED_BROKEN_YEAR, OPEN_YEAR],
          existingAttachments: [OWN_FILE],
        })
        mockDownloadFortnoxArchiveFile.mockRejectedValueOnce(new Error('socket hang up'))

        const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

        expect(result).toMatchObject({ linked: 1, locked: 1, failed: 0 })
      })

      it('takes them as already there in the dry run, without a download', async () => {
        const supabase = wireFortnox({
          ...TWO_YEARS,
          periods: [LOCKED_BROKEN_YEAR, OPEN_YEAR],
          existingAttachments: [OWN_FILE],
        })

        const result = await importProviderDocuments({
          supabase, companyId: COMPANY, userId: USER, consentId: 'c1', dryRun: true,
        })

        expect(result).toMatchObject({ dryRun: true, linked: 1, skipped: 1, locked: 0 })
        expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
      })

      it('still reports a locked verifikat without files from this import as locked, without a download', async () => {
        const supabase = wireFortnox({
          ...TWO_YEARS,
          periods: [LOCKED_BROKEN_YEAR, OPEN_YEAR],
          existingAttachments: [{ ...OWN_FILE, journal_entry_id: 'je-2024' }],
        })

        const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

        expect(result).toMatchObject({ locked: 1, lockedPeriods: ['2022/2023'] })
        expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalledWith(expect.anything(), 'fortnox-token', 'file-a')
      })
    })
  })

  it('keeps a dotted Bokio description as a basename and appends the effective extension', async () => {
    const supabase = wireBokio()
    mockFetchUploads.mockResolvedValue([{ ...UPLOAD, description: 'Kvitto 1.2' }] as never)

    await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    const [, , , file] = mockUpload.mock.calls[0]
    expect(file).toMatchObject({ name: 'Kvitto 1.2.pdf', type: 'application/pdf' })
  })

  it('sanitizes an extensionless Fortnox filename and appends the effective extension', async () => {
    const supabase = wireFortnox({
      connections: [{ ...FORTNOX_CONNECTION, name: '../A12' }],
    })

    await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    const [, , , file] = mockUpload.mock.calls[0]
    expect(file).toMatchObject({ name: 'A12.pdf', type: 'application/pdf' })
  })

  it('re-resolves consent once after a Fortnox 401 and retries the same attachment', async () => {
    const supabase = wireFortnox()
    mockResolveConsent
      .mockResolvedValueOnce({
        consent: { provider: 'fortnox' },
        accessToken: 'expired-token',
      } as never)
      .mockResolvedValueOnce({
        consent: { provider: 'fortnox' },
        accessToken: 'fresh-token',
      } as never)
    mockDownloadFortnoxArchiveFile
      .mockRejectedValueOnce(new FortnoxApiError('unauthorized', 401))
      .mockResolvedValueOnce({ bytes: bytesOf('FORTNOX-PDF'), contentType: 'application/pdf' })

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    expect(result).toMatchObject({ scanned: 1, linked: 1, failed: 0 })
    expect(mockResolveConsent).toHaveBeenCalledTimes(2)
    // A real refresh of the refused token, not a re-read that hands it back.
    expect(mockResolveConsent).toHaveBeenLastCalledWith(COMPANY, 'c1', { rejectedAccessToken: 'expired-token' })
    expect(mockDownloadFortnoxArchiveFile).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'expired-token',
      'fortnox-file-1',
    )
    expect(mockDownloadFortnoxArchiveFile).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'fresh-token',
      'fortnox-file-1',
    )
  })

  describe('a connection the provider refuses (B11)', () => {
    const THREE_FILES: FortnoxFileConnection[] = [
      { ...FORTNOX_CONNECTION, fileId: 'f-1' },
      { ...FORTNOX_CONNECTION, fileId: 'f-2' },
      { ...FORTNOX_CONNECTION, fileId: 'f-3' },
    ]
    const tokens = (...accessTokens: string[]) => {
      for (const accessToken of accessTokens) {
        mockResolveConsent.mockResolvedValueOnce({ consent: { provider: 'fortnox' }, accessToken } as never)
      }
    }
    const run = (supabase: SupabaseClient) =>
      importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    it('stops the sweep once, without trying the files left, when the refreshed token is refused too', async () => {
      const supabase = wireFortnox({ connections: THREE_FILES })
      tokens('expired-token', 'refused-token')
      mockDownloadFortnoxArchiveFile.mockRejectedValue(new FortnoxApiError('unauthorized', 401))

      const error = await run(supabase).catch((e) => e)

      expect(error).toBeInstanceOf(ProviderConnectionRefusedError)
      expect(error).toMatchObject({ provider: 'fortnox', code: 'PROVIDER_AUTH_EXPIRED', providerStatus: 401 })
      // The first file and its one retry; f-2 and f-3 are never asked for.
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(2)
      expect(mockUpload).not.toHaveBeenCalled()
    })

    it('outlives the token expiring mid-slice: the rest of the files come in on the new token', async () => {
      // The hourly pattern in prod: Fortnox retires the token while our
      // clock still calls it valid, and every later file of the slice failed.
      const supabase = wireFortnox({ connections: THREE_FILES })
      tokens('old-token', 'new-token')
      const pdf = { bytes: bytesOf('FORTNOX-PDF'), contentType: 'application/pdf' }
      mockDownloadFortnoxArchiveFile.mockImplementation(async (_client, token, fileId) => {
        if (token === 'old-token' && fileId !== 'f-1') throw new FortnoxApiError('unauthorized', 401)
        return { ...pdf, bytes: bytesOf(`PDF-${fileId}`) }
      })

      const result = await run(supabase)

      expect(result).toMatchObject({ scanned: 3, linked: 3, failed: 0 })
      expect(mockResolveConsent).toHaveBeenCalledTimes(2)
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenLastCalledWith(expect.anything(), 'new-token', 'f-3')
    })

    it('reads a later 401 on the refreshed token as a refused connection, without refreshing again', async () => {
      const supabase = wireFortnox({ connections: THREE_FILES })
      tokens('old-token', 'new-token')
      mockDownloadFortnoxArchiveFile
        .mockRejectedValueOnce(new FortnoxApiError('unauthorized', 401))
        .mockResolvedValueOnce({ bytes: bytesOf('PDF-1'), contentType: 'application/pdf' })
        .mockRejectedValue(new FortnoxApiError('unauthorized', 401))

      await expect(run(supabase)).rejects.toBeInstanceOf(ProviderConnectionRefusedError)

      expect(mockResolveConsent).toHaveBeenCalledTimes(2)
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(3)
      expect(mockUpload).toHaveBeenCalledTimes(1)
    })

    it('stops on a grant the refresh is refused (consent expired)', async () => {
      const supabase = wireFortnox({ connections: THREE_FILES })
      tokens('old-token')
      const dead = new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'refresh refused', { providerCode: 'invalid_grant' })
      mockResolveConsent.mockRejectedValueOnce(dead)
      mockDownloadFortnoxArchiveFile.mockRejectedValue(new FortnoxApiError('unauthorized', 401))

      await expect(run(supabase)).rejects.toBe(dead)
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(1)
    })

    it('ends the slice on a refresh that failed transiently, so the page retries it whole', async () => {
      const supabase = wireFortnox({ connections: THREE_FILES })
      tokens('old-token')
      const blink = new ProviderCallError('PROVIDER_UPSTREAM_ERROR', 'fortnox', 'refresh 503', { status: 503 })
      mockResolveConsent.mockRejectedValueOnce(blink)
      mockDownloadFortnoxArchiveFile.mockRejectedValue(new FortnoxApiError('unauthorized', 401))

      await expect(run(supabase)).rejects.toBe(blink)
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(1)
    })

    it('ends the slice on a refresh that timed out, instead of failing every file left', async () => {
      const supabase = wireFortnox({ connections: THREE_FILES })
      tokens('old-token')
      const timeout = new Error('credential refresh timed out')
      mockResolveConsent.mockRejectedValueOnce(timeout)
      mockDownloadFortnoxArchiveFile.mockRejectedValue(new FortnoxApiError('unauthorized', 401))

      await expect(run(supabase)).rejects.toBe(timeout)
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(1)
    })

    it('refreshes and lists again when the token died before the listing', async () => {
      const supabase = wireFortnox()
      tokens('old-token', 'new-token')
      mockFetchFortnoxFinancialYears.mockRejectedValueOnce(new FortnoxApiError('unauthorized', 401))

      const result = await run(supabase)

      expect(result).toMatchObject({ scanned: 1, linked: 1, failed: 0 })
      expect(mockResolveConsent).toHaveBeenLastCalledWith(COMPANY, 'c1', { rejectedAccessToken: 'old-token' })
    })

    it('still counts a file that fails for its own reason and carries on', async () => {
      const supabase = wireFortnox({ connections: THREE_FILES })
      mockDownloadFortnoxArchiveFile.mockImplementation(async (_client, _token, fileId) => {
        if (fileId === 'f-2') throw new FortnoxApiError('not found', 404)
        return { bytes: bytesOf(`PDF-${fileId}`), contentType: 'application/pdf' }
      })

      const result = await run(supabase)

      expect(result).toMatchObject({ scanned: 3, linked: 2, failed: 1 })
      expect(mockResolveConsent).toHaveBeenCalledTimes(1)
    })

    it('stops at a Bokio token the provider refuses: it cannot be refreshed', async () => {
      const supabase = wireBokio()
      mockFetchUploads.mockResolvedValue([UPLOAD, { ...UPLOAD, id: 'up-2' }] as never)
      mockDownload.mockRejectedValue(new BokioApiError('Bokio API error: 401 Unauthorized', 401))

      const error = await run(supabase).catch((e) => e)

      expect(error).toMatchObject({ provider: 'bokio', code: 'PROVIDER_AUTH_EXPIRED', providerStatus: 401 })
      expect(mockDownload).toHaveBeenCalledTimes(1)
      expect(mockResolveConsent).toHaveBeenCalledTimes(1)
    })

    it('stops at a Bokio listing refused for lack of rights', async () => {
      const supabase = wireBokio()
      mockFetchUploads.mockRejectedValue(new BokioApiError('Bokio API error: 403 Forbidden', 403))

      await expect(run(supabase)).rejects.toMatchObject({ code: 'PROVIDER_RESOURCE_FORBIDDEN', providerStatus: 403 })
      expect(mockDownload).not.toHaveBeenCalled()
    })
  })

  it('explains that a Fortnox 403 requires reconnecting with attachment scopes', async () => {
    const supabase = wireFortnox()
    mockFetchFortnoxFinancialYears.mockRejectedValue(
      new FortnoxApiError('forbidden', 403),
    )

    await expect(
      importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
      }),
    ).rejects.toThrow('Fortnox consent lacks archive/connectfile scope: reconnect required')
  })

  // Six companies hit exactly this between 2026-08-13 and 08-19 and were told
  // "kunde inte importera underlag, försök igen", with a retry that could not
  // work: Fortnox answers an unscoped attachment listing with 400 plus a
  // behörighet message, not only with 403.
  it('treats a Fortnox 400 that names the missing permission as the same failure', async () => {
    const supabase = wireFortnox()
    mockFetchFortnoxFinancialYears.mockRejectedValue(
      new FortnoxApiError(
        'bad request',
        400,
        JSON.stringify({
          ErrorInformation: {
            error: 1,
            message: 'Otillräcklig behörighet för att utföra anropet',
            code: 2000663,
          },
        }),
      ),
    )

    await expect(
      importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
      }),
    ).rejects.toThrow('Fortnox consent lacks archive/connectfile scope: reconnect required')
  })

  it('explains that a Fortnox archive-download 403 requires reconnecting', async () => {
    const supabase = wireFortnox()
    mockDownloadFortnoxArchiveFile.mockRejectedValue(
      new FortnoxApiError('forbidden', 403),
    )

    await expect(
      importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
      }),
    ).rejects.toThrow('Fortnox consent lacks archive/connectfile scope: reconnect required')
  })

  it('does not WORM-link a receipt when the local source voucher identity is ambiguous', async () => {
    const supabase = wireFortnox({
      vouchers: [
        {
          id: 'je-1',
          fiscal_period_id: 'fp-2021',
          entry_date: '2021-03-01',
          source_voucher_series: 'A',
          source_voucher_number: 12,
        },
        {
          id: 'je-duplicate',
          fiscal_period_id: 'fp-2021',
          entry_date: '2021-03-01',
          source_voucher_series: 'A',
          source_voucher_number: 12,
        },
      ],
    })

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1, failed: 0 })
    expect(result.unmatchedSamples[0]).toMatchObject({ voucher: 'A12', reason: 'several_posted' })
    expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  describe('a re-synced year: a reversed copy of each verifikat beside the live one (PH 163)', () => {
    // Replacing a year by an SIE re-sync reverses the first import's copy and
    // imports the year again: both copies carry the same source ref (A12).
    const liveCopy = { id: 'je-live', fiscal_period_id: 'fp-2021', entry_date: '2021-03-01', source_voucher_series: 'A', source_voucher_number: 12, status: 'posted' }
    const firstCopy = { ...liveCopy, id: 'je-first-copy', status: 'reversed' }

    it('links the Fortnox file to the live copy, never to the reversed one', async () => {
      const supabase = wireFortnox({ vouchers: [firstCopy, liveCopy] })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ scanned: 1, linked: 1, unmatched: 0, failed: 0 })
      expect(mockUpload).toHaveBeenCalledTimes(1)
      expect(mockUpload.mock.calls[0][4]).toMatchObject({ journal_entry_id: 'je-live', idempotency_key: 'je-live' })
    })

    it('counts the live copy as a would-link in the dry run', async () => {
      const supabase = wireFortnox({ vouchers: [firstCopy, liveCopy] })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1', dryRun: true })

      expect(result).toMatchObject({ dryRun: true, linked: 1, unmatched: 0 })
      expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    })

    it('links a Bokio receipt to the live copy too: the sweep is shared', async () => {
      mockFetchUploads.mockResolvedValue([UPLOAD] as never)
      mockFetchVoucherIndex.mockResolvedValue(new Map([['bokio-je-1', VOUCHER_REF]]))
      mockDownload.mockResolvedValue({ bytes: bytesOf('PDFBYTES'), contentType: 'application/pdf' })
      const bokioLive = { ...liveCopy, source_voucher_series: 'V', source_voucher_number: 33 }
      const supabase = rangeMockSupabase({
        fiscal_periods: PERIODS,
        journal_entries: [{ ...bokioLive, id: 'je-first-copy', status: 'reversed' }, bokioLive],
        document_attachments: [],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ provider: 'bokio', linked: 1, unmatched: 0 })
      expect(mockUpload.mock.calls[0][4]).toMatchObject({ journal_entry_id: 'je-live' })
    })

    it('leaves a ref only reversed copies carry unmatched, with its reason and without a download', async () => {
      const supabase = wireFortnox({ vouchers: [firstCopy] })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1, failed: 0 })
      expect(result.unmatchedSamples).toEqual([
        { uploadId: 'fortnox-file-1', voucher: 'A12', date: '2021-02-04', reason: 'only_reversed' },
      ])
      expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
      expect(mockUpload).not.toHaveBeenCalled()
    })

    it('still refuses two live copies beside a reversed one', async () => {
      const supabase = wireFortnox({ vouchers: [firstCopy, liveCopy, { ...liveCopy, id: 'je-live-2' }] })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 0, unmatched: 1 })
      expect(result.unmatchedSamples[0]).toMatchObject({ voucher: 'A12', reason: 'several_posted' })
      expect(mockUpload).not.toHaveBeenCalled()
    })

    it('reports the live copy in a klarmarkerat year as locked, without a download', async () => {
      const supabase = wireFortnox({
        vouchers: [firstCopy, liveCopy],
        periods: [{ ...PERIODS[0], is_closed: true, locked_at: '2026-09-30T11:52:22Z' }],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 0, locked: 1, unmatched: 0, failed: 0 })
      expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    })

    it('leaves the live copy alone when it already carries underlag from another path', async () => {
      const supabase = wireFortnox({
        vouchers: [firstCopy, liveCopy],
        existingAttachments: [{ id: 'manual-doc', sha256_hash: 'sha-OTHER', journal_entry_id: 'je-live', upload_source: 'file_upload' }],
      })

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 0, skipped: 1, unmatched: 0 })
      expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    })

    it('links the live copy although the reversed copy kept the file an earlier run linked', async () => {
      // The earlier run's document stays on the reversed copy (it cannot be
      // removed), and the live verifikat in the books gets its own.
      const supabase = wireFortnox({
        vouchers: [firstCopy, liveCopy],
        existingAttachments: [{ id: 'earlier-run', sha256_hash: 'sha-FORTNOX-PDF', journal_entry_id: 'je-first-copy', upload_source: 'api' }],
      })
      mockArchivedForOwnEntry.mockResolvedValue(true)

      const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

      expect(result).toMatchObject({ linked: 1, skipped: 0 })
      expect(mockUpload.mock.calls[0][4]).toMatchObject({ journal_entry_id: 'je-live' })
    })

    // The run before the re-run recorded each Bokio upload against the file
    // it put on the first copy, and record_bokio_upload keeps that document:
    // the live copy's document for the same upload is refused as a conflict
    // (#51). The file is on the live verifikat by then, so it is not a failure.
    describe('a Bokio upload recorded against its file on the reversed copy (#51)', () => {
      const bokioLive = { ...liveCopy, source_voucher_series: 'V', source_voucher_number: 33 }
      const bokioFirstCopy = { ...bokioLive, id: 'je-first-copy', status: 'reversed' }
      const onFirstCopy = { id: 'earlier-run', sha256_hash: 'sha-PDFBYTES', journal_entry_id: 'je-first-copy', upload_source: 'api' }
      const conflict = { data: null, error: { message: 'BOKIO_UPLOAD_IDENTITY_CONFLICT', code: 'P0001' } }

      function wireBokioResync(existingAttachments: ExistingAttachment[]) {
        mockFetchUploads.mockResolvedValue([UPLOAD] as never)
        mockFetchVoucherIndex.mockResolvedValue(new Map([['bokio-je-1', VOUCHER_REF]]))
        mockDownload.mockResolvedValue({ bytes: bytesOf('PDFBYTES'), contentType: 'application/pdf' })
        mockArchivedForOwnEntry.mockResolvedValue(true)
        return rangeMockSupabase({
          fiscal_periods: PERIODS,
          journal_entries: [bokioFirstCopy, bokioLive],
          document_attachments: existingAttachments,
        })
      }

      it('links the file to the live copy and counts it linked, not failed', async () => {
        const supabase = wireBokioResync([onFirstCopy])
        vi.mocked(supabase.rpc).mockResolvedValue(conflict as never)

        const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

        expect(result).toMatchObject({ provider: 'bokio', linked: 1, skipped: 0, failed: 0 })
        expect(mockUpload.mock.calls[0][4]).toMatchObject({ journal_entry_id: 'je-live' })
        expect(supabase.rpc).toHaveBeenCalledWith('record_bokio_upload', {
          p_company_id: COMPANY, p_consent_id: 'c1', p_upload_id: 'up-1', p_document_id: 'doc-1',
        })
        expect(mockRecordDocumentArrival).toHaveBeenCalledTimes(1)
      })

      it('skips it on the next run without a failure', async () => {
        const supabase = wireBokioResync([
          onFirstCopy,
          { id: 'live-doc', sha256_hash: 'sha-PDFBYTES', journal_entry_id: 'je-live', upload_source: 'api' },
        ])
        vi.mocked(supabase.rpc).mockResolvedValue(conflict as never)

        const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

        expect(result).toMatchObject({ linked: 0, skipped: 1, failed: 0 })
        expect(mockUpload).not.toHaveBeenCalled()
      })

      it('still counts a conflict as failed when no reversed copy holds the same file', async () => {
        const supabase = wireBokioResync([
          { ...onFirstCopy, sha256_hash: 'sha-OTHER-CONTENT' },
        ])
        vi.mocked(supabase.rpc).mockResolvedValue(conflict as never)

        const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

        expect(result).toMatchObject({ linked: 0, failed: 1 })
        expect(mockRecordDocumentArrival).not.toHaveBeenCalled()
      })
    })
  })

  it('counts a receipt as unmatched when its journalEntryId is not in the Bokio voucher index', async () => {
    // e.g. an unparseable journalEntryNumber: must be reported, not dropped.
    const supabase = wireBokio()
    mockFetchVoucherIndex.mockResolvedValue(new Map<string, BokioVoucherRef>())

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1 })
    expect(result.unmatchedSamples[0]).toMatchObject({ uploadId: 'up-1', voucher: '(unresolved)' })
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('handles a company with no uploads as an all-zero no-op', async () => {
    const supabase = wireBokio()
    mockFetchUploads.mockResolvedValue([] as never)

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 0, linked: 0, skipped: 0, unmatched: 0, failed: 0 })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('is best-effort: a failed receipt is counted, not thrown, and the sweep continues', async () => {
    const upload2 = { id: 'up-2', description: 'Faktura', contentType: 'application/pdf', journalEntryId: 'bokio-je-2' }
    const supabase = rangeMockSupabase({
      fiscal_periods: PERIODS,
      journal_entries: [
        { id: 'je-1', fiscal_period_id: 'fp-2021', entry_date: '2021-03-01', source_voucher_series: 'V', source_voucher_number: 33 },
        { id: 'je-2', fiscal_period_id: 'fp-2021', entry_date: '2021-04-01', source_voucher_series: 'V', source_voucher_number: 34 },
      ],
      document_attachments: [],
    })
    mockFetchUploads.mockResolvedValue([UPLOAD, upload2] as never)
    mockFetchVoucherIndex.mockResolvedValue(
      new Map<string, BokioVoucherRef>([
        ['bokio-je-1', VOUCHER_REF],
        ['bokio-je-2', { series: 'V', number: 34, date: '2021-04-01' }],
      ]),
    )
    // First download fails, second succeeds.
    mockDownload
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ bytes: bytesOf('OK'), contentType: 'application/octet-stream' })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 2, linked: 1, failed: 1 })
    expect(mockUpload).toHaveBeenCalledTimes(1)
  })

  it('archives identical content onto each of several verifikat within one run', async () => {
    const upload2 = { id: 'up-2', description: 'Kontrakt', contentType: 'application/pdf', journalEntryId: 'bokio-je-2' }
    const supabase = rangeMockSupabase({
      fiscal_periods: PERIODS,
      journal_entries: [
        { id: 'je-1', fiscal_period_id: 'fp-2021', entry_date: '2021-03-01', source_voucher_series: 'V', source_voucher_number: 33 },
        { id: 'je-2', fiscal_period_id: 'fp-2021', entry_date: '2021-04-01', source_voucher_series: 'V', source_voucher_number: 34 },
      ],
      document_attachments: [],
    })
    mockFetchUploads.mockResolvedValue([UPLOAD, upload2] as never)
    mockFetchVoucherIndex.mockResolvedValue(
      new Map<string, BokioVoucherRef>([
        ['bokio-je-1', VOUCHER_REF],
        ['bokio-je-2', { series: 'V', number: 34, date: '2021-04-01' }],
      ]),
    )
    // Both uploads are the same file content (one arrende contract, two vouchers).
    mockDownload.mockResolvedValue({ bytes: bytesOf('PDFBYTES'), contentType: 'application/octet-stream' })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 2, linked: 2, skipped: 0 })
    expect(mockUpload).toHaveBeenCalledTimes(2)
    const targets = mockUpload.mock.calls.map((c) => (c[4] as { journal_entry_id: string }).journal_entry_id)
    expect(targets).toEqual(['je-1', 'je-2'])
  })

  it('trusts sniffed magic bytes over a wrong declared contentType', async () => {
    const supabase = wireBokio()
    // Bokio's uploads list says PNG but the actual bytes are a JPEG.
    mockFetchUploads.mockResolvedValue([{ ...UPLOAD, contentType: 'image/png' }] as never)
    mockDetectMagic.mockReturnValue('image/jpeg')

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 1, failed: 0 })
    const [, , , file] = mockUpload.mock.calls[0]
    expect(file).toMatchObject({ name: 'Kvitto.jpg', type: 'image/jpeg' })
  })

  describe('time budget and cursor (resumable sweep)', () => {
    const THREE_CONNECTIONS: FortnoxFileConnection[] = [
      { ...FORTNOX_CONNECTION, fileId: 'file-c', name: 'c.pdf' },
      { ...FORTNOX_CONNECTION, fileId: 'file-a', name: 'a.pdf' },
      { ...FORTNOX_CONNECTION, fileId: 'file-b', name: 'b.pdf' },
    ]

    it('stops after the attachment in flight once the budget is spent and hands back a cursor', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })
      // Each download "costs" 100 ms of wall clock; the budget allows one.
      let clock = 0
      mockDownloadFortnoxArchiveFile.mockImplementation(async () => {
        clock += 100
        return { bytes: bytesOf('FORTNOX-PDF-' + clock), contentType: 'application/pdf' }
      })

      const first = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        timeBudgetMs: 50,
        now: () => clock,
      })

      expect(first).toMatchObject({
        total: 3,
        scanned: 1,
        linked: 1,
        partial: true,
        nextCursor: 'file-a',
      })
      // Sorted by provider id, so the first slice is file-a, not file-c.
      expect(mockUpload.mock.calls[0][3]).toMatchObject({ name: 'a.pdf' })

      const second = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        cursor: first.nextCursor,
        timeBudgetMs: 1_000_000,
        now: () => clock,
      })

      expect(second).toMatchObject({ total: 3, scanned: 2, linked: 2, partial: false, nextCursor: null })
      expect(mockUpload.mock.calls.map((call) => (call[3] as { name: string }).name)).toEqual([
        'a.pdf',
        'b.pdf',
        'c.pdf',
      ])
    })

    it('spends the budget on attachments only, not on listing the provider archive', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })
      // Listing "costs" 1000 ms, each download 100 ms; the budget fits two downloads.
      let clock = 0
      mockFetchFortnoxFileConnections.mockImplementation(async () => {
        clock += 1_000
        return THREE_CONNECTIONS
      })
      mockDownloadFortnoxArchiveFile.mockImplementation(async () => {
        clock += 100
        return { bytes: bytesOf('FORTNOX-PDF-' + clock), contentType: 'application/pdf' }
      })

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        timeBudgetMs: 150,
        now: () => clock,
      })

      expect(result).toMatchObject({ total: 3, scanned: 2, linked: 2, partial: true, nextCursor: 'file-b' })
    })

    it('stops at an absolute sweep deadline the listing already counts against (crm#1581)', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })
      // The listing "costs" 1000 ms and each download 100 ms. The server's
      // slice sweeps to its function's deadline: 1150 ms from the start fits
      // two downloads after the listing, however large the budget.
      let clock = 0
      mockFetchFortnoxFileConnections.mockImplementation(async () => {
        clock += 1_000
        return THREE_CONNECTIONS
      })
      mockDownloadFortnoxArchiveFile.mockImplementation(async () => {
        clock += 100
        return { bytes: bytesOf('FORTNOX-PDF-' + clock), contentType: 'application/pdf' }
      })

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        timeBudgetMs: 1_000_000,
        sweepDeadline: 1_150,
        now: () => clock,
      })

      expect(result).toMatchObject({ total: 3, scanned: 2, linked: 2, partial: true, nextCursor: 'file-b' })
    })

    it('always processes at least one attachment per call even when the budget is already spent', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        timeBudgetMs: 0,
        now: () => 0,
      })

      expect(result).toMatchObject({ scanned: 1, linked: 1, partial: true, nextCursor: 'file-a' })
    })

    it('treats a cursor past the last id as a complete, empty slice', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        cursor: 'file-z',
      })

      expect(result).toMatchObject({ total: 3, scanned: 0, linked: 0, partial: false, nextCursor: null })
      expect(mockUpload).not.toHaveBeenCalled()
    })

    it('starts a retried slice at the point the saved run reached, not at the tab cursor (crm#1581)', async () => {
      // The server folded the slice that handled file-b, but the tab lost the
      // answer and retries from file-a: file-b is not downloaded again.
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        cursor: 'file-a',
        savedRun: { provider: 'fortnox', complete: false, nextCursor: 'file-b' },
      })

      expect(result).toMatchObject({ total: 3, scanned: 1, linked: 1, partial: false, nextCursor: null })
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(1)
      expect(mockUpload.mock.calls.map((call) => (call[3] as { name: string }).name)).toEqual(['c.pdf'])
    })

    it("keeps the tab cursor when the saved run is another provider's", async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })
      mockDownloadFortnoxArchiveFile.mockImplementation(async (_client, _token, id) => ({
        bytes: bytesOf('PDF-' + id),
        contentType: 'application/pdf',
      }))

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        cursor: 'file-a',
        savedRun: { provider: 'bokio', complete: false, nextCursor: 'file-b' },
      })

      expect(result).toMatchObject({ total: 3, scanned: 2, linked: 2, partial: false })
    })

    it('resumes after the last handled id even when the provider list changed in between', async () => {
      // Slice 1 handled file-a. Before slice 2, Fortnox gained a file sorting
      // BEFORE the resume point (file-0) and lost file-b. An index cursor
      // would now skip one; an id cursor continues with everything > file-a.
      const supabase = wireFortnox({
        connections: [
          { ...FORTNOX_CONNECTION, fileId: 'file-0', name: '0.pdf' },
          { ...FORTNOX_CONNECTION, fileId: 'file-a', name: 'a.pdf' },
          { ...FORTNOX_CONNECTION, fileId: 'file-c', name: 'c.pdf' },
          { ...FORTNOX_CONNECTION, fileId: 'file-d', name: 'd.pdf' },
        ],
      })
      // Distinct bytes per file: the default mock returns the same bytes for
      // every download, and identical content on the same verifikat is
      // (correctly) deduped, which is not what this test is about.
      mockDownloadFortnoxArchiveFile.mockImplementation(async (_client, _token, id) => ({
        bytes: bytesOf('PDF-' + id),
        contentType: 'application/pdf',
      }))

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        cursor: 'file-a',
      })

      expect(result).toMatchObject({ total: 4, scanned: 2, linked: 2, partial: false })
      expect(mockUpload.mock.calls.map((call) => (call[3] as { name: string }).name)).toEqual([
        'c.pdf',
        'd.pdf',
      ])
    })

    it('retries the file in flight when the execution budget is cut, without counting it as failed', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })
      mockDownloadFortnoxArchiveFile
        .mockResolvedValueOnce({ bytes: bytesOf('PDF-file-a'), contentType: 'application/pdf' })
        .mockRejectedValueOnce(new ExecutionBudgetExceeded('underlag-test'))

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
      })

      // The retried file is scanned once, by the slice that finishes it.
      expect(result).toMatchObject({ partial: true, nextCursor: 'file-a', failed: 0, linked: 1, scanned: 1 })
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(2)
    })

    it('counts a file the hard stop cut as the first of its slice as failed and moves past it', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })
      mockDownloadFortnoxArchiveFile
        .mockRejectedValueOnce(new ExecutionBudgetExceeded('underlag-test'))
        .mockResolvedValue({ bytes: bytesOf('PDF-file-b'), contentType: 'application/pdf' })

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
      })

      // A fresh slice could not finish it: retrying it again would never advance.
      expect(result).toMatchObject({ failed: 1, partial: false })
      expect(mockDownloadFortnoxArchiveFile.mock.calls.length).toBeGreaterThan(1)
    })

    it('stops before the next file when the continuation loses the run or connection', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })
      const shouldContinue = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        shouldContinue,
      })

      expect(result).toMatchObject({ partial: true, nextCursor: 'file-a', failed: 0, linked: 1 })
      expect(shouldContinue).toHaveBeenCalledTimes(2)
      expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(1)
    })
  })
})

describe('Fortnox customer invoice copies (#165)', () => {
  interface ImportedInvoiceRow {
    id: string
    status: string
    journal_entry_id: string | null
  }

  /**
   * The Fortnox wiring plus the migration's records: one salesInvoices source
   * record per invoice (document number 1001 unless given), the invoice rows,
   * and the anchoring update on document_attachments.
   */
  function withCustomerInvoices(
    base: SupabaseClient,
    invoices: ImportedInvoiceRow[],
    opts: {
      documentNumbers?: Record<string, string>
      existingAttachments?: ExistingAttachment[]
      anchorRefused?: boolean
      /** The stored customer_invoice_copy_refusals value, as an earlier run left it. */
      copyRefusals?: unknown
    } = {},
  ) {
    const anchors: { id: string; values: Record<string, unknown> }[] = []
    // extension_data, the one key this import reads and writes.
    const kept: { value: unknown; writes: number } = { value: opts.copyRefusals ?? null, writes: 0 }
    const supabase = {
      from(table: string) {
        if (table === 'migration_source_records') {
          const node = {
            select: () => node,
            eq: () => node,
            order: () => node,
            range: () =>
              Promise.resolve({
                data: invoices.map((invoice, index) => ({
                  id: `msr-${index}`,
                  source_id: opts.documentNumbers?.[invoice.id] ?? '1001',
                  target_id: invoice.id,
                })),
                error: null,
              }),
          }
          return node
        }
        if (table === 'extension_data') {
          const node = {
            select: () => node,
            eq: () => node,
            maybeSingle: () => Promise.resolve({ data: kept.value === null ? null : { value: kept.value }, error: null }),
            upsert: (row: { value: unknown }) => {
              kept.value = row.value
              kept.writes++
              return Promise.resolve({ error: null })
            },
          }
          return node
        }
        if (table === 'invoices') {
          let ids: string[] = []
          const node = {
            select: () => node,
            eq: () => node,
            in: (_column: string, values: string[]) => {
              ids = values
              return node
            },
            order: () => node,
            range: () => Promise.resolve({ data: invoices.filter((invoice) => ids.includes(invoice.id)), error: null }),
          }
          return node
        }
        if (table === 'document_attachments') {
          let updating: Record<string, unknown> | null = null
          let documentId = ''
          const node = {
            select: (): unknown => {
              if (!updating) return node
              if (opts.anchorRefused) return Promise.resolve({ data: null, error: { message: 'period is locked' } })
              anchors.push({ id: documentId, values: updating })
              return Promise.resolve({ data: [{ id: documentId }], error: null })
            },
            update: (values: Record<string, unknown>) => {
              updating = values
              return node
            },
            eq: (column: string, value: unknown) => {
              if (column === 'id') documentId = value as string
              return node
            },
            is: () => node,
            not: () => node,
            in: () => node,
            order: () => node,
            range: () => Promise.resolve({ data: opts.existingAttachments ?? [], error: null }),
          }
          return node
        }
        return base.from(table)
      },
      rpc: base.rpc,
    } as unknown as SupabaseClient
    return { supabase, anchors, kept }
  }

  const ENTRY_B7 = { id: 'je-b7', fiscal_period_id: 'fp-2021', entry_date: '2021-03-05', source_voucher_series: 'B', source_voucher_number: 7 }
  const PAID: ImportedInvoiceRow = { id: 'inv-1', status: 'paid', journal_entry_id: 'je-b7' }

  function wireCustomerInvoices(vouchers: typeof GNUBOK_VOUCHERS = [ENTRY_B7], periods: typeof PERIODS = PERIODS) {
    // No voucher files: only the customer invoice copies are swept.
    return wireFortnox({ connections: [], vouchers, periods })
  }

  async function run(supabase: SupabaseClient, dryRun = false) {
    return importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1', dryRun })
  }

  beforeEach(() => {
    mockDetectMagic.mockReturnValue('application/pdf')
    mockInvoicePreview.mockResolvedValue({ bytes: bytesOf('FORTNOX-PREVIEW'), contentType: 'application/pdf' })
    mockInvoiceBookingVoucher.mockResolvedValue(null)
    mockInvoicesWithImportedCopy.mockResolvedValue(new Set())
    mockRecordImportedDelivery.mockResolvedValue('delivery-1')
    mockDeleteDocument.mockResolvedValue({ ok: true } as never)
  })

  it('stores the copy unlinked, records the delivery, then anchors it on the verifikat the migration linked', async () => {
    const { supabase, anchors } = withCustomerInvoices(wireCustomerInvoices(), [PAID])

    const result = await run(supabase)

    expect(result.customerInvoicePdfs).toEqual({ scanned: 1, linked: 1, invoiceOnly: 0, skipped: 0, locked: 0, failed: 0, refused: 0 })
    expect(result).toMatchObject({ scanned: 1, linked: 1, unmatched: 0, failed: 0 })
    // The invoice's own link is a live migrated verifikat: Fortnox is not asked.
    expect(mockInvoiceBookingVoucher).not.toHaveBeenCalled()
    expect(mockInvoicePreview).toHaveBeenCalledWith(expect.anything(), 'fortnox-token', '1001')
    const [, , , file, metadata] = mockUpload.mock.calls[0]
    expect(file).toMatchObject({ name: 'Faktura 1001.pdf', type: 'application/pdf' })
    expect(metadata).toEqual({ upload_source: 'api', idempotency_key: 'je-b7', extractionOwner: 'none' })
    expect(mockRecordImportedDelivery).toHaveBeenCalledWith({
      companyId: COMPANY,
      userId: USER,
      invoiceId: 'inv-1',
      provider: 'fortnox',
      providerMessageId: 'invoice:1001:inv-1',
      documentId: 'doc-1',
    })
    expect(anchors).toEqual([
      {
        id: 'doc-1',
        values: {
          journal_entry_id: 'je-b7',
          link_basis: 'import_carried_over',
          link_evidence: { source_system: 'provider_migration' },
        },
      },
    ])
    // The delivery holds the file before it reaches the verifikat.
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(mockRecordImportedDelivery.mock.invocationCallOrder[0])
    expect(mockDeleteDocument).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'a paid invoice', status: 'paid' },
    { label: 'an unpaid invoice', status: 'sent' },
    { label: 'a credit note', status: 'credited' },
  ])('archives $label', async ({ status }) => {
    const { supabase } = withCustomerInvoices(wireCustomerInvoices(), [{ ...PAID, status }])

    const result = await run(supabase)

    expect(result.customerInvoicePdfs).toMatchObject({ linked: 1 })
    expect(mockRecordImportedDelivery).toHaveBeenCalledTimes(1)
  })

  it('leaves out drafts and cancelled invoices: never issued, nothing to keep', async () => {
    const { supabase } = withCustomerInvoices(
      wireCustomerInvoices(),
      [
        { id: 'inv-draft', status: 'draft', journal_entry_id: null },
        { id: 'inv-cancelled', status: 'cancelled', journal_entry_id: null },
      ],
    )

    const result = await run(supabase)

    expect(result).toMatchObject({ total: 0, scanned: 0 })
    expect(mockInvoicePreview).not.toHaveBeenCalled()
  })

  describe('an invoice without a live verifikat link', () => {
    const UNLINKED: ImportedInvoiceRow = { id: 'inv-1', status: 'sent', journal_entry_id: null }

    it('resolves the verifikat from the series, number and financial year Fortnox names, never the invoice number', async () => {
      const { supabase, anchors } = withCustomerInvoices(
        wireCustomerInvoices([
          // The invoice number read as a voucher number: must never be picked.
          { id: 'je-a1001', fiscal_period_id: 'fp-2021', entry_date: '2021-03-05', source_voucher_series: 'A', source_voucher_number: 1001 },
          ENTRY_B7,
          // B7 again in the next year: the financial year tells them apart.
          { id: 'je-b7-2022', fiscal_period_id: 'fp-2022', entry_date: '2022-03-05', source_voucher_series: 'B', source_voucher_number: 7 },
        ]),
        [UNLINKED],
      )
      mockInvoiceBookingVoucher.mockResolvedValue({ series: 'B', number: 7, financialYearId: 3 })

      const result = await run(supabase)

      expect(mockInvoiceBookingVoucher).toHaveBeenCalledWith(expect.anything(), 'fortnox-token', '1001')
      expect(result.customerInvoicePdfs).toMatchObject({ linked: 1, invoiceOnly: 0 })
      expect(anchors.map((anchor) => anchor.values.journal_entry_id)).toEqual(['je-b7'])
    })

    it('asks Fortnox when the invoice links a reversed copy, and anchors on the live one', async () => {
      const { supabase, anchors } = withCustomerInvoices(
        wireCustomerInvoices([
          { ...ENTRY_B7, id: 'je-b7-reversed', status: 'reversed' } as (typeof GNUBOK_VOUCHERS)[number],
          ENTRY_B7,
        ]),
        [{ ...UNLINKED, journal_entry_id: 'je-b7-reversed' }],
      )
      mockInvoiceBookingVoucher.mockResolvedValue({ series: 'B', number: 7, financialYearId: 3 })

      const result = await run(supabase)

      expect(result.customerInvoicePdfs).toMatchObject({ linked: 1 })
      expect(anchors.map((anchor) => anchor.values.journal_entry_id)).toEqual(['je-b7'])
    })

    it.each([
      {
        label: 'two live verifikat carry the voucher in that year',
        vouchers: [ENTRY_B7, { ...ENTRY_B7, id: 'je-b7-twin' }],
        booking: { series: 'B', number: 7, financialYearId: 3 },
      },
      { label: 'no migrated verifikat carries it', vouchers: [], booking: { series: 'B', number: 7, financialYearId: 3 } },
      { label: 'Fortnox names no voucher (never booked)', vouchers: [ENTRY_B7], booking: null },
      { label: 'the financial year is not one Fortnox lists', vouchers: [ENTRY_B7], booking: { series: 'B', number: 7, financialYearId: 99 } },
    ])('archives it on the invoice only when $label', async ({ vouchers, booking }) => {
      const { supabase, anchors } = withCustomerInvoices(wireCustomerInvoices(vouchers), [UNLINKED])
      mockInvoiceBookingVoucher.mockResolvedValue(booking)

      const result = await run(supabase)

      expect(result.customerInvoicePdfs).toMatchObject({ linked: 0, invoiceOnly: 1, failed: 0 })
      expect(result).toMatchObject({ linked: 1, unmatched: 0 })
      // On the invoice, never on a guessed verifikat.
      expect(mockRecordImportedDelivery).toHaveBeenCalledTimes(1)
      expect(anchors).toEqual([])
      const [, , , , metadata] = mockUpload.mock.calls[0]
      expect(metadata).toEqual({ upload_source: 'api', extractionOwner: 'none' })
    })

    it('stops asking Fortnox after the invoice register is refused, and reports it once', async () => {
      const { supabase } = withCustomerInvoices(
        wireCustomerInvoices(),
        [UNLINKED, { ...UNLINKED, id: 'inv-2' }],
        { documentNumbers: { 'inv-1': '1001', 'inv-2': '1002' } },
      )
      mockInvoiceBookingVoucher.mockRejectedValue(new FortnoxApiError('forbidden', 403))

      const result = await run(supabase)

      expect(mockInvoiceBookingVoucher).toHaveBeenCalledTimes(1)
      expect(result.unreachableSources).toEqual([
        expect.objectContaining({ source: 'customer_invoice_files', scope: 'invoice', reason: 'permission' }),
      ])
      expect(result.customerInvoicePdfs).toMatchObject({ scanned: 2, failed: 0 })
      expect(mockUpload).not.toHaveBeenCalled()
    })
  })

  it('reports a verifikat in a locked year as locked, without downloading', async () => {
    const { supabase } = withCustomerInvoices(
      wireCustomerInvoices([ENTRY_B7], [{ ...PERIODS[0], locked_at: '2021-04-01T00:00:00Z' }]),
      [PAID],
    )

    const result = await run(supabase)

    expect(result.customerInvoicePdfs).toMatchObject({ scanned: 1, linked: 0, locked: 1 })
    expect(result.lockedPeriods).toEqual(['2021'])
    expect(mockInvoicePreview).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('puts the copy on the invoice only when the verifikat carries underlag from another path', async () => {
    const { supabase, anchors } = withCustomerInvoices(wireCustomerInvoices(), [PAID], {
      existingAttachments: [{ id: 'wizard-doc', sha256_hash: 'sha-OTHER', journal_entry_id: 'je-b7', upload_source: 'file_upload' }],
    })

    const result = await run(supabase)

    expect(result.customerInvoicePdfs).toMatchObject({ linked: 0, invoiceOnly: 1 })
    expect(anchors).toEqual([])
    expect(mockRecordImportedDelivery).toHaveBeenCalledTimes(1)
  })

  it('skips an invoice that already holds its imported copy before any Fortnox call or write', async () => {
    mockInvoicesWithImportedCopy.mockResolvedValue(new Set(['inv-1']))
    const { supabase } = withCustomerInvoices(wireCustomerInvoices(), [{ ...PAID, journal_entry_id: null }])

    const result = await run(supabase)

    expect(result.customerInvoicePdfs).toMatchObject({ scanned: 1, skipped: 1, linked: 0, invoiceOnly: 0 })
    expect(result.skipped).toBe(1)
    expect(mockInvoiceBookingVoucher).not.toHaveBeenCalled()
    expect(mockInvoicePreview).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockRecordImportedDelivery).not.toHaveBeenCalled()
  })

  it('discards its unlinked copy when another run recorded the invoice first', async () => {
    mockRecordImportedDelivery.mockResolvedValue(null)
    const { supabase, anchors } = withCustomerInvoices(wireCustomerInvoices(), [PAID])

    const result = await run(supabase)

    expect(mockDeleteDocument).toHaveBeenCalledWith(supabase, COMPANY, 'doc-1')
    expect(result.customerInvoicePdfs).toMatchObject({ skipped: 1, linked: 0, failed: 0 })
    expect(anchors).toEqual([])
  })

  it('discards its unlinked copy when the delivery cannot be recorded, so no orphan is left', async () => {
    mockRecordImportedDelivery.mockRejectedValue(new Error('Failed to persist imported invoice delivery'))
    const { supabase, anchors } = withCustomerInvoices(wireCustomerInvoices(), [PAID])

    const result = await run(supabase)

    expect(mockDeleteDocument).toHaveBeenCalledWith(supabase, COMPANY, 'doc-1')
    expect(result.customerInvoicePdfs).toMatchObject({ failed: 1, linked: 0 })
    expect(anchors).toEqual([])
  })

  it('keeps a held copy on the invoice when the verifikat link is refused', async () => {
    const { supabase } = withCustomerInvoices(wireCustomerInvoices(), [PAID], { anchorRefused: true })

    const result = await run(supabase)

    expect(result.customerInvoicePdfs).toMatchObject({ linked: 0, invoiceOnly: 1, failed: 0 })
    expect(mockDeleteDocument).not.toHaveBeenCalled()
  })

  it('stores nothing when Fortnox answers with something other than a PDF', async () => {
    mockDetectMagic.mockReturnValue(null)
    const { supabase } = withCustomerInvoices(wireCustomerInvoices(), [PAID])

    const result = await run(supabase)

    expect(result.customerInvoicePdfs).toMatchObject({ failed: 1 })
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockRecordImportedDelivery).not.toHaveBeenCalled()
  })

  describe('a copy Fortnox will not hand out', () => {
    const ACCOUNT = '5560000001'
    const badRequest = () =>
      new FortnoxApiError(
        'Fortnox API error: 400 Bad Request',
        400,
        JSON.stringify({ ErrorInformation: { error: 1, message: 'Kan inte skapa utskrift.', code: 2000999 } }),
      )
    const TWO = [PAID, { id: 'inv-2', status: 'paid', journal_entry_id: 'je-b7' }]
    const NUMBERS = { documentNumbers: { 'inv-1': '1001', 'inv-2': '1002' } }
    let errorSpy: ReturnType<typeof vi.spyOn>
    let warnSpy: ReturnType<typeof vi.spyOn>

    /** The customer invoice wiring, on a connection whose account key is ACCOUNT. */
    const wire = () => {
      const base = wireCustomerInvoices()
      mockResolveConsent.mockResolvedValue({
        consent: { provider: 'fortnox', org_number: '556000-0001' },
        accessToken: 'fortnox-token',
      } as never)
      return base
    }

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it('counts a 400 on one invoice as refused, keeps it with Fortnox\'s code, and goes on to the next invoice', async () => {
      mockInvoicePreview
        .mockRejectedValueOnce(badRequest())
        .mockResolvedValueOnce({ bytes: bytesOf('FORTNOX-PREVIEW-2'), contentType: 'application/pdf' })
      const { supabase, kept } = withCustomerInvoices(wire(), TWO, NUMBERS)

      const result = await run(supabase)

      expect(result).toMatchObject({ failed: 1, linked: 1 })
      expect(result.customerInvoicePdfs).toMatchObject({ scanned: 2, linked: 1, failed: 1, refused: 1 })
      expect(kept.value).toEqual({
        [ACCOUNT]: { '1001': { status: 400, code: '2000999', message: 'Kan inte skapa utskrift.', at: expect.any(String) } },
      })
    })

    it('logs no error per invoice: one warning for the call, naming the answer and how many got it', async () => {
      mockInvoicePreview.mockRejectedValue(badRequest())
      const { supabase } = withCustomerInvoices(wire(), TWO, NUMBERS)
      // The logger keeps warnings off the console under test; this test reads them.
      vi.stubEnv('NODE_ENV', 'development')

      await run(supabase)

      expect(errorSpy).not.toHaveBeenCalled()
      const lines = warnSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).filter((line: string) => line.includes('would not hand out'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('2000999')
      expect(lines[0]).toContain('Kan inte skapa utskrift.')
      // The answer, never the invoice it was about.
      expect(lines[0]).not.toContain('1001')
    })

    it('does not ask Fortnox again for an invoice an earlier run was refused, and still counts it', async () => {
      const at = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
      const { supabase, kept } = withCustomerInvoices(wire(), [PAID], {
        copyRefusals: { [ACCOUNT]: { '1001': { status: 400, code: '2000999', message: null, at } } },
      })

      const result = await run(supabase)

      expect(mockInvoicePreview).not.toHaveBeenCalled()
      expect(mockInvoiceBookingVoucher).not.toHaveBeenCalled()
      expect(result).toMatchObject({ failed: 1, linked: 0 })
      expect(result.customerInvoicePdfs).toMatchObject({ scanned: 1, failed: 1, refused: 1 })
      expect(kept.writes).toBe(0)
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('asks once more when the kept refusal is older than a week', async () => {
      const at = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()
      const { supabase } = withCustomerInvoices(wire(), [PAID], {
        copyRefusals: { [ACCOUNT]: { '1001': { status: 400, code: '2000999', message: null, at } } },
      })

      const result = await run(supabase)

      expect(mockInvoicePreview).toHaveBeenCalledTimes(1)
      expect(result.customerInvoicePdfs).toMatchObject({ linked: 1, failed: 0, refused: 0 })
    })

    it('keeps nothing for an answer a retry may cure: a 429 and a 500 are failures, logged, and asked again next run', async () => {
      mockInvoicePreview
        .mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 429 Too Many Requests', 429))
        .mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 500 Internal Server Error', 500))
      const { supabase, kept } = withCustomerInvoices(wire(), TWO, NUMBERS)

      const result = await run(supabase)

      expect(result.customerInvoicePdfs).toMatchObject({ failed: 2, refused: 0 })
      expect(kept.writes).toBe(0)
      const logged = errorSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes('failed to import a customer invoice copy'))
      expect(logged).toHaveLength(2)
    })

    it('keeps nothing in a dry run', async () => {
      mockInvoiceBookingVoucher.mockRejectedValue(badRequest())
      const { supabase, kept } = withCustomerInvoices(wire(), [{ ...PAID, journal_entry_id: null }])

      await run(supabase, true)

      expect(kept.writes).toBe(0)
    })

    it('still imports when the kept refusals cannot be read', async () => {
      const { supabase } = withCustomerInvoices(wire(), [PAID])
      const from = supabase.from.bind(supabase)
      vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
        if (table !== 'extension_data') return from(table)
        const node = { select: () => node, eq: () => node, maybeSingle: () => Promise.resolve({ data: null, error: { message: 'timeout' } }) }
        return node
      }) as never)

      const result = await run(supabase)

      expect(result.customerInvoicePdfs).toMatchObject({ linked: 1, failed: 0 })
    })
  })

  it('retries a copy the execution budget cut in flight, without counting it as failed (crm#1581)', async () => {
    mockInvoicePreview
      .mockResolvedValueOnce({ bytes: bytesOf('FORTNOX-PREVIEW-1'), contentType: 'application/pdf' })
      .mockRejectedValueOnce(new ExecutionBudgetExceeded('underlag-test'))
    const { supabase } = withCustomerInvoices(
      wireCustomerInvoices(),
      [PAID, { id: 'inv-2', status: 'paid', journal_entry_id: 'je-b7' }],
      { documentNumbers: { 'inv-1': '1001', 'inv-2': '1002' } },
    )

    const result = await run(supabase)

    expect(result).toMatchObject({ partial: true, failed: 0, scanned: 1 })
    expect(result.nextCursor).toMatch(/1001$/)
    expect(result.customerInvoicePdfs).toMatchObject({ scanned: 1, failed: 0 })
    expect(mockRecordImportedDelivery).toHaveBeenCalledTimes(1)
  })

  it('counts a copy the hard stop cut as the first of its slice as failed', async () => {
    mockInvoicePreview.mockRejectedValueOnce(new ExecutionBudgetExceeded('underlag-test'))
    const { supabase } = withCustomerInvoices(wireCustomerInvoices(), [PAID])

    const result = await run(supabase)

    // A fresh slice could not finish it: retrying it again would never advance.
    expect(result.customerInvoicePdfs).toMatchObject({ scanned: 1, failed: 1 })
    expect(result.partial).toBe(false)
  })

  it('counts a linked invoice in the dry run without a download, and leaves an unlinked one for the real run', async () => {
    const { supabase } = withCustomerInvoices(
      wireCustomerInvoices(),
      [PAID, { id: 'inv-2', status: 'sent', journal_entry_id: null }],
      { documentNumbers: { 'inv-1': '1001', 'inv-2': '1002' } },
    )

    const result = await run(supabase, true)

    expect(result.customerInvoicePdfs).toMatchObject({ scanned: 2, linked: 1, invoiceOnly: 0 })
    expect(mockInvoiceBookingVoucher).not.toHaveBeenCalled()
    expect(mockInvoicePreview).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })
})
