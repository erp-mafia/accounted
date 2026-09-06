/**
 * GET /api/parties/registry: the read-only SCB lookup behind the customer
 * and supplier forms. No database traffic at all; the gates (credentials,
 * legal person only) and the shape the form gets are what is checked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const writeCheck = { ok: true }
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: () => Promise.resolve(writeCheck.ok ? { ok: true } : { ok: false, response: NextResponse.json({ error: 'Endast läsbehörighet.' }, { status: 403 }) }),
}))
const lookupByOrgNumber = vi.fn()
vi.mock('@/lib/parties/scb/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/parties/scb/client')>()),
  createScbClient: () => ({ lookupByOrgNumber }),
}))
const configured = { value: true }
vi.mock('@/lib/parties/scb/config', () => ({
  isScbConfigured: () => configured.value,
  scbConfigFromEnv: () => ({ baseUrl: 'https://scb.test', pfx: Buffer.from('x'), passphrase: 'p', timeoutMs: 1 }),
}))

import { GET } from '../route'

const user = { id: 'user-1', email: 'test@test.se' }
const noParams = { params: Promise.resolve({}) }
const call = (orgNumber?: string) =>
  GET(createMockRequest('/api/parties/registry', orgNumber === undefined ? undefined : { searchParams: { org_number: orgNumber } }), noParams)

const WEBHALLEN = {
  found: true,
  peOrgNr: '165562529155',
  row: {},
  facts: [
    { field: 'legal_name', value: 'WEBHALLEN SVERIGE AB' },
    { field: 'vat_number', value: 'SE556252915501' },
    { field: 'company_status', value: { code: '1', label: 'Verksamt' } },
    { field: 'postal_address', value: { street: 'Storgatan 1', co: null, postal_code: '111 22', city: 'Stockholm' } },
  ],
  fetchedAt: '2026-09-06T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  configured.value = true
  writeCheck.ok = true
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user } })
})

describe('GET /api/parties/registry', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await parseJsonResponse(await call('5562529155'))).status).toBe(401)
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer: the lookup exists to create a row', async () => {
    writeCheck.ok = false
    expect((await parseJsonResponse(await call('5562529155'))).status).toBe(403)
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('returns 503 when SCB is not configured, before validating anything', async () => {
    configured.value = false
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(503)
    expect(body.error.code).toBe('SCB_NOT_CONFIGURED')
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('returns 400 without an org number', async () => {
    const { status, body } = await parseJsonResponse<{ type: string }>(await call())
    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('refuses a personnummer with 400 and never calls SCB', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('800101-1231'))
    expect(status).toBe(400)
    expect(body.error.code).toBe('SCB_NOT_A_LEGAL_PERSON')
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('refuses an incomplete number or a wrong check digit the same way', async () => {
    expect((await parseJsonResponse(await call('556252-915'))).status).toBe(400)
    expect((await parseJsonResponse(await call('5562529156'))).status).toBe(400)
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('maps an SCB failure to 502', async () => {
    lookupByOrgNumber.mockRejectedValue(new Error('boom'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('5562529155'))
    expect(status).toBe(502)
    expect(body.error.code).toBe('SCB_LOOKUP_FAILED')
  })

  it('reports a number the register does not hold', async () => {
    lookupByOrgNumber.mockResolvedValue({ found: false, peOrgNr: '165562529155', row: null, facts: [], fetchedAt: '2026-09-06T10:00:00Z' })
    const { status, body } = await parseJsonResponse<{ data: { found: boolean; orgNumber: string } }>(await call('556252-9155'))
    expect(status).toBe(200)
    expect(body.data).toEqual({ found: false, orgNumber: '5562529155' })
  })

  it('answers with the display name and the summary, touching no table', async () => {
    lookupByOrgNumber.mockResolvedValue(WEBHALLEN)
    const { status, body } = await parseJsonResponse<{
      data: { found: boolean; orgNumber: string; name: string; registry: { legal_name: string; vat_number: string; contact: { address: { street: string; city: string } } } }
    }>(await call('16 556252-9155'))
    expect(status).toBe(200)
    expect(lookupByOrgNumber).toHaveBeenCalledWith('5562529155')
    expect(body.data.found).toBe(true)
    expect(body.data.orgNumber).toBe('5562529155')
    expect(body.data.name).toBe('Webhallen Sverige AB')
    expect(body.data.registry.legal_name).toBe('WEBHALLEN SVERIGE AB')
    expect(body.data.registry.vat_number).toBe('SE556252915501')
    expect(body.data.registry.contact.address).toMatchObject({ street: 'Storgatan 1', city: 'Stockholm' })
    expect(mockSupabase.from).not.toHaveBeenCalled()
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })
})
