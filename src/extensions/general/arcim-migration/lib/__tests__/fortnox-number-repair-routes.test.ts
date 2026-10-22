import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { requireAuth, createServiceClientNoCookies, repairFortnoxSupplierNumbers, applyFortnoxNumberRepair } =
  vi.hoisted(() => ({
    requireAuth: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
    repairFortnoxSupplierNumbers: vi.fn(),
    applyFortnoxNumberRepair: vi.fn(),
  }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies }))
vi.mock('../repair-fortnox-supplier-numbers', () => ({ repairFortnoxSupplierNumbers, applyFortnoxNumberRepair }))

import { fortnoxNumberRepairRoutes } from '../fortnox-number-repair-routes'

const OPERATOR = '79b67419-5804-4718-bf49-8b2ad2b9e622'
const COMPANY = '11111111-1111-4111-8111-111111111111'
const CORRELATION = '22222222-2222-4222-8222-222222222222'

const route = (method: string) => fortnoxNumberRepairRoutes.find((r) => r.method === method)!
const handler = (method: string) => route(method).handler as (request: Request) => Promise<Response>
const post = (body: unknown) =>
  new Request('https://example.test/fortnox-number-repair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const get = () => new Request('https://example.test/fortnox-number-repair/companies')

function signIn(userId: string | null, aal = 'aal2') {
  if (!userId) {
    requireAuth.mockResolvedValue({ user: null, supabase: {}, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    return
  }
  const claims = {
    sub: userId,
    aal,
    iss: 'https://project.supabase.co/auth/v1',
    aud: 'authenticated',
  }
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

const row = (outcome: string, stamped = false) => ({
  given_number: '7', invoice_id: 'inv', outcome, old_number: '7', new_number: 'F-1',
  payment_reference: null, stamped, old_reference_used: [],
})

function dryRun(rows = [row('corrected'), row('already_correct', true), row('already_correct')]) {
  return {
    companyId: COMPANY,
    status: 'dry_run',
    collection: { companyId: COMPANY, records: [{ given_number: '7' }], stored: 1, fetched: 0, unreadable: 0,
      uncovered: 0, fortnox: 'not_needed', invoiceNumberSeen: true },
    counts: { corrected: 1, already_correct: 2 },
    rows,
    correlationId: null,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  eventBus.clear()
})

describe('fortnox number repair routes', () => {
  it('run without a company context, signed in', () => {
    for (const r of fortnoxNumberRepairRoutes) {
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
    expect(repairFortnoxSupplierNumbers).not.toHaveBeenCalled()
  })

  it('refuses the operator without an MFA session', async () => {
    signIn(OPERATOR, 'aal1')
    const response = await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))
    expect(response.status).toBe(403)
    expect((await parseJsonResponse<{ error: { code: string } }>(response)).body.error.code).toBe('MFA_REQUIRED')
    expect(repairFortnoxSupplierNumbers).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { mode: 'dry_run' },
    { mode: 'dry_run', company_id: 'not-a-uuid' },
    { mode: 'execute', company_id: COMPANY },
    { mode: 'execute', company_id: COMPANY, expected: 0 },
    { mode: 'execute', company_id: COMPANY, expected: 2, actor_user_id: OPERATOR },
    'not json',
  ])('rejects invalid or extended input %#', async (body) => {
    signIn(OPERATOR)
    expect((await handler('POST')(post(body))).status).toBe(400)
    expect(repairFortnoxSupplierNumbers).not.toHaveBeenCalled()
  })

  it('lists every company with a Fortnox consent or import, once, by name', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: [{ company_id: 'b' }, { company_id: 'a' }] }) // provider_consents
    enqueue({ data: [{ company_id: 'a' }] }) // migration_jobs
    enqueue({ data: [
      { id: 'b', name: 'Örn AB', archived_at: null },
      { id: 'a', name: 'Alfa AB', archived_at: '2026-01-01' },
    ] })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await handler('GET')(get()))
    expect(status).toBe(200)
    expect(body.data).toEqual([
      { id: 'a', name: 'Alfa AB', archived: true },
      { id: 'b', name: 'Örn AB', archived: false },
    ])
  })

  it('dry run: reports the company without the collected records and writes nothing', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    repairFortnoxSupplierNumbers.mockResolvedValue(dryRun())
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY, stored_only: true })))
    expect(status).toBe(200)
    expect(repairFortnoxSupplierNumbers).toHaveBeenCalledWith(expect.anything(), COMPANY,
      { dryRun: true, fetchFromFortnox: false })
    expect(body.data.name).toBe('Alfa AB')
    expect(body.data.writes).toBe(2)
    expect((body.data.collection as { records: unknown }).records).toBe(1)
    expect(applyFortnoxNumberRepair).not.toHaveBeenCalled()
  })

  it('refuses an archived or unknown company', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: '2026-01-01' } })
    expect((await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))).status).toBe(409)
    enqueue({ data: null })
    expect((await handler('POST')(post({ mode: 'dry_run', company_id: COMPANY }))).status).toBe(404)
    expect(repairFortnoxSupplierNumbers).not.toHaveBeenCalled()
  })

  it('execute: writes nothing when a fresh dry run changes another count than approved', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    repairFortnoxSupplierNumbers.mockResolvedValue(dryRun())
    const response = await handler('POST')(post({ mode: 'execute', company_id: COMPANY, expected: 3 }))
    expect(response.status).toBe(409)
    expect((await parseJsonResponse<{ error: { code: string; writes: number } }>(response)).body.error)
      .toMatchObject({ code: 'COUNT_CHANGED', writes: 2 })
    expect(applyFortnoxNumberRepair).not.toHaveBeenCalled()
  })

  it('execute: writes nothing for a company the repair must not touch', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    repairFortnoxSupplierNumbers.mockResolvedValue({ ...dryRun([]), status: 'frozen', collection: null })
    const response = await handler('POST')(post({ mode: 'execute', company_id: COMPANY, expected: 1 }))
    expect(response.status).toBe(409)
    expect(applyFortnoxNumberRepair).not.toHaveBeenCalled()
  })

  it('execute: writes the dry run\'s records as the operator under the given correlation id', async () => {
    signIn(OPERATOR)
    const { enqueue } = service()
    enqueue({ data: { id: COMPANY, name: 'Alfa AB', archived_at: null } })
    const dry = dryRun()
    repairFortnoxSupplierNumbers.mockResolvedValue(dry)
    applyFortnoxNumberRepair
      .mockResolvedValueOnce({ counts: { corrected: 1, already_correct: 2 }, rows: dry.rows, correlationId: CORRELATION })
      .mockResolvedValueOnce({ counts: { already_correct: 3 }, rows: [], correlationId: null })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await handler('POST')(
      post({ mode: 'execute', company_id: COMPANY, expected: 2, correlation_id: CORRELATION })))
    expect(status).toBe(200)
    expect(repairFortnoxSupplierNumbers).toHaveBeenCalledWith(expect.anything(), COMPANY,
      { dryRun: true, fetchFromFortnox: true })
    expect(applyFortnoxNumberRepair).toHaveBeenNthCalledWith(1, expect.anything(), COMPANY, dry.collection.records, {
      dryRun: false,
      actor: expect.objectContaining({ type: 'user', id: OPERATOR }),
      correlationId: CORRELATION,
    })
    expect(applyFortnoxNumberRepair).toHaveBeenNthCalledWith(2, expect.anything(), COMPANY, dry.collection.records,
      { dryRun: true })
    expect(body.data).toMatchObject({ correlationId: CORRELATION, after: { already_correct: 3 } })
  })
})
