/**
 * GET /api/wiki/picture: the agent picture. Runs through the real
 * withRouteContext wrapper with auth, the company, the loader and the two
 * wired readers mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const loadAgentPictureMock = vi.fn()
vi.mock('@/lib/agent-context/agent-picture', () => ({
  loadAgentPicture: (...args: unknown[]) => loadAgentPictureMock(...args),
}))

const withSIEExternalReportMock = vi.fn()
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (...args: unknown[]) => withSIEExternalReportMock(...args),
}))

const readSkatteverketConnectionMock = vi.fn()
vi.mock('@/lib/skatteverket/connection-state', () => ({
  readSkatteverketConnection: (...args: unknown[]) => readSkatteverketConnectionMock(...args),
}))

const readReportedSkattekontoSaldoMock = vi.fn()
vi.mock('@/lib/skatteverket/skattekonto-ocr', () => ({
  readReportedSkattekontoSaldo: (...args: unknown[]) => readReportedSkattekontoSaldoMock(...args),
}))

import { GET } from '../route'

const COMPANY = 'company-1'
const PICTURE = {
  generated_at: '2026-03-02T09:00:00.000Z',
  sources: [],
  company: {
    name: 'Exempelbolaget AB',
    counts: { vouchers: 1, bank_rows: 2, documents: 3, customers: 4, suppliers: 5 },
    memory_facts: 6,
    knowledge: { items: 7, active: null },
    checks: null,
  },
  agents: null,
}

const call = () => GET(createMockRequest('/api/wiki/picture'), { params: Promise.resolve({}) })

interface Ports {
  ledgerRead: <T>(read: () => Promise<T>) => Promise<T>
  skatteverket: () => Promise<{ state: string; last_sync_at: string | null }>
}
const portsOfLastCall = () => loadAgentPictureMock.mock.calls.at(-1)![3] as Ports

describe('GET /api/wiki/picture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    getActiveCompanyIdMock.mockResolvedValue(COMPANY)
    loadAgentPictureMock.mockResolvedValue(PICTURE)
    withSIEExternalReportMock.mockImplementation((_supabase, _company, _operation, read: () => Promise<unknown>) => read())
    readSkatteverketConnectionMock.mockResolvedValue('connected')
    readReportedSkattekontoSaldoMock.mockResolvedValue({ saldo: 100, fetched_at: '2026-03-01T21:14:00.000Z' })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(loadAgentPictureMock).not.toHaveBeenCalled()
  })

  it('returns 400 when there is no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    expect((await parseJsonResponse(await call())).status).toBe(400)
    expect(loadAgentPictureMock).not.toHaveBeenCalled()
  })

  it('answers 404 for a company the picture is not switched on for, and reads nothing', async () => {
    for (const value of ['', 'another-company']) {
      vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', value)
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
      expect(status).toBe(404)
      expect(body.error.code).toBe('NOT_FOUND')
    }
    expect(loadAgentPictureMock).not.toHaveBeenCalled()
  })

  it('returns the picture for the active company and the signed-in person', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await call())
    expect(status).toBe(200)
    expect(body.data).toEqual(PICTURE)
    expect(loadAgentPictureMock).toHaveBeenCalledWith(supabase, COMPANY, 'user-1', expect.any(Object))
  })

  it('is on for every company with *', async () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', '*')
    expect((await parseJsonResponse(await call())).status).toBe(200)
  })

  it('runs the checks behind the SIE import lease, as the unexplained list does', async () => {
    await call()
    const read = vi.fn().mockResolvedValue('answer')
    await expect(portsOfLastCall().ledgerRead(read)).resolves.toBe('answer')
    expect(withSIEExternalReportMock).toHaveBeenCalledWith(supabase, COMPANY, 'unexplained.list', read)
  })

  it('reads the Skatteverket connection for the company, with the last saldo fetch while connected', async () => {
    await call()
    await expect(portsOfLastCall().skatteverket()).resolves.toEqual({ state: 'connected', last_sync_at: '2026-03-01T21:14:00.000Z' })
    expect(readSkatteverketConnectionMock).toHaveBeenCalledWith(supabase, COMPANY)
    expect(readReportedSkattekontoSaldoMock).toHaveBeenCalledWith(supabase, COMPANY)
  })

  it('leaves out the time of a saldo kept after a disconnect', async () => {
    readSkatteverketConnectionMock.mockResolvedValue('not_connected')
    await call()
    await expect(portsOfLastCall().skatteverket()).resolves.toEqual({ state: 'not_connected', last_sync_at: null })

    readSkatteverketConnectionMock.mockResolvedValue('connected')
    readReportedSkattekontoSaldoMock.mockResolvedValue(null)
    await expect(portsOfLastCall().skatteverket()).resolves.toEqual({ state: 'connected', last_sync_at: null })
  })

  it('answers a loader that throws with the canonical 500 envelope', async () => {
    loadAgentPictureMock.mockRejectedValue(new Error('boom'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(500)
    expect(typeof body.error.code).toBe('string')
  })
})
