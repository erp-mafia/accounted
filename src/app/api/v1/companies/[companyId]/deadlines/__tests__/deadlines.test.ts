/**
 * Deadlines through the v1 door of the operation registry
 * (src/lib/operations/deadlines.ts via lib/operations/v1.ts):
 *   GET  /api/v1/companies/:companyId/deadlines
 *   POST /api/v1/companies/:companyId/deadlines/:id/complete
 *
 * The rule itself (lib/deadlines/completion.ts) has its own tests; here the
 * door: the key and its scope, the request contract, and that a dry run
 * writes nothing.
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET as listDeadlines } from '../route'
import { POST as completeDeadline } from '../[id]/complete/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

/** A service client answering per table (tests/helpers.ts), with its recorded calls. */
function makeClient(byTable: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(byTable)
  return { ...mock.supabase, findCalls: mock.findCalls }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEADLINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/deadlines`

const OPEN_ROW = {
  id: DEADLINE_ID,
  company_id: COMPANY_ID,
  title: 'Skicka underlag till revisorn',
  due_date: '2026-11-20',
  due_time: null,
  deadline_type: 'other',
  priority: 'normal',
  is_completed: false,
  completed_at: null,
  notes: null,
  tax_deadline_type: null,
  tax_period: null,
  source: 'user',
  status: 'upcoming',
  dismissed_at: null,
}

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const deadlineParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: DEADLINE_ID }) }

const wroteDeadline = (client: ReturnType<typeof makeClient>) => client.findCalls('deadlines', 'update').length > 0

function useKey(scopes: string[]) {
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes,
    mode: 'live',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T10:00:00Z'))
  useKey(['reports:read', 'bookkeeping:write'])
})

describe('GET /api/v1/companies/:companyId/deadlines', () => {
  const list = (query = '') => listDeadlines(request(`${BASE}${query}`), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await list()).status).toBe(401)
  })

  it('403 without reports:read', async () => {
    useKey(['transactions:read'])
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await list()).status).toBe(403)
  })

  it('400 on an unknown status, a limit out of range or an unknown parameter', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await list('?status=overdue')).status).toBe(400)
    expect((await list('?limit=0')).status).toBe(400)
    expect((await list('?due_before=2026-12-31')).status).toBe(400)
  })

  it('lists the open deadlines with a qualified id, reading the limit from the query string', async () => {
    const client = makeClient({ company_members: MEMBER, deadlines: { data: [OPEN_ROW], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await list('?limit=5&due_to=2026-12-31')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.has_more).toBe(false)
    expect(body.data.deadlines).toHaveLength(1)
    expect(body.data.deadlines[0]).toMatchObject({
      deadline_id: DEADLINE_ID,
      title: 'Skicka underlag till revisorn',
      due_date: '2026-11-20',
      is_completed: false,
      overdue: false,
      days_until_due: 7,
    })
    expect(body.data.deadlines[0]).not.toHaveProperty('id')
    expect(body.data.deadlines[0]).not.toHaveProperty('status')
    expect(client.findCalls('deadlines', 'eq').some((args) => args[0] === 'company_id')).toBe(true)
  })
})

describe('POST /api/v1/companies/:companyId/deadlines/:id/complete', () => {
  const complete = (body: unknown, query = '') =>
    completeDeadline(request(`${BASE}/${DEADLINE_ID}/complete${query}`, { method: 'POST', body: JSON.stringify(body) }), deadlineParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await complete({ is_completed: true })).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    useKey(['reports:read'])
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await complete({ is_completed: true })).status).toBe(403)
  })

  it('400 when is_completed is missing or not a boolean', async () => {
    const client = makeClient({ company_members: MEMBER, deadlines: { data: OPEN_ROW, error: null } })
    mockServiceClient.mockReturnValue(client)
    expect((await complete({})).status).toBe(400)
    expect((await complete({ is_completed: 'yes' })).status).toBe(400)
    expect(wroteDeadline(client)).toBe(false)
  })

  it('404 DEADLINE_NOT_FOUND for a deadline the company does not have', async () => {
    const client = makeClient({ company_members: MEMBER, deadlines: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await complete({ is_completed: true })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DEADLINE_NOT_FOUND')
    expect(wroteDeadline(client)).toBe(false)
  })

  it('previews the tick on a dry run and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, deadlines: { data: OPEN_ROW, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await complete({ is_completed: true }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect(wroteDeadline(client)).toBe(false)
  })

  it('ticks the deadline off and answers it completed', async () => {
    const completed = { ...OPEN_ROW, is_completed: true, completed_at: '2026-11-13T10:00:00.000Z' }
    const client = makeClient({
      company_members: MEMBER,
      deadlines: [
        { data: OPEN_ROW, error: null },
        { data: completed, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await complete({ is_completed: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.changed).toBe(true)
    expect(body.data.deadline).toMatchObject({ deadline_id: DEADLINE_ID, is_completed: true })
    expect(wroteDeadline(client)).toBe(true)
  })
})
