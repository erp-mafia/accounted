import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { requireAuth, createServiceClientNoCookies, planFortnoxTermsBackfill, applyTermsFills, isMigrationResetSource } =
  vi.hoisted(() => ({
    requireAuth: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
    planFortnoxTermsBackfill: vi.fn(),
    applyTermsFills: vi.fn(),
    isMigrationResetSource: vi.fn(),
  }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies }))
vi.mock('../backfill-fortnox-terms', () => ({ planFortnoxTermsBackfill, applyTermsFills }))
vi.mock('../repair-fortnox-supplier-numbers', () => ({ isMigrationResetSource }))

import { fortnoxTermsBackfillRoutes } from '../fortnox-terms-backfill-routes'

const OPERATOR = '79b67419-5804-4718-bf49-8b2ad2b9e622'
const COMPANY = '11111111-1111-4111-8111-111111111111'

const route = (method: string) => fortnoxTermsBackfillRoutes.find((r) => r.method === method)!
const handler = (method: string) => route(method).handler as (request: Request) => Promise<Response>
const post = (body: unknown) =>
  new Request('https://example.test/fortnox-terms-backfill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const get = () => new Request('https://example.test/fortnox-terms-backfill/companies')

function signIn(userId: string | null, aal = 'aal2') {
  if (!userId) {
    requireAuth.mockResolvedValue({ user: null, supabase: {}, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    return
  }
  const claims = { sub: userId, aal, iss: 'https://project.supabase.co/auth/v1', aud: 'authenticated' }
  requireAuth.mockResolvedValue({
    user: { id: userId },
    supabase: { auth: { getClaims: vi.fn().mockResolvedValue({ data: { claims } }) } },
    error: null,
  })
}

function service() {
  const mock = createQueuedMockSupabase()
  createServiceClientNoCookies.mockReturnValue(mock.supabase)
  return mock
}

const plan = (next: string | null = null) => ({
  fortnox: 'fetched', listed: 3, candidates: 2,
  counts: { customers: { fill: 2 }, suppliers: { same: 1 } },
  fills: [
    { resource: 'customers', id: 'c1', terms: 10 },
    { resource: 'customers', id: 'c2', terms: 15 },
  ],
  next,
})

beforeEach(() => {
  vi.resetAllMocks()
  eventBus.clear()
  isMigrationResetSource.mockResolvedValue(false)
})

describe('fortnox terms backfill routes', () => {
  it('run without a company context, signed in', () => {
    for (const r of fortnoxTermsBackfillRoutes) {
      expect((r as { skipAuth?: boolean }).skipAuth).toBeFalsy()
      expect((r as { skipCompanyContext?: boolean }).skipCompanyContext).toBe(true)
    }
  })

  it('passes on the sign-in refusal', async () => {
    signIn(null)
    expect((await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))).status).toBe(401)
    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
  })

  it.each([['GET'], ['POST']])('answers 404 to anyone but the operator (%s)', async (method) => {
    signIn('33333333-3333-4333-8333-333333333333')
    const response = await handler(method)(method === 'GET' ? get() : post({ mode: 'dry_run', company_id: COMPANY }))
    expect(response.status).toBe(404)
    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
    expect(planFortnoxTermsBackfill).not.toHaveBeenCalled()
  })

  it('refuses the operator without an MFA session', async () => {
    signIn(OPERATOR, 'aal1')
    const response = await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))
    expect(response.status).toBe(403)
    expect((await parseJsonResponse<{ error: { code: string } }>(response)).body.error.code).toBe('MFA_REQUIRED')
    expect(planFortnoxTermsBackfill).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { mode: 'dry_run' },
    { mode: 'dry_run', company_id: 'not-a-uuid' },
    { mode: 'apply', company_id: COMPANY },
    { mode: 'execute', company_id: COMPANY, from: '' },
    { mode: 'execute', company_id: COMPANY, terms: 10 },
    'not json',
  ])('rejects invalid or extended input %#', async (body) => {
    signIn(OPERATOR)
    expect((await handler('POST')(post(body))).status).toBe(400)
    expect(planFortnoxTermsBackfill).not.toHaveBeenCalled()
  })

  it('lists the live companies with a Fortnox connection, once, by name', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: [{ company_id: 'b' }, { company_id: 'a' }, { company_id: 'b' }, { company_id: 'c' }] })
    enqueue({ data: [
      { id: 'b', name: 'Örn AB', archived_at: null },
      { id: 'a', name: 'Alfa AB', archived_at: null },
      { id: 'c', name: 'Arkiv AB', archived_at: '2026-01-01' },
    ] })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await handler('GET')(get()))
    expect(status).toBe(200)
    expect(body.data).toEqual([{ id: 'a', name: 'Alfa AB' }, { id: 'b', name: 'Örn AB' }])
  })

  it('dry run: reports counts and the cursor without a single card, and writes nothing', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    planFortnoxTermsBackfill.mockResolvedValue(plan('customers:1100'))
    const response = await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY, from: 'customers:1000' }))
    const text = await response.clone().text()
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)
    expect(status).toBe(200)
    expect(planFortnoxTermsBackfill).toHaveBeenCalledWith(expect.anything(), COMPANY,
      { from: 'customers:1000', deadline: expect.any(Number) })
    expect(body.data).toMatchObject({ name: 'Alfa AB', fills: 2, next: 'customers:1100', counts: { customers: { fill: 2 } } })
    expect(text).not.toContain('c1')
    expect(applyTermsFills).not.toHaveBeenCalled()
  })

  it('refuses an archived, unknown or migration-reset company', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: '2026-01-01' } })
    expect((await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))).status).toBe(409)
    enqueue({ data: null })
    expect((await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))).status).toBe(404)
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    isMigrationResetSource.mockResolvedValue(true)
    const reset = await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))
    expect(reset.status).toBe(409)
    expect((await parseJsonResponse<{ error: { code: string } }>(reset)).body.error.code).toBe('MIGRATION_RESET_SOURCE')
    expect(planFortnoxTermsBackfill).not.toHaveBeenCalled()
  })

  it('execute: writes what it read and answers the counts, never the card ids', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    const fresh = plan()
    planFortnoxTermsBackfill.mockResolvedValue(fresh)
    applyTermsFills.mockResolvedValue({ filled: 2, changed: 0, filledIds: ['c1', 'c2'] })
    const response = await handler('POST')(post({ mode: 'execute', company_id: COMPANY }))
    const text = await response.clone().text()
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)
    expect(status).toBe(200)
    expect(planFortnoxTermsBackfill).toHaveBeenCalledWith(expect.anything(), COMPANY,
      { from: null, deadline: expect.any(Number) })
    expect(applyTermsFills).toHaveBeenCalledWith(expect.anything(), COMPANY, fresh.fills)
    expect(body.data).toMatchObject({ name: 'Alfa AB', fills: 2, filled: 2, changed: 0, next: null })
    expect(text).not.toContain('c1')
  })

  it('answers 500 when the backfill fails', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    planFortnoxTermsBackfill.mockRejectedValue(new Error('customers: boom'))
    const response = await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))
    expect(response.status).toBe(500)
    expect((await parseJsonResponse<{ error: { code: string } }>(response)).body.error.code).toBe('BACKFILL_FAILED')
  })
})
