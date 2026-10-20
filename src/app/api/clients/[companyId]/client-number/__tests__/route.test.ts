import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const session = createTableMockSupabase()
const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  membership: vi.fn(),
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...a: unknown[]) => mocks.requireAuth(...a) }))
vi.mock('@/lib/clients/fetch-client-overview', () => ({ getByraMembership: (...a: unknown[]) => mocks.membership(...a) }))
// The route writes on the caller's own session; the service role must never be reached.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => {
    throw new Error('not used')
  }),
  createServiceClient: vi.fn(() => {
    throw new Error('not used')
  }),
}))

import { PUT } from '../route'

const CLIENT = '11111111-1111-4111-8111-111111111111'

type ErrorBody = { error: { code: string } }
type DataBody = { data: { company_id: string; client_number: string | null } }

function request(body: unknown, raw = false): Request {
  return new Request(`https://app.test/api/clients/${CLIENT}/client-number`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

const params = (companyId: string = CLIENT) => ({ params: Promise.resolve({ companyId }) })

/** The read and the update both hit companies; answer each by its chain. */
function companies(read: unknown, update: unknown) {
  session.setTable('companies', (chain) =>
    chain.some((c) => c.method === 'update') ? { data: update } : { data: read },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  session.reset()
  mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1', email: 'byra@example.com' }, supabase: session.supabase, error: null })
  mocks.membership.mockResolvedValue({ teamId: 'team-1', teamName: 'Byrån', role: 'admin' })
  companies({ id: CLIENT }, { id: CLIENT, byra_client_number: '1042' })
})

describe('PUT /api/clients/:companyId/client-number', () => {
  it('answers 401 without a session', async () => {
    mocks.requireAuth.mockResolvedValue({ user: null, supabase: session.supabase, error: NextResponse.json({ error: 'auth' }, { status: 401 }) })
    expect((await PUT(request({ client_number: '1042' }), params())).status).toBe(401)
    expect(session.supabase.from).not.toHaveBeenCalled()
  })

  it('answers 403 outside every byrå team, and for a plain byrå member', async () => {
    mocks.membership.mockResolvedValue(null)
    let res = await parseJsonResponse<ErrorBody>(await PUT(request({ client_number: '1042' }), params()))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')

    mocks.membership.mockResolvedValue({ teamId: 'team-1', teamName: 'Byrån', role: 'member' })
    res = await parseJsonResponse<ErrorBody>(await PUT(request({ client_number: '1042' }), params()))
    expect(res.status).toBe(403)
    expect(session.supabase.from).not.toHaveBeenCalled()
  })

  it('answers 400 for a body that is not one line of at most 40 characters', async () => {
    for (const body of [{}, { client_number: 1042 }, { client_number: 'x'.repeat(41) }, { client_number: 'a\nb' }]) {
      expect((await PUT(request(body), params())).status, JSON.stringify(body)).toBe(400)
    }
    expect((await PUT(request('{not json', true), params())).status).toBe(400)
    expect(session.findCall('companies', 'update')).toBeUndefined()
  })

  it("answers 404 for a malformed id and for a company that is not one of the team's clients", async () => {
    expect((await PUT(request({ client_number: '1042' }), params('nope'))).status).toBe(404)

    companies(null, null)
    const { status, body } = await parseJsonResponse<ErrorBody>(await PUT(request({ client_number: '1042' }), params()))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(session.findCalls('companies', 'eq')).toEqual(
      expect.arrayContaining([['id', CLIENT], ['team_id', 'team-1']]),
    )
    expect(session.findCall('companies', 'is')).toEqual(['archived_at', null])
    expect(session.findCall('companies', 'update')).toBeUndefined()
  })

  it('answers 403 when RLS matches no row on the update', async () => {
    companies({ id: CLIENT }, null)
    const { status, body } = await parseJsonResponse<ErrorBody>(await PUT(request({ client_number: '1042' }), params()))
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('stores the trimmed number on the caller session and answers it', async () => {
    const { status, body } = await parseJsonResponse<DataBody>(await PUT(request({ client_number: '  1042 ' }), params()))
    expect(status).toBe(200)
    expect(body.data).toEqual({ company_id: CLIENT, client_number: '1042' })
    expect(session.payloads('companies', 'update')).toEqual([{ byra_client_number: '1042' }])
  })

  it('clears the number for an empty string or null', async () => {
    companies({ id: CLIENT }, { id: CLIENT, byra_client_number: null })
    for (const value of ['   ', null]) {
      const { status, body } = await parseJsonResponse<DataBody>(await PUT(request({ client_number: value }), params()))
      expect(status).toBe(200)
      expect(body.data.client_number).toBeNull()
    }
    expect(session.payloads('companies', 'update')).toEqual([{ byra_client_number: null }, { byra_client_number: null }])
  })
})
