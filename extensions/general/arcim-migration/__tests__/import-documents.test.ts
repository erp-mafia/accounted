import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveConsent } from '@/lib/providers/resolve-consent'
import {
  fetchBokioUploads,
  fetchBokioVoucherIndex,
  downloadBokioUpload,
  type BokioVoucherRef,
} from '@/lib/providers/bokio/attachments'
import { uploadDocument, computeSHA256 } from '@/lib/core/documents/document-service'
import { importProviderDocuments } from '../lib/import-documents'

// The Bokio client is constructed but never called directly (the attachments
// module is mocked), so a bare stub avoids touching real config/rate-limiter.
vi.mock('@/lib/providers/bokio/client', () => ({ BokioClient: class {} }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/providers/bokio/attachments', () => ({
  fetchBokioUploads: vi.fn(),
  fetchBokioVoucherIndex: vi.fn(),
  downloadBokioUpload: vi.fn(),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
  computeSHA256: vi.fn(),
  ALLOWED_DOCUMENT_TYPES: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
}))

const mockResolveConsent = vi.mocked(resolveConsent)
const mockFetchUploads = vi.mocked(fetchBokioUploads)
const mockFetchVoucherIndex = vi.mocked(fetchBokioVoucherIndex)
const mockDownload = vi.mocked(downloadBokioUpload)
const mockUpload = vi.mocked(uploadDocument)
const mockSha256 = vi.mocked(computeSHA256)

const COMPANY = 'company-1'
const USER = 'user-1'

/** Supabase mock whose chained `.range()` resolves to the rows for that table. */
function rangeMockSupabase(byTable: Record<string, unknown[]>): SupabaseClient {
  const builder = (table: string) => {
    const node = {
      select: () => node,
      eq: () => node,
      not: () => node,
      order: () => node,
      range: () => Promise.resolve({ data: byTable[table] ?? [], error: null }),
    }
    return node
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
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
  mockUpload.mockResolvedValue({ id: 'doc-1' } as never)
})

// A receipt linked to Bokio entry "V33", dated inside FY2021.
const VOUCHER_REF: BokioVoucherRef = { series: 'V', number: 33, date: '2021-03-01' }
const PERIODS = [{ id: 'fp-2021', period_start: '2021-02-04', period_end: '2021-12-31' }]
const GNUBOK_VOUCHERS = [
  { id: 'je-1', fiscal_period_id: 'fp-2021', source_voucher_series: 'V', source_voucher_number: 33 },
]
const UPLOAD = { id: 'up-1', description: 'Kvitto', contentType: 'application/pdf', journalEntryId: 'bokio-je-1' }

function wireBokio(opts: { existingHashes?: { sha256_hash: string }[] } = {}) {
  mockFetchUploads.mockResolvedValue([UPLOAD] as never)
  mockFetchVoucherIndex.mockResolvedValue(new Map([['bokio-je-1', VOUCHER_REF]]))
  mockDownload.mockResolvedValue({ bytes: bytesOf('PDFBYTES'), contentType: 'application/octet-stream' })
  return rangeMockSupabase({
    fiscal_periods: PERIODS,
    journal_entries: GNUBOK_VOUCHERS,
    document_attachments: opts.existingHashes ?? [],
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
    expect(metadata).toEqual({ upload_source: 'api', journal_entry_id: 'je-1' })
  })

  it('skips a receipt already archived for the company (sha256 idempotency)', async () => {
    const supabase = wireBokio({ existingHashes: [{ sha256_hash: 'sha-PDFBYTES' }] })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 0, skipped: 1 })
    expect(mockUpload).not.toHaveBeenCalled()
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

  it('is a no-op for non-Bokio providers in v1', async () => {
    mockResolveConsent.mockResolvedValue({
      consent: { provider: 'fortnox' },
      accessToken: 'tok',
      providerCompanyId: 'co',
    } as never)

    const result = await importProviderDocuments({ supabase: rangeMockSupabase({}), companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ provider: 'fortnox', scanned: 0, linked: 0 })
    expect(mockFetchUploads).not.toHaveBeenCalled()
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
        { id: 'je-1', fiscal_period_id: 'fp-2021', source_voucher_series: 'V', source_voucher_number: 33 },
        { id: 'je-2', fiscal_period_id: 'fp-2021', source_voucher_series: 'V', source_voucher_number: 34 },
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
})
