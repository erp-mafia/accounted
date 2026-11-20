/**
 * The Fortnox underlag sweep end to end against Fortnox's HTTP shapes
 * (PH 176, crm#1146): the real FortnoxClient and attachment fetchers run
 * against a stubbed `fetch` that answers like api.fortnox.se/3, so the
 * paging, the list and detail forms of a supplier invoice and the archive
 * download are exercised as they arrive on the wire. Storage and the
 * database stay mocked, as in import-documents.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveConsent } from '@/lib/providers/resolve-consent'
import {
  uploadDocument,
  computeSHA256,
  detectFileMagic,
  isArchivedForOwnJournalEntry,
} from '@/lib/core/documents/document-service'
import { importProviderDocuments } from '../lib/import-documents'

vi.mock('@/lib/providers/bokio/client', () => ({ BokioClient: class {} }))
// The client waits between retries of a timeout or 5xx; the tests do not.
vi.mock('@/lib/http/execution-budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http/execution-budget')>()),
  waitInExecutionBudget: vi.fn(async () => {}),
}))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
  computeSHA256: vi.fn(),
  detectFileMagic: vi.fn(),
  isArchivedForOwnJournalEntry: vi.fn(),
  ALLOWED_DOCUMENT_TYPES: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
}))

const mockResolveConsent = vi.mocked(resolveConsent)
const mockUpload = vi.mocked(uploadDocument)
const mockSha256 = vi.mocked(computeSHA256)
const mockDetectMagic = vi.mocked(detectFileMagic)
const mockArchivedForOwnEntry = vi.mocked(isArchivedForOwnJournalEntry)

const COMPANY = 'company-1'
const USER = 'user-1'

// Fortnox archive file ids are lowercase UUIDs.
const FILE_A34 = '0f6b1c2a-3d4e-4f50-8a61-72b3c4d5e6f7'
const FILE_SI_112 = '5a7e2b14-9c3d-4e8f-a1b2-c3d4e5f60718'
const FILE_SI_113 = '7c9d0e1f-2a3b-4c5d-8e6f-a7b8c9d0e1f2'
const FILE_SI_114 = '8d0e1f2a-3b4c-4d5e-9f60-718293a4b5c6'
const FILE_SI_115 = '9e1f2a3b-4c5d-4e6f-a071-8293a4b5c6d7'

function meta(total: number, pages = 1, page = 1) {
  return { '@TotalResources': total, '@TotalPages': pages, '@CurrentPage': page }
}

const FINANCIAL_YEARS = {
  MetaInformation: meta(2),
  FinancialYears: [
    { '@url': 'https://api.fortnox.se/3/financialyears/5', Id: 5, FromDate: '2024-01-01', ToDate: '2024-12-31', AccountChartType: 'BAS 2024', AccountingMethod: 'ACCRUAL' },
    { '@url': 'https://api.fortnox.se/3/financialyears/6', Id: 6, FromDate: '2025-01-01', ToDate: '2025-12-31', AccountChartType: 'BAS 2025', AccountingMethod: 'ACCRUAL' },
  ],
}

const VOUCHER_FILES_2024 = {
  MetaInformation: meta(1),
  VoucherFileConnections: [
    { '@url': `https://api.fortnox.se/3/voucherfileconnections/${FILE_A34}`, FileId: FILE_A34, Name: 'kvitto-kontorsmaterial.pdf', VoucherDescription: 'Kontorsmaterial', VoucherNumber: '34', VoucherSeries: 'A', VoucherYear: 5 },
  ],
}
const NO_VOUCHER_FILES = { MetaInformation: meta(0), VoucherFileConnections: [] }

// Two pages, as Fortnox pages any register past its limit.
const SUPPLIER_FILES_PAGE_1 = {
  MetaInformation: meta(4, 2, 1),
  SupplierInvoiceFileConnections: [
    { '@url': `https://api.fortnox.se/3/supplierinvoicefileconnections/${FILE_SI_112}`, FileId: FILE_SI_112, Name: 'faktura-2024-03.pdf', SupplierInvoiceNumber: '112', SupplierName: 'Leverantören AB' },
    { '@url': `https://api.fortnox.se/3/supplierinvoicefileconnections/${FILE_SI_113}`, FileId: FILE_SI_113, Name: 'faktura-2025-01.pdf', SupplierInvoiceNumber: '113', SupplierName: 'Leverantören AB' },
  ],
}
const SUPPLIER_FILES_PAGE_2 = {
  MetaInformation: meta(4, 2, 2),
  SupplierInvoiceFileConnections: [
    { '@url': `https://api.fortnox.se/3/supplierinvoicefileconnections/${FILE_SI_114}`, FileId: FILE_SI_114, Name: 'att-attestera.pdf', SupplierInvoiceNumber: '114', SupplierName: 'Leverantören AB' },
    { '@url': `https://api.fortnox.se/3/supplierinvoicefileconnections/${FILE_SI_115}`, FileId: FILE_SI_115, Name: 'makulerad.pdf', SupplierInvoiceNumber: '115', SupplierName: 'Leverantören AB' },
  ],
}

function listItem(givenNumber: string, extra: Record<string, unknown>) {
  return {
    '@url': `https://api.fortnox.se/3/supplierinvoices/${givenNumber}`,
    Balance: '0',
    Booked: true,
    Cancel: false,
    Currency: 'SEK',
    CurrencyRate: '1',
    CurrencyUnit: 1,
    DueDate: '2024-04-15',
    GivenNumber: givenNumber,
    InvoiceDate: '2024-03-15',
    InvoiceNumber: `F-${givenNumber}`,
    SupplierName: 'Leverantören AB',
    SupplierNumber: '7',
    Total: '1250',
    ...extra,
  }
}

const SUPPLIER_INVOICES = {
  MetaInformation: meta(4),
  SupplierInvoices: [
    // The booking (D17) and the payment (E9): only the booking takes the file.
    listItem('112', {
      Vouchers: [
        { Number: 17, Series: 'D', ReferenceType: 'SUPPLIERINVOICE', Year: 5 },
        { Number: 9, Series: 'E', ReferenceType: 'SUPPLIERPAYMENT', Year: 5 },
      ],
    }),
    // The list form names no voucher: the detail form must tell.
    listItem('113', { InvoiceDate: '2025-01-20' }),
    listItem('114', { Booked: false, Vouchers: [] }),
    listItem('115', { Cancel: true, Vouchers: [] }),
  ],
}

const SUPPLIER_INVOICE_113 = {
  SupplierInvoice: {
    '@url': 'https://api.fortnox.se/3/supplierinvoices/113',
    GivenNumber: '113',
    InvoiceDate: '2025-01-20',
    Booked: true,
    Cancelled: false,
    VoucherSeries: 'D',
    VoucherNumber: 3,
    VoucherYear: 6,
    Total: 800,
  },
}

type Route = { status?: number; json?: unknown; bytes?: string; body?: string; timeout?: true }

function forbidden(message: string, code: number): Route {
  return { status: 403, body: JSON.stringify({ ErrorInformation: { error: 1, message, code } }) }
}

/** Answers like api.fortnox.se/3; any unrouted request fails the test loudly. */
function stubFortnox(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    '/financialyears?page=1&limit=500': { json: FINANCIAL_YEARS },
    '/voucherfileconnections?financialyear=5&page=1&limit=500': { json: VOUCHER_FILES_2024 },
    '/voucherfileconnections?financialyear=6&page=1&limit=500': { json: NO_VOUCHER_FILES },
    '/supplierinvoicefileconnections?page=1&limit=500': { json: SUPPLIER_FILES_PAGE_1 },
    '/supplierinvoicefileconnections?page=2&limit=500': { json: SUPPLIER_FILES_PAGE_2 },
    '/supplierinvoices?page=1&limit=100': { json: SUPPLIER_INVOICES },
    '/supplierinvoices/113': { json: SUPPLIER_INVOICE_113 },
    [`/archive/${FILE_A34}`]: { bytes: 'PDF-A34' },
    [`/archive/${FILE_SI_112}`]: { bytes: 'PDF-SI-112' },
    [`/archive/${FILE_SI_113}`]: { bytes: 'PDF-SI-113' },
    ...overrides,
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const path = `${url.pathname.replace(/^\/3/, '')}${url.search}`
    const route = routes[path]
    // 418: a status the client never retries, so a stray request fails fast.
    if (!route) return new Response(`unrouted ${path}`, { status: 418 })
    // What AbortSignal.timeout throws when Fortnox outlasts the 15 s limit.
    if (route.timeout) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (route.bytes !== undefined) {
      return new Response(new TextEncoder().encode(route.bytes), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
    }
    if (route.json !== undefined) {
      return new Response(JSON.stringify(route.json), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(route.body ?? '', { status: route.status ?? 500 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const requested = () =>
    fetchMock.mock.calls.map(([input]) => {
      const url = new URL(String(input))
      return `${url.pathname.replace(/^\/3/, '')}${url.search}`
    })
  return { fetchMock, requested }
}

type Row = Record<string, unknown>

function rangeMockSupabase(byTable: Record<string, Row[]>): SupabaseClient {
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
  return {
    from: (table: string) => builder(table),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as unknown as SupabaseClient
}

const PERIODS: Row[] = [
  { id: 'fp-2024', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false, locked_at: null },
  { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: false, locked_at: null },
]

function entry(id: string, period: string, date: string, series: string, number: number, status = 'posted'): Row {
  return { id, fiscal_period_id: period, entry_date: date, source_voucher_series: series, source_voucher_number: number, status }
}

// D17 exists in both years: only Fortnox's financial year tells them apart.
const ENTRIES: Row[] = [
  entry('je-a34', 'fp-2024', '2024-03-02', 'A', 34),
  entry('je-d17-2024', 'fp-2024', '2024-03-15', 'D', 17),
  entry('je-d17-2025', 'fp-2025', '2025-02-01', 'D', 17),
  entry('je-d3-2025', 'fp-2025', '2025-01-20', 'D', 3),
]

function supabaseWith(opts: { entries?: Row[]; attachments?: Row[]; periods?: Row[] } = {}) {
  return rangeMockSupabase({
    fiscal_periods: opts.periods ?? PERIODS,
    journal_entries: opts.entries ?? ENTRIES,
    document_attachments: opts.attachments ?? [],
  })
}

function linkedEntries(): string[] {
  return mockUpload.mock.calls.map(([, , , , metadata]) => (metadata as { journal_entry_id: string }).journal_entry_id)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  mockResolveConsent.mockResolvedValue({
    consent: { provider: 'fortnox' },
    accessToken: 'fortnox-token',
    providerCompanyId: undefined,
  } as never)
  mockSha256.mockImplementation(async (buf: ArrayBuffer) => 'sha-' + Buffer.from(buf).toString('utf8'))
  mockDetectMagic.mockReturnValue('application/pdf')
  let documentNumber = 0
  mockUpload.mockImplementation(async () => ({ id: `doc-${++documentNumber}` }) as never)
  mockArchivedForOwnEntry.mockResolvedValue(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Fortnox supplier-invoice files (PH 176)', () => {
  it('links each supplier-invoice file to the verifikat that booked the invoice, beside the voucher files', async () => {
    const { requested } = stubFortnox()

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    // A34 from the voucher register; 112 and 113 from the supplier invoices.
    // 114 (never booked) and 115 (cancelled) have no verifikat to sit on.
    expect(result).toMatchObject({ provider: 'fortnox', total: 3, scanned: 3, linked: 3, skipped: 0, unmatched: 0, failed: 0, unreachableSources: [] })
    // 112 is D17 of financial year 5 (2024), never the 2025 D17.
    expect(linkedEntries()).toEqual(['je-a34', 'je-d17-2024', 'je-d3-2025'])
    const [, , , file, metadata] = mockUpload.mock.calls[1]
    expect(file).toMatchObject({ name: 'faktura-2024-03.pdf', type: 'application/pdf' })
    expect(metadata).toMatchObject({ upload_source: 'api', journal_entry_id: 'je-d17-2024', idempotency_key: 'je-d17-2024', extractionOwner: 'none' })

    // The detail form is read only for the invoice whose list form named no
    // booking, and the payment voucher (E9) never gets the file.
    expect(requested().filter((path) => path.startsWith('/supplierinvoices/'))).toEqual(['/supplierinvoices/113'])
    expect(requested()).not.toContain(`/archive/${FILE_SI_114}`)
    expect(requested()).not.toContain(`/archive/${FILE_SI_115}`)
  })

  it('previews without downloads or detail reads: the list-resolved file counts, the pending one is found', async () => {
    const { requested } = stubFortnox()

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1', dryRun: true })

    expect(result).toMatchObject({ dryRun: true, total: 3, scanned: 3, linked: 2, unmatched: 0, failed: 0 })
    expect(requested().some((path) => path.startsWith('/archive/'))).toBe(false)
    expect(requested().some((path) => path.startsWith('/supplierinvoices/'))).toBe(false)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('is idempotent: a re-run skips the file already archived on that verifikat', async () => {
    stubFortnox()
    const supabase = supabaseWith({
      attachments: [
        { id: 'doc-a34', sha256_hash: 'sha-PDF-A34', journal_entry_id: 'je-a34', upload_source: 'api' },
        { id: 'doc-112', sha256_hash: 'sha-PDF-SI-112', journal_entry_id: 'je-d17-2024', upload_source: 'api' },
        { id: 'doc-113', sha256_hash: 'sha-PDF-SI-113', journal_entry_id: 'je-d3-2025', upload_source: 'api' },
      ],
    })
    mockArchivedForOwnEntry.mockResolvedValue(true)

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ linked: 0, skipped: 3, failed: 0 })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('leaves a verifikat alone that already has underlag from elsewhere, without downloading', async () => {
    const { requested } = stubFortnox()
    const supabase = supabaseWith({
      attachments: [{ id: 'manual', sha256_hash: 'sha-own-scan', journal_entry_id: 'je-d17-2024', upload_source: 'user' }],
    })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ linked: 2, skipped: 1, failed: 0 })
    expect(linkedEntries()).toEqual(['je-a34', 'je-d3-2025'])
    expect(requested()).not.toContain(`/archive/${FILE_SI_112}`)
  })

  it('downloads a file connected to both the voucher and its supplier invoice once', async () => {
    const { requested } = stubFortnox({
      '/voucherfileconnections?financialyear=5&page=1&limit=500': {
        json: {
          MetaInformation: meta(2),
          VoucherFileConnections: [
            ...VOUCHER_FILES_2024.VoucherFileConnections,
            { FileId: FILE_SI_112, Name: 'faktura-2024-03.pdf', VoucherDescription: 'Leverantören AB', VoucherNumber: '17', VoucherSeries: 'D', VoucherYear: 5 },
          ],
        },
      },
    })

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ total: 3, linked: 3, skipped: 0 })
    expect(requested().filter((path) => path === `/archive/${FILE_SI_112}`)).toHaveLength(1)
  })

  it('links to the live verifikat, never the reversed copy a re-sync left in the same year (PH 163)', async () => {
    stubFortnox()
    const supabase = supabaseWith({
      entries: [
        entry('je-a34-first-copy', 'fp-2024', '2024-03-02', 'A', 34, 'reversed'),
        entry('je-d17-2024-first-copy', 'fp-2024', '2024-03-15', 'D', 17, 'reversed'),
        ...ENTRIES,
      ],
    })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    // Both the voucher file (A34) and the supplier-invoice file (D17) land on
    // the live copy of their verifikat.
    expect(result).toMatchObject({ linked: 3, unmatched: 0, failed: 0 })
    expect(linkedEntries()).toEqual(['je-a34', 'je-d17-2024', 'je-d3-2025'])
  })

  it('leaves a supplier-invoice file unmatched when only a reversed copy carries its verifikat', async () => {
    const { requested } = stubFortnox()
    const supabase = supabaseWith({
      entries: [
        ...ENTRIES.filter((row) => row.id !== 'je-d17-2024'),
        entry('je-d17-2024-first-copy', 'fp-2024', '2024-03-15', 'D', 17, 'reversed'),
      ],
    })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ linked: 2, unmatched: 1 })
    expect(result.unmatchedSamples).toEqual([
      { uploadId: `si:112:${FILE_SI_112}`, voucher: 'D17', date: '2024-01-01', reason: 'only_reversed' },
    ])
    expect(requested()).not.toContain(`/archive/${FILE_SI_112}`)
  })

  it('reports a locked year without downloading the supplier-invoice file', async () => {
    const { requested } = stubFortnox()
    const supabase = supabaseWith({
      periods: [PERIODS[0], { ...PERIODS[1], is_closed: true }],
    })

    const result = await importProviderDocuments({ supabase, companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ linked: 2, locked: 1, failed: 0, lockedPeriods: ['2025'] })
    expect(requested()).not.toContain(`/archive/${FILE_SI_113}`)
  })

  it('names connectfile when Fortnox refuses the supplier-invoice file register, and still links the voucher files', async () => {
    stubFortnox({
      '/supplierinvoicefileconnections?page=1&limit=500': forbidden('Har inte behörighet för scope.', 2000663),
    })

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ total: 1, linked: 1, failed: 0 })
    expect(linkedEntries()).toEqual(['je-a34'])
    expect(result.unreachableSources).toEqual([
      { source: 'supplier_invoice_files', scope: 'connectfile', reason: 'permission', providerMessage: 'Har inte behörighet för scope.' },
    ])
  })

  it('names a missing supplierinvoice licence apart from a missing permission', async () => {
    stubFortnox({
      '/supplierinvoices?page=1&limit=100': forbidden('Det finns ingen aktiv licens för önskat scope.', 2001101),
    })

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ total: 1, linked: 1 })
    expect(result.unreachableSources).toEqual([
      { source: 'supplier_invoice_files', scope: 'supplierinvoice', reason: 'license', providerMessage: 'Det finns ingen aktiv licens för önskat scope.' },
    ])
  })

  it('reports a failing supplier-invoice listing as an error, not a refusal, and keeps the voucher files', async () => {
    stubFortnox({
      '/supplierinvoicefileconnections?page=1&limit=500': { status: 400, body: JSON.stringify({ ErrorInformation: { error: 1, message: 'Ogiltig parameter.', code: 2000588 } }) },
    })

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ total: 1, linked: 1 })
    expect(result.unreachableSources).toEqual([
      { source: 'supplier_invoice_files', scope: 'connectfile', reason: 'error', providerMessage: 'Ogiltig parameter.' },
    ])
    // The files that source keeps were not listed, so the run is not over:
    // the next slice lists again after the last handled file (crm#1642).
    expect(result).toMatchObject({ partial: true, nextCursor: FILE_A34 })
  })

  it('keeps a run open, without moving, when a later slice cannot list the supplier-invoice files (crm#1642)', async () => {
    stubFortnox({
      '/supplierinvoicefileconnections?page=1&limit=500': { timeout: true },
    })

    // The run is past its voucher files: everything it has left is on supplier invoices.
    const result = await importProviderDocuments({
      supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1', cursor: FILE_A34,
    })

    // It used to answer partial: false here, so the run ended "complete" with
    // its supplier-invoice files never reached. Not moving reads as stalled to
    // both drivers, which retry from the saved point.
    expect(result).toMatchObject({ scanned: 0, linked: 0, partial: true, nextCursor: FILE_A34 })
    expect(result.unreachableSources).toMatchObject([{ scope: 'connectfile', reason: 'error' }])
  })

  it('still ends a run that a refusal, not an error, left without the supplier-invoice files', async () => {
    stubFortnox({
      '/supplierinvoicefileconnections?page=1&limit=500': forbidden('Har inte behörighet för scope.', 2000663),
    })

    const result = await importProviderDocuments({
      supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1', cursor: FILE_A34,
    })

    expect(result).toMatchObject({ scanned: 0, partial: false, nextCursor: null })
    expect(result.unreachableSources).toMatchObject([{ scope: 'connectfile', reason: 'permission' }])
  })

  it('previews a failing listing as a finished look, not a run left open', async () => {
    stubFortnox({
      '/supplierinvoicefileconnections?page=1&limit=500': { timeout: true },
    })

    const result = await importProviderDocuments({
      supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1', dryRun: true,
    })

    expect(result).toMatchObject({ dryRun: true, total: 1, partial: false, nextCursor: null })
  })

  it('links every supplier-invoice file through its detail form when the invoice list times out (crm#1642)', async () => {
    const { requested } = stubFortnox({
      '/supplierinvoices?page=1&limit=100': { timeout: true },
      '/supplierinvoices/112': {
        json: { SupplierInvoice: { GivenNumber: '112', Booked: true, Cancelled: false, VoucherSeries: 'D', VoucherNumber: 17, VoucherYear: 5 } },
      },
      '/supplierinvoices/114': {
        json: { SupplierInvoice: { GivenNumber: '114', Booked: false, Cancelled: false, VoucherSeries: 'D', VoucherNumber: 0, VoucherYear: 6 } },
      },
      '/supplierinvoices/115': {
        json: { SupplierInvoice: { GivenNumber: '115', Booked: false, Cancelled: true, VoucherSeries: 'D', VoucherNumber: 0, VoucherYear: 6 } },
      },
    })

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    // Six attempts at the list, as in production, then each invoice is asked on its own.
    expect(requested().filter((path) => path === '/supplierinvoices?page=1&limit=100')).toHaveLength(6)
    // The files come in as with the list: 112 on D17 of 2024, 113 on D3 of
    // 2025. 114 (never booked) and 115 (cancelled) have no verifikat; without
    // the list they are counted as unmatched instead of being left out.
    expect(result).toMatchObject({ total: 5, linked: 3, unmatched: 2, failed: 0, partial: false, unreachableSources: [] })
    expect(linkedEntries()).toEqual(['je-a34', 'je-d17-2024', 'je-d3-2025'])
    expect(requested()).not.toContain(`/archive/${FILE_SI_114}`)
    expect(requested()).not.toContain(`/archive/${FILE_SI_115}`)
  })

  it('stops supplier-invoice downloads Fortnox refuses (archive) without failing the voucher files', async () => {
    const { requested } = stubFortnox({
      [`/archive/${FILE_SI_112}`]: forbidden('Har inte behörighet för scope.', 2000663),
    })

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    expect(result).toMatchObject({ linked: 1, failed: 0 })
    expect(linkedEntries()).toEqual(['je-a34'])
    expect(result.unreachableSources).toMatchObject([{ scope: 'archive', reason: 'permission' }])
    // 113 sorts after 112 and is not tried once the scope was refused.
    expect(requested()).not.toContain('/supplierinvoices/113')
    expect(requested()).not.toContain(`/archive/${FILE_SI_113}`)
  })

  it('counts a supplier invoice whose financial year Fortnox does not list as unmatched', async () => {
    stubFortnox({
      '/supplierinvoices?page=1&limit=100': {
        json: {
          MetaInformation: meta(1),
          SupplierInvoices: [listItem('112', { Vouchers: [{ Number: 17, Series: 'D', ReferenceType: 'SUPPLIERINVOICE', Year: 2024 }] })],
        },
      },
      '/supplierinvoices/113': { json: { SupplierInvoice: { GivenNumber: '113', VoucherSeries: 'D', VoucherNumber: 0, VoucherYear: 6 } } },
      '/supplierinvoices/114': { status: 404, body: JSON.stringify({ ErrorInformation: { error: 1, message: 'Kan inte hitta leverantörsfakturan.', code: 2000434 } }) },
      '/supplierinvoices/115': { status: 404, body: '' },
    })

    const result = await importProviderDocuments({ supabase: supabaseWith(), companyId: COMPANY, userId: USER, consentId: 'c1' })

    // 112 names year "2024", which is no financial-year id; 113's detail form
    // names no voucher; 114 and 115 are missing from this listing, and their
    // detail forms answer 404. None is a guess, none is a failure.
    expect(result).toMatchObject({ linked: 1, failed: 0, unmatched: 4 })
    expect(linkedEntries()).toEqual(['je-a34'])
    expect(result.unmatchedSamples.map((sample) => sample.voucher)).toEqual([
      '(supplier invoice 112)',
      '(supplier invoice 113)',
      '(supplier invoice 114)',
      '(supplier invoice 115)',
    ])
  })
})
