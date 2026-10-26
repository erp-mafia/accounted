/**
 * POST /api/v1/companies/:companyId/journal-entries/:id/reverse
 *
 * The storno is numbered in the original's series and booked into the
 * original's fiscal year, so it is dated inside that year too: by default on
 * the original's date (founder decision 2026-10-13, as the app and MCP do),
 * never today. A date outside the year is 400; a locked or closed year is
 * PERIOD_LOCKED before any voucher number is drawn, and a dry run gives the
 * same verdict (BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})

const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, reverseEntry: (...args: unknown[]) => reverseEntryMock(...args) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { TargetPeriodLockedError } from '@/lib/bookkeeping/errors'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

/** Per-table answers (the last entry repeats) that record every (table, method, args). */
function makeClient(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const { supabase, calls } = createTableMockSupabase(byTable)
  return Object.assign(supabase, { calls })
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const REVERSAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/journal-entries/${ENTRY_ID}/reverse`
const params = (id = ENTRY_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

const ORIGINAL = {
  data: {
    id: ENTRY_ID,
    status: 'posted',
    entry_date: '2025-11-15',
    fiscal_period_id: PERIOD_ID,
    reversed_by_id: null,
    voucher_series: 'A',
    voucher_number: 12,
    correction_of_id: null,
    reverses_id: null,
  },
  error: null,
}
const YEAR_2025 = { data: { id: PERIOD_ID, name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: false, locked_at: null }, error: null }
const NO_LOCK_DATE = { data: { bookkeeping_locked_through: null }, error: null }

function request(body?: unknown, query = ''): Request {
  return new Request(`${BASE}${query}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
  reverseEntryMock.mockImplementation(async (_s: unknown, _c: string, _u: string, _id: string, date: string) => ({
    id: REVERSAL_ID,
    voucher_series: 'A',
    voucher_number: 40,
    entry_date: date,
  }))
})

const openYear = () =>
  makeClient({ company_members: OWNER, journal_entries: ORIGINAL, fiscal_periods: YEAR_2025, company_settings: NO_LOCK_DATE })

describe('POST .../journal-entries/{id}/reverse', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await POST(request(), params())).status).toBe(401)
  })

  it('400 for a malformed id, body or date', async () => {
    mockServiceClient.mockReturnValue(openYear())
    expect((await POST(request(), params('nope'))).status).toBe(400)
    mockServiceClient.mockReturnValue(openYear())
    expect((await POST(request('{'), params())).status).toBe(400)
    mockServiceClient.mockReturnValue(openYear())
    expect((await POST(request({ reversal_date: '15/11/2025' }), params())).status).toBe(400)
    mockServiceClient.mockReturnValue(openYear())
    expect((await POST(request({ surprise: true }), params())).status).toBe(400)
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('404 for an entry outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: { data: null, error: null } }))
    const res = await POST(request(), params())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('defaults the storno to the original\'s date, not today', async () => {
    mockServiceClient.mockReturnValue(openYear())

    const res = await POST(request(), params())

    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ reversal_id: REVERSAL_ID, entry_date: '2025-11-15', status: 'posted' })
    expect(reverseEntryMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', ENTRY_ID, '2025-11-15', {
      allowDeepChain: false,
    })
  })

  it('takes a reversal_date inside the original\'s year', async () => {
    mockServiceClient.mockReturnValue(openYear())

    const res = await POST(request({ reversal_date: '2025-12-31' }), params())

    expect(res.status).toBe(200)
    expect((await res.json()).data.entry_date).toBe('2025-12-31')
  })

  it('400 ENTRY_DATE_OUTSIDE_FISCAL_PERIOD for a reversal_date in another year, posting nothing', async () => {
    mockServiceClient.mockReturnValue(openYear())

    const res = await POST(request({ reversal_date: '2026-01-10' }), params())

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ENTRY_DATE_OUTSIDE_FISCAL_PERIOD')
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it.each([
    ['locked', { locked_at: '2026-02-01T00:00:00Z' }, 'period_locked_at_set'],
    ['closed', { is_closed: true, locked_at: '2026-02-01T00:00:00Z' }, 'period_is_closed'],
  ])('PERIOD_LOCKED for a %s year, live and dry run alike, before any voucher number', async (_label, state, reason) => {
    for (const query of ['', '?dry_run=true']) {
      const client = makeClient({
        company_members: OWNER,
        journal_entries: ORIGINAL,
        fiscal_periods: { data: { ...YEAR_2025.data, ...state }, error: null },
        company_settings: NO_LOCK_DATE,
      })
      mockServiceClient.mockReturnValue(client)

      const res = await POST(request(undefined, query), params())

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('PERIOD_LOCKED')
      expect(body.error.details).toMatchObject({ reason, fiscal_period_id: PERIOD_ID, reversal_date: '2025-11-15' })
      expect(reverseEntryMock).not.toHaveBeenCalled()
      expect(client.rpc).not.toHaveBeenCalledWith('next_voucher_number', expect.anything())
    }
  })

  it('PERIOD_LOCKED when the company lock date covers the original\'s date', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        journal_entries: ORIGINAL,
        fiscal_periods: YEAR_2025,
        company_settings: { data: { bookkeeping_locked_through: '2025-11-30' }, error: null },
      }),
    )

    const res = await POST(request(), params())

    expect(res.status).toBe(400)
    expect((await res.json()).error.details.reason).toBe('company_lock_date_covers')
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('a dry run previews the resolved date and posts nothing', async () => {
    mockServiceClient.mockReturnValue(openYear())

    const res = await POST(request(undefined, '?dry_run=true'), params())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(JSON.stringify(body.data)).toContain('2025-11-15')
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  // Advice, never a refusal: a supplier invoice's registration verifikat is
  // reversed as asked, and the answer (dry run too) names the invoice and the
  // tool that credits it instead.
  it('reverses an owned verifikat and names its owner in owned_by, dry run and live', async () => {
    const owned = {
      company_members: OWNER,
      journal_entries: {
        data: { ...ORIGINAL.data, source_type: 'supplier_invoice_registered', source_id: 'si-1' },
        error: null,
      },
      fiscal_periods: YEAR_2025,
      company_settings: NO_LOCK_DATE,
      supplier_invoices: {
        data: { id: 'si-1', supplier_invoice_number: '3744267', status: 'approved', credited_invoice_id: null },
        error: null,
      },
    }
    for (const query of ['?dry_run=true', '']) {
      mockServiceClient.mockReturnValue(makeClient(owned))

      const res = await POST(request(undefined, query), params())

      expect(res.status).toBe(200)
      const body = await res.json()
      // The dry-run envelope nests the preview; both carry the owner and its tool.
      expect(JSON.stringify(body.data)).toContain('"tool":"gnubok_credit_supplier_invoice"')
      if (!query) {
        expect(body.data.owned_by).toMatchObject({ kind: 'supplier_invoice', owner_id: 'si-1', action: 'credit_supplier_invoice' })
      }
    }
    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
  })

  it('answers owned_by null for a verifikat no object owns', async () => {
    mockServiceClient.mockReturnValue(openYear())

    const res = await POST(request(), params())

    expect(res.status).toBe(200)
    expect((await res.json()).data.owned_by).toBeNull()
  })

  it('maps a lock taken between the pre-flight and the engine to PERIOD_LOCKED', async () => {
    mockServiceClient.mockReturnValue(openYear())
    reverseEntryMock.mockRejectedValueOnce(new TargetPeriodLockedError('2025-11-15', '2026-02-01T00:00:00Z'))

    const res = await POST(request(), params())

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('PERIOD_LOCKED')
  })
})
