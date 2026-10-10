/**
 * lines[].vat_code on POST /api/v1/companies/:companyId/journal-entries and
 * /journal-entries/batch-create (crm#1096).
 *
 * The manual verifikat form takes a momskod per line and posts the
 * reverse-charge lines it generates. Before this, v1 stripped an unknown
 * vat_code key and posted the lines without them, so a purchase booked over
 * the API needed hand-typed fiktiv moms and basis lines. A line's vat_code now
 * expands through the form's own derivation (expandVoucherLineVatCodes), read
 * against the company's kontoplan; the draft, the dry run and the batch all
 * carry the expanded lines, and a code that cannot post as asked is a 400 on
 * lines.N.vat_code before anything is written.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/api/v1/owns-fiscal-period', () => ({
  ownsFiscalPeriod: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, createDraftEntry: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { POST } from '../route'
import { POST as BATCH_POST } from '../batch-create/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockFindUnresolvable = findUnresolvableAccounts as ReturnType<typeof vi.fn>
const mockCreateDraft = createDraftEntry as ReturnType<typeof vi.fn>
const mockOwnsFiscalPeriod = ownsFiscalPeriod as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FISCAL_PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ENTRY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const NON_EU_25 = { kind: 'non_eu_services', rate: 0.25 }

/**
 * The configured class 4-6 kontoplan rows fetchChartVatTreatments reads: 6560
 * is set to EU services at 12 %, and the BAS basis account for domestic
 * services at 6 % (4427) is set to 25 %.
 */
const CHART_ROWS = [
  { account_number: '4427', default_vat_treatment: 'reverse_charge_domestic', default_vat_rate: 0.25 },
  { account_number: '6560', default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: '0.12' },
]

/**
 * company_members proves the key may touch this company; chart_of_accounts
 * answers the kontoplan's momskoder; every other read (the idempotency store,
 * the refetch of the created draft) answers null.
 */
function makeSupabase() {
  const build = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          const data = table === 'chart_of_accounts' ? CHART_ROWS : null
          return (resolve: (v: unknown) => void) => resolve({ data, error: null })
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          const row = table === 'company_members'
            ? { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' }
            : null
          return () => Promise.resolve({ data: row, error: null })
        }
        return () => build(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => build(table)) }
}

let supabase: ReturnType<typeof makeSupabase>
const chartReads = () => supabase.from.mock.calls.filter(([table]) => table === 'chart_of_accounts').length

function makeBody(lines: Array<Record<string, unknown>>) {
  return { fiscal_period_id: FISCAL_PERIOD_ID, entry_date: '2026-05-12', description: 'Licens, leverantör utanför EU', lines }
}

const PURCHASE = [
  { account_number: '6540', debit_amount: 1000, vat_code: NON_EU_25, dimensions: { '6': 'P001' } },
  { account_number: '1930', credit_amount: 1000 },
]

