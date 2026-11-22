import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: service, enqueue, findCall, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service, createClient: async () => service }))

import { GET as getCurrent, POST as create } from '../route'
import { PUT as save } from '../[id]/route'
import { POST as submitted } from '../[id]/submitted/route'
import { GET as documentGet } from '../[id]/documents/[slug]/route'
import { emptyAnswers, type FormationAnswers } from '@/lib/formation/answers'
import { sealAnswers } from '@/lib/formation/store'

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'founder@example.se', is_anonymous: false }
const ID = '00000000-0000-4000-8000-0000000000aa'

/** Stored answers that break no rule: one founder on the board, a deputy, personnummer sealed. */
function complete(): FormationAnswers {
  return sealAnswers(
    {
      ...emptyAnswers(),
      names: ['Testbolaget Nord AB', 'Nordtest AB'],
      description: 'konsultverksamhet inom systemutveckling och drift av webbtjänster',
      seat: 'Stockholm',
      address: { co: '', street: 'Testgatan 1', postalCode: '11122', city: 'Stockholm' },
      contact: { name: 'Test Testsson', email: 'test@example.se', phone: '+46701234567' },
      bank: 'svea',
      parties: [
        // Published Skatteverket test personnummer.
        { id: 'a', type: 'person', name: 'Test Testsson', personnummer: '195001182046', email: '', shares: 500, roles: ['ledamot', 'vd'] },
        { id: 'b', type: 'person', name: 'Deputy Person', personnummer: '201212121212', email: '', shares: 0, roles: ['suppleant'] },
      ],
    },
    null,
  )
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    user_id: USER.id,
    status: 'draft',
    answers: { names: ['Test AB'] },
    stripe_checkout_session_id: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    paid_at: null,
    submitted_at: null,
    deed_date: null,
    company_id: null,
    setup_state: {},
    set_up_at: null,
    created_at: '2026-11-20T09:00:00Z',
    updated_at: '2026-11-20T09:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: USER, supabase: service, error: null })
})

describe('/api/formation', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: service, error: NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) })
    expect((await getCurrent(createMockRequest('/api/formation'), createMockRouteParams({}))).status).toBe(401)
  })

  it('answers null when the user has no formation', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await getCurrent(createMockRequest('/api/formation'), createMockRouteParams({})))
    expect(status).toBe(200)
    expect(body.data).toBeNull()
  })

  it('creates a formation with the signed-in email as contact', async () => {
    enqueue({ data: null })
    enqueue({ data: row() })
    const res = await create(createMockRequest('/api/formation', { method: 'POST', body: {} }), createMockRouteParams({}))
    expect(res.status).toBe(201)
    const insert = findCall('company_formations', 'insert')?.[0] as { user_id: string; answers: { contact: { email: string } } }
    expect(insert.user_id).toBe(USER.id)
    expect(insert.answers.contact.email).toBe(USER.email)
  })

  it('answers the current formation instead of making a second one', async () => {
    enqueue({ data: row() })
    const res = await create(createMockRequest('/api/formation', { method: 'POST', body: {} }), createMockRouteParams({}))
    expect(res.status).toBe(200)
    expect(findCall('company_formations', 'insert')).toBeUndefined()
  })
})

describe('PUT /api/formation/:id', () => {
  it('refuses a body that is not answers', async () => {
    const res = await save(createMockRequest(`/api/formation/${ID}`, { method: 'PUT', body: { answers: { capital: { amount: 'x' } } } }), createMockRouteParams({ id: ID }))
    expect(res.status).toBe(400)
  })

  it('answers 404 for a formation of somebody else', async () => {
    enqueue({ data: null })
    const res = await save(createMockRequest(`/api/formation/${ID}`, { method: 'PUT', body: { answers: {} } }), createMockRouteParams({ id: ID }))
    expect(res.status).toBe(404)
  })

  it('refuses changes once the company is set up', async () => {
    enqueue({ data: row({ status: 'set_up', company_id: 'c-1' }) })
    const res = await save(createMockRequest(`/api/formation/${ID}`, { method: 'PUT', body: { answers: {} } }), createMockRouteParams({ id: ID }))
    expect(res.status).toBe(409)
  })

  it('saves the answers, scoped to the user', async () => {
    enqueue({ data: row() })
    enqueue({ data: row({ answers: { names: ['Nytt AB'] } }) })
    const res = await save(createMockRequest(`/api/formation/${ID}`, { method: 'PUT', body: { answers: { names: ['Nytt AB'] } } }), createMockRouteParams({ id: ID }))
    const { status, body } = await parseJsonResponse<{ data: { answers: { names: string[] } } }>(res)
    expect(status).toBe(200)
    expect(body.data.answers.names).toEqual(['Nytt AB'])
  })
})

describe('POST /api/formation/:id/submitted', () => {
  it('refuses a deed date in the future', async () => {
    const res = await submitted(createMockRequest(`/api/formation/${ID}/submitted`, { method: 'POST', body: { deed_date: '2999-01-01' } }), createMockRouteParams({ id: ID }))
    expect(res.status).toBe(400)
  })

  it('refuses while the answers still break a rule', async () => {
    enqueue({ data: row() })
    const res = await submitted(createMockRequest(`/api/formation/${ID}/submitted`, { method: 'POST', body: { deed_date: '2026-11-19' } }), createMockRouteParams({ id: ID }))
    expect(res.status).toBe(422)
  })

  it('marks a complete formation as sent in, with no payment', async () => {
    enqueue({ data: row({ answers: complete() }) })
    enqueue({ data: row({ status: 'submitted', answers: complete(), deed_date: '2026-11-19' }) })
    const res = await submitted(createMockRequest(`/api/formation/${ID}/submitted`, { method: 'POST', body: { deed_date: '2026-11-19' } }), createMockRouteParams({ id: ID }))
    expect(res.status).toBe(200)
    expect(findCall('company_formations', 'update')?.[0]).toMatchObject({ status: 'submitted', deed_date: '2026-11-19' })
  })
})

describe('GET /api/formation/:id/documents/:slug', () => {
  it('refuses a formation whose answers still break a rule', async () => {
    enqueue({ data: row() })
    const res = await documentGet(createMockRequest(`/api/formation/${ID}/documents/bolagsordning`), createMockRouteParams({ id: ID, slug: 'bolagsordning' }))
    expect(res.status).toBe(422)
  })

  it('answers 404 for a document that does not exist', async () => {
    enqueue({ data: row({ answers: complete() }) })
    const res = await documentGet(createMockRequest(`/api/formation/${ID}/documents/nope`), createMockRouteParams({ id: ID, slug: 'nope' }))
    expect(res.status).toBe(404)
  })

  it('answers the shareholder agreement only when it is switched on', async () => {
    enqueue({ data: row({ answers: complete() }) })
    const res = await documentGet(createMockRequest(`/api/formation/${ID}/documents/aktieagaravtal`), createMockRouteParams({ id: ID, slug: 'aktieagaravtal' }))
    expect(res.status).toBe(404)
  })

  it('renders a Word bolagsordning for a complete formation, with no payment', async () => {
    enqueue({ data: row({ answers: complete() }) })
    const res = await documentGet(
      createMockRequest(`/api/formation/${ID}/documents/bolagsordning`, { searchParams: { format: 'docx' } }),
      createMockRouteParams({ id: ID, slug: 'bolagsordning' }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('wordprocessingml')
    expect(res.headers.get('content-disposition')).toContain('bolagsordning.docx')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes[0]).toBe(0x50) // "PK", a zip
    expect(bytes[1]).toBe(0x4b)
  })
})
