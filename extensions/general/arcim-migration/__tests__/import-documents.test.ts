import { describe, it, expect, beforeEach, vi } from 'vitest'
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
  type FortnoxFileConnection,
  type FortnoxFinancialYear,
} from '@/lib/providers/fortnox/attachments'
import { uploadDocument, computeSHA256, detectFileMagic } from '@/lib/core/documents/document-service'
import { importProviderDocuments } from '../lib/import-documents'

// The Bokio client is constructed but never called directly (the attachments
// module is mocked), so a bare stub avoids touching real config/rate-limiter.
vi.mock('@/lib/providers/bokio/client', () => ({ BokioClient: class {} }))
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
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
  computeSHA256: vi.fn(),
  detectFileMagic: vi.fn(),
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
  // Default: no recognisable signature, so the declared contentType is used.
  mockDetectMagic.mockReturnValue(null)
  mockUpload.mockResolvedValue({ id: 'doc-1' } as never)
})

// A receipt linked to Bokio entry "V33", dated inside FY2021.
const VOUCHER_REF: BokioVoucherRef = { series: 'V', number: 33, date: '2021-03-01' }
const PERIODS = [{ id: 'fp-2021', period_start: '2021-02-04', period_end: '2021-12-31' }]
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

function wireBokio(
  opts: { existingAttachments?: { sha256_hash: string; journal_entry_id: string | null }[] } = {},
) {
  mockFetchUploads.mockResolvedValue([UPLOAD] as never)
  mockFetchVoucherIndex.mockResolvedValue(new Map([['bokio-je-1', VOUCHER_REF]]))
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
    document_attachments: [],
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
      idempotency_key: 'je-1',
      extractionOwner: 'none',
    })
    expect(result).toMatchObject({ total: 1, partial: false, nextCursor: null })
  })

  it('skips a receipt already archived on the same verifikat (sha256 + journal entry idempotency)', async () => {
    const supabase = wireBokio({
      existingAttachments: [{ sha256_hash: 'sha-PDFBYTES', journal_entry_id: 'je-1' }],
    })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 0, skipped: 1 })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('still archives content already attached to a DIFFERENT verifikat (same contract, several vouchers)', async () => {
    const supabase = wireBokio({
      existingAttachments: [{ sha256_hash: 'sha-PDFBYTES', journal_entry_id: 'je-other' }],
    })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ scanned: 1, linked: 1, skipped: 0 })
    expect(mockUpload).toHaveBeenCalledTimes(1)
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
        { id: 'fp-2021-h1', period_start: '2021-02-04', period_end: '2021-06-30' },
        { id: 'fp-2021-h2', period_start: '2021-07-01', period_end: '2021-12-31' },
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

  it('counts a repeated Fortnox 401 as failed after the one refresh attempt', async () => {
    const supabase = wireFortnox()
    mockResolveConsent
      .mockResolvedValueOnce({
        consent: { provider: 'fortnox' },
        accessToken: 'expired-token',
      } as never)
      .mockResolvedValueOnce({
        consent: { provider: 'fortnox' },
        accessToken: 'still-invalid-token',
      } as never)
    mockDownloadFortnoxArchiveFile.mockRejectedValue(
      new FortnoxApiError('unauthorized', 401),
    )

    const result = await importProviderDocuments({
      supabase,
      companyId: COMPANY,
      userId: USER,
      consentId: 'c1',
    })

    expect(result).toMatchObject({ scanned: 1, linked: 0, failed: 1 })
    expect(mockResolveConsent).toHaveBeenCalledTimes(2)
    expect(mockDownloadFortnoxArchiveFile).toHaveBeenCalledTimes(2)
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
    expect(result.unmatchedSamples[0]).toMatchObject({ voucher: 'A12' })
    expect(mockDownloadFortnoxArchiveFile).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
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

  it('archives identical content onto each of several verifikat within one run', async () => {
    const upload2 = { id: 'up-2', description: 'Kontrakt', contentType: 'application/pdf', journalEntryId: 'bokio-je-2' }
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
        nextCursor: 1,
      })
      // Sorted by provider id, so the first slice is file-a, not file-c.
      expect(mockUpload.mock.calls[0][3]).toMatchObject({ name: 'a.pdf' })

      const second = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        cursor: first.nextCursor as number,
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

      expect(result).toMatchObject({ scanned: 1, linked: 1, partial: true, nextCursor: 1 })
    })

    it('treats a cursor past the end as a complete, empty slice', async () => {
      const supabase = wireFortnox({ connections: THREE_CONNECTIONS })

      const result = await importProviderDocuments({
        supabase,
        companyId: COMPANY,
        userId: USER,
        consentId: 'c1',
        cursor: 99,
      })

      expect(result).toMatchObject({ total: 3, scanned: 0, linked: 0, partial: false, nextCursor: null })
      expect(mockUpload).not.toHaveBeenCalled()
    })
  })
})