function makeRequest(body: unknown, { auth = true, dryRun = false, batch = false } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': `idem${Math.floor(Math.random() * 1e6)}-1010-4abc-8def-1234567890ab`,
  }
  if (auth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  const path = `/api/v1/companies/${COMPANY_ID}/journal-entries${batch ? '/batch-create' : ''}`
  return new Request(`http://localhost${path}${dryRun ? '?dry_run=true' : ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

interface V1ErrorBody {
  error: {
    code: string
    details?: { issues?: Array<{ field: string; message: string; message_en?: string }> }
  }
}

type PostedLine = { account_number: string; debit_amount: number; credit_amount: number; dimensions?: Record<string, string> }

/** The lines handed to the engine, as [account, debit, credit]. */
const draftLines = (call = 0) =>
  (mockCreateDraft.mock.calls[call][3] as { lines: PostedLine[] }).lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

/** 6540 with tjänst utanför EU 25 %: the purchase, its fiktiv moms and the ruta 22 basis pair. */
const EXPANDED_PURCHASE = [
  ['6540', 1000, 0],
  ['2645', 250, 0],
  ['2614', 0, 250],
  ['4531', 1000, 0],
  ['4598', 0, 1000],
  ['1930', 0, 1000],
]

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
  supabase = makeSupabase()
  mockServiceClient.mockReturnValue(supabase)
  mockFindUnresolvable.mockResolvedValue([])
  mockOwnsFiscalPeriod.mockResolvedValue(true)
  mockCreateDraft.mockResolvedValue({ id: ENTRY_ID, status: 'draft', voucher_series: 'A', voucher_number: 0 })
})

describe('POST /journal-entries: lines[].vat_code', () => {
  it('401 without an API key', async () => {
    const res = await POST(makeRequest(makeBody(PURCHASE), { auth: false }), routeParams)
    expect(res.status).toBe(401)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('creates the draft with the reverse-charge lines under the coded line', async () => {
    const res = await POST(makeRequest(makeBody(PURCHASE)), routeParams)

    expect(res.status).toBe(201)
    expect(draftLines()).toEqual(EXPANDED_PURCHASE)
    const lines = (mockCreateDraft.mock.calls[0][3] as { lines: PostedLine[] }).lines
    // The typed line keeps its dimensions; the generated ones carry none, as in the form.
    expect(lines[0].dimensions).toEqual({ '6': 'P001' })
    expect(lines.slice(1, 5).every((l) => l.dimensions === undefined)).toBe(true)
    expect(lines.every((l) => !('vat_code' in l))).toBe(true)
    expect(mockCreateDraft.mock.calls[0][1]).toBe(COMPANY_ID)
  })

  it('previews the expanded verifikat on a dry run and resolves the generated accounts too', async () => {
    const res = await POST(makeRequest(makeBody(PURCHASE), { dryRun: true }), routeParams)
    const body = (await res.json()) as {
      data: { dry_run: boolean; preview: { lines: Array<PostedLine & { sort_order: number }>; totals: { debit: number; credit: number } } }
    }

    expect(res.status).toBe(200)
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual(EXPANDED_PURCHASE)
    expect(body.data.preview.lines.map((l) => l.sort_order)).toEqual([0, 1, 2, 3, 4, 5])
    expect(body.data.preview.totals).toEqual({ debit: 2250, credit: 2250 })
    expect(mockFindUnresolvable).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      ['6540', '2645', '2614', '4531', '4598', '1930'],
    )
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('takes an account\'s own momskod from the kontoplan: fiktiv moms at its 12 %, no basis pair', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '6560', debit_amount: 500, vat_code: { kind: 'eu_services', rate: 0.12 } },
        { account_number: '2440', credit_amount: 500 },
      ])),
      routeParams,
    )

    expect(res.status).toBe(201)
    expect(draftLines()).toEqual([
      ['6560', 500, 0],
      ['2645', 60, 0],
      ['2624', 0, 60],
      ['2440', 0, 500],
    ])
  })

  it('reads no kontoplan and posts the lines as sent when no line has a vat_code', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '4531', debit_amount: 1000 },
        { account_number: '1930', credit_amount: 1000 },
      ])),
      routeParams,
    )

    expect(res.status).toBe(201)
    expect(draftLines()).toEqual([['4531', 1000, 0], ['1930', 0, 1000]])
    expect(chartReads()).toBe(0)
  })

  it('400 VALIDATION_ERROR for a percent-shaped rate, before any read', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '6540', debit_amount: 1000, vat_code: { kind: 'non_eu_services', rate: 25 } },
        { account_number: '1930', credit_amount: 1000 },
      ])),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.issues).toContainEqual({
      field: 'lines.0.vat_code.rate',
      message: 'rate måste vara ett decimaltal, inte procent: 0.25, 0.12 eller 0.06',
    })
    expect(mockOwnsFiscalPeriod).not.toHaveBeenCalled()
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR for a vat_code without a rate, with no percent hint', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '6540', debit_amount: 1000, vat_code: { kind: 'non_eu_services' } },
        { account_number: '1930', credit_amount: 1000 },
      ])),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.details?.issues).toContainEqual({
      field: 'lines.0.vat_code.rate',
      message: 'rate krävs: 0.25, 0.12 eller 0.06',
    })
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR on lines.N.vat_code for a code on an account that takes none', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '6540', debit_amount: 1000 },
        { account_number: '1930', credit_amount: 1000, vat_code: NON_EU_25 },
      ])),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.issues).toEqual([{
      field: 'lines.1.vat_code',
      message: expect.stringContaining('Konto 1930 kan inte ha en momskod'),
      message_en: expect.stringContaining('Account 1930 takes no vat_code'),
    }])
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR for a code beside hand-typed lines on the accounts it creates', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '6540', debit_amount: 1000, vat_code: NON_EU_25 },
        { account_number: '2645', debit_amount: 250 },
        { account_number: '2614', credit_amount: 250 },
        { account_number: '1930', credit_amount: 1000 },
      ])),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.details?.issues?.[0]).toMatchObject({
      field: 'lines.0.vat_code',
      message_en: expect.stringContaining('creates 2614, 2645 itself'),
    })
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR naming the account\'s own code when another is sent on an account with its own box', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '6560', debit_amount: 500, vat_code: { kind: 'eu_services', rate: 0.25 } },
        { account_number: '2440', credit_amount: 500 },
      ])),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.details?.issues?.[0].message_en).toContain('{"kind":"eu_services","rate":0.12}')
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR when the kontoplan sets the code\'s basis account to another momssats', async () => {
    const res = await POST(
      makeRequest(makeBody([
        { account_number: '6540', debit_amount: 1000, vat_code: { kind: 'domestic_services', rate: 0.06 } },
        { account_number: '2440', credit_amount: 1000 },
      ])),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.issues).toEqual([{
      field: 'lines.0.vat_code',
      message: expect.stringContaining('redovisar ruta 24 med 25 %, inte ruta 24 med 6 %'),
      message_en: expect.stringContaining('books its basis on 4427'),
    }])
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('404 NOT_FOUND for a fiscal period outside the company, before the kontoplan is read', async () => {
    mockOwnsFiscalPeriod.mockResolvedValue(false)

    const res = await POST(makeRequest(makeBody(PURCHASE)), routeParams)
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(chartReads()).toBe(0)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })
})

describe('POST /journal-entries/batch-create: lines[].vat_code', () => {
  it('expands each entry, reads the kontoplan once, and fails only the entry whose code is refused', async () => {
    const res = await BATCH_POST(
      makeRequest(
        {
          journal_entries: [
            makeBody(PURCHASE),
            makeBody([
              { account_number: '1930', debit_amount: 100, vat_code: NON_EU_25 },
              { account_number: '2893', credit_amount: 100 },
            ]),
            makeBody([
              { account_number: '6560', debit_amount: 500, vat_code: { kind: 'eu_services', rate: 0.12 } },
              { account_number: '2440', credit_amount: 500 },
            ]),
          ],
        },
        { batch: true },
      ),
      routeParams,
    )
    const body = (await res.json()) as {
      data: {
        results: Array<{ ok: boolean; request_index: number; error?: { code: string; details?: { issues?: Array<{ field: string }> } } }>
        summary: { total: number; succeeded: number; failed: number }
      }
    }

    expect(res.status).toBe(200)
    expect(body.data.summary).toEqual({ total: 3, succeeded: 2, failed: 1 })
    expect(body.data.results[1]).toMatchObject({
      ok: false,
      request_index: 1,
      error: { code: 'VALIDATION_ERROR', details: { issues: [{ field: 'lines.0.vat_code' }] } },
    })
    expect(mockCreateDraft).toHaveBeenCalledTimes(2)
    expect(draftLines(0)).toEqual(EXPANDED_PURCHASE)
    expect(draftLines(1)).toEqual([['6560', 500, 0], ['2645', 60, 0], ['2624', 0, 60], ['2440', 0, 500]])
    expect(chartReads()).toBe(1)
  })

  it('refuses an entry that does not balance as sent with the caller\'s own totals, before its code is expanded', async () => {
    // The engine's own balance check, as in production: it throws before any read.
    const { createDraftEntry: realCreateDraft } =
      await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
    mockCreateDraft.mockImplementationOnce(realCreateDraft)

    const res = await BATCH_POST(
      makeRequest(
        {
          journal_entries: [
            makeBody([
              { account_number: '6540', debit_amount: 1000, vat_code: NON_EU_25 },
              { account_number: '1930', credit_amount: 900 },
            ]),
            makeBody(PURCHASE),
          ],
        },
        { batch: true },
      ),
      routeParams,
    )
    const body = (await res.json()) as {
      data: { results: Array<{ ok: boolean; error?: { code: string; message: string } }> }
    }

    expect(res.status).toBe(200)
    expect(body.data.results[0]).toMatchObject({ ok: false, error: { code: 'JOURNAL_ENTRY_NOT_BALANCED' } })
    // The engine saw the two lines as sent (1000 / 900), not 2250 / 2150.
    expect(draftLines(0)).toEqual([['6540', 1000, 0], ['1930', 0, 900]])
    expect(body.data.results[1].ok).toBe(true)
    expect(draftLines(1)).toEqual(EXPANDED_PURCHASE)
  })

  it('400 for the whole batch when one entry\'s vat_code is malformed: a schema error, not a per-entry refusal', async () => {
    const res = await BATCH_POST(
      makeRequest(
        {
          journal_entries: [
            makeBody(PURCHASE),
            makeBody([
              { account_number: '6540', debit_amount: 1000, vat_code: { kind: 'non_eu_services', rate: 25 } },
              { account_number: '1930', credit_amount: 1000 },
            ]),
          ],
        },
        { batch: true },
      ),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.issues?.map((i) => i.field)).toEqual(['journal_entries.1.lines.0.vat_code.rate'])
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('previews the expanded lines on a dry run', async () => {
    const res = await BATCH_POST(
      makeRequest({ journal_entries: [makeBody(PURCHASE)] }, { batch: true, dryRun: true }),
      routeParams,
    )
    const body = (await res.json()) as {
      data: { preview: { results: Array<{ data: { preview: { lines: PostedLine[] } } }> } }
    }

    expect(res.status).toBe(200)
    expect(body.data.preview.results[0].data.preview.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]))
      .toEqual(EXPANDED_PURCHASE)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })
})
