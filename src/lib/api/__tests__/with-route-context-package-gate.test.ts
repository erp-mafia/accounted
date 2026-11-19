/**
 * withRouteContext's package start gate: a dashboard route that starts new
 * work in a package (lib/modules/package-doors.ts) answers PACKAGE_OFF while
 * the company has the package switched off; every other route never asks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockSupabase } from '@/tests/helpers'
import { packageOffRefusal, packageStartRefusal } from '@/lib/modules/package-gate'

const supabaseRef = vi.hoisted(() => ({ supabase: null as unknown }))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'user-1' }, supabase: supabaseRef.supabase })),
}))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn(async () => 'company-1') }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return { ...actual, requireWritePermission: vi.fn(async () => ({ ok: true })), isCompanyAdmin: vi.fn(async () => true) }
})

import { withRouteContext } from '../with-route-context'

const PARAMS = { params: Promise.resolve({}) }

describe('withRouteContext package start gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    supabaseRef.supabase = createMockSupabase().supabase
  })

  it('refuses a start route with PACKAGE_OFF, in Swedish with where to switch it on, before the handler runs', async () => {
    vi.mocked(packageStartRefusal).mockResolvedValueOnce(packageOffRefusal('payroll', 'turned_off_by_company'))
    const handler = vi.fn(async () => NextResponse.json({ data: {} }))
    const route = withRouteContext('salary.runs.create', handler, { requireWrite: true })

    const res = await route(new Request('http://localhost/api/salary/runs', { method: 'POST' }), PARAMS)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('PACKAGE_OFF')
    expect(body.error.message).toMatch(/Slå på Lön under Anpassa\.$/)
    expect(body.error.details).toMatchObject({ package_id: 'payroll', package_name: 'Lön' })
    expect(handler).not.toHaveBeenCalled()
    expect(packageStartRefusal).toHaveBeenCalledWith(supabaseRef.supabase, 'company-1', 'payroll')
  })

  it('matches a start route with an id in its path to its package', async () => {
    vi.mocked(packageStartRefusal).mockResolvedValueOnce(packageOffRefusal('customer-invoices', 'off_in_profile'))
    const route = withRouteContext('invoice.convert', vi.fn(async () => NextResponse.json({})), { requireWrite: true })
    const res = await route(
      new Request('http://localhost/api/invoices/6f1c2a40-0000-4000-8000-000000000001/convert', { method: 'POST' }),
      PARAMS,
    )
    expect(res.status).toBe(409)
    expect(packageStartRefusal).toHaveBeenCalledWith(supabaseRef.supabase, 'company-1', 'customer-invoices')
  })

  it('runs a start route when its package is on', async () => {
    const handler = vi.fn(async () => NextResponse.json({ data: { id: 'run-1' } }))
    const route = withRouteContext('salary.runs.create', handler, { requireWrite: true })
    const res = await route(new Request('http://localhost/api/salary/runs', { method: 'POST' }), PARAMS)
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('never asks for a route that settles what is open, or a read', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    for (const [method, path] of [
      ['POST', '/api/salary/runs/run-1/book'],
      ['POST', '/api/invoices/inv-1/mark-paid'],
      ['GET', '/api/salary/runs'],
      ['POST', '/api/bookkeeping/journal-entries'],
    ] as const) {
      const route = withRouteContext('test', handler)
      await route(new Request(`http://localhost${path}`, { method }), PARAMS)
    }
    expect(packageStartRefusal).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(4)
  })
})
