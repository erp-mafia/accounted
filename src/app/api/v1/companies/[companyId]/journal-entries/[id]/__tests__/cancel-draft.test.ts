/**
 * DELETE /api/v1/companies/:companyId/journal-entries/:id
 *
 * The v1 exit from the draft state (#2556). Before this endpoint an API key
 * could create a draft it had no way to clear, and the year-end preflight
 * then refused to close the period (DRAFT_ENTRIES) over a row only the
 * dashboard could remove.
 *
 * What the tests pin down: the auth and validation gates, that a posted entry
 * is refused with 409 so storno stays the only way out of posted, and that the
 * engine's cancelDraftEntry is the only writer the route uses.
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
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, cancelDraftEntry: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { cancelDraftEntry } from '@/lib/bookkeeping/engine'
import { DELETE } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCheckPeriodLock = checkPeriodLock as ReturnType<typeof vi.fn>
const mockCancel = cancelDraftEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const DRAFT = {
  id: ENTRY_ID,
  fiscal_period_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  voucher_series: 'A',
  voucher_number: 0,
  entry_date: '2026-05-12',
  description: 'Bankavgift maj 2026',
  status: 'draft',
  source_type: 'manual',
}

/**
 * company_members proves the key may touch this company; journal_entries
 * answers from a queue so the pre-flight read and the post-cancel refetch can
 * return different rows. Everything else (the idempotency store) answers null.
 */
function makeSupabase(journalEntryRows: unknown[]) {
  const queue = [...journalEntryRows]
  const build = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => {
            if (table === 'company_members') {
              return Promise.resolve({
                data: { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' },
                error: null,
              })
            }
            if (table === 'journal_entries') {
              return Promise.resolve({ data: queue.length > 1 ? queue.shift() : queue[0] ?? null, error: null })
            }
            return Promise.resolve({ data: null, error: null })
          }
        }
        return () => build(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => build(table)) }
}

function makeRequest({ auth = true, id = ENTRY_ID, dryRun = false } = {}): Request {
  const headers: Record<string, string> = {}
  if (auth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(
    `http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries/${id}${dryRun ? '?dry_run=true' : ''}`,
    { method: 'DELETE', headers },
  )
}

const routeParams = (id = ENTRY_ID) => ({
  params: Promise.resolve({ companyId: COMPANY_ID, id }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['bookkeeping:write'],
    mode: 'live',
    unattendedCommitLimit: null,
  })
  mockCheckPeriodLock.mockResolvedValue({ locked: false })
  mockServiceClient.mockReturnValue(makeSupabase([DRAFT, { ...DRAFT, status: 'cancelled' }]))
  mockCancel.mockResolvedValue({ ...DRAFT, status: 'cancelled' })
})

describe('DELETE /api/v1/companies/:companyId/journal-entries/:id', () => {
  it('returns 401 without an API key and never touches the entry', async () => {
    const res = await DELETE(makeRequest({ auth: false }), routeParams())
    expect(res.status).toBe(401)
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('returns 400 for an id that is not a UUID', async () => {
    const res = await DELETE(makeRequest({ id: 'not-a-uuid' }), routeParams('not-a-uuid'))
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('returns 404 when the entry does not exist in this company', async () => {
    mockServiceClient.mockReturnValue(makeSupabase([null]))
    const res = await DELETE(makeRequest(), routeParams())
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('refuses a posted entry with 409 and points at storno', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase([{ ...DRAFT, status: 'posted', voucher_number: 142 }]),
    )
    const res = await DELETE(makeRequest(), routeParams())
    const body = (await res.json()) as {
      error: { code: string; details: Record<string, unknown>; recovery_hint?: string }
    }
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('CANNOT_CANCEL_NON_DRAFT')
    expect(body.error.details).toMatchObject({ currentStatus: 'posted' })
    // The whole point of the refusal: nothing was written.
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('returns the cancelled entry unchanged when it is already cancelled', async () => {
    mockServiceClient.mockReturnValue(makeSupabase([{ ...DRAFT, status: 'cancelled' }]))
    const res = await DELETE(makeRequest(), routeParams())
    const body = (await res.json()) as { data: { status: string } }
    expect(res.status).toBe(200)
    expect(body.data.status).toBe('cancelled')
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('returns PERIOD_LOCKED instead of letting the trigger raise', async () => {
    mockCheckPeriodLock.mockResolvedValue({
      locked: true,
      reason: 'period_is_closed',
      fiscal_period_id: DRAFT.fiscal_period_id,
    })
    const res = await DELETE(makeRequest(), routeParams())
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('cancels a draft through the engine and returns it', async () => {
    const res = await DELETE(makeRequest(), routeParams())
    const body = (await res.json()) as { data: { id: string; status: string } }
    expect(res.status).toBe(200)
    expect(body.data.status).toBe('cancelled')
    expect(body.data.id).toBe(ENTRY_ID)
    expect(mockCancel).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', ENTRY_ID)
  })

  it('previews without writing on a dry run', async () => {
    const res = await DELETE(makeRequest({ dryRun: true }), routeParams())
    expect(res.status).toBe(200)
    expect(mockCancel).not.toHaveBeenCalled()
  })
})
