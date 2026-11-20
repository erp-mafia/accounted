/**
 * The session routes of the Bankgiro Lookup: GET /api/payments/creditor-lookup
 * (a probe without a giro, the lookup with one) and GET /api/payments/giro-numbers.
 * The service is mocked; the flag is read here so the probe is honest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/payments/bankgiro-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/bankgiro-lookup')>()),
  lookupCreditorName: vi.fn(),
  lookupCompanyGiroNumbers: vi.fn(),
  bankgiroLookupOpen: vi.fn(),
}))

import { bankgiroLookupOpen, lookupCompanyGiroNumbers, lookupCreditorName } from '@/lib/payments/bankgiro-lookup'
import { GET as creditorLookup } from '../creditor-lookup/route'
import { GET as giroNumbers } from '../giro-numbers/route'

const creditor = vi.mocked(lookupCreditorName)
const giros = vi.mocked(lookupCompanyGiroNumbers)
const open = vi.mocked(bankgiroLookupOpen)
const noParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  vi.stubEnv('OPENPAYMENTS_BANKGIRO_LOOKUP', 'true')
  open.mockResolvedValue(true)
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/payments/creditor-lookup', () => {
  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await creditorLookup(createMockRequest('/api/payments/creditor-lookup', { searchParams: { giro: '5050-1055', type: 'bankgiro' } }), noParams)
    expect(response.status).toBe(401)
    expect(creditor).not.toHaveBeenCalled()
  })

  it('is a probe without a giro: enabled true or false, nothing asked', async () => {
    const on = await parseJsonResponse<{ data: { enabled: boolean } }>(await creditorLookup(createMockRequest('/api/payments/creditor-lookup'), noParams))
    expect(on.status).toBe(200)
    expect(on.body.data).toEqual({ enabled: true })
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }))

    // Flag on, but no connector key or a sandbox company: the probe says so.
    open.mockResolvedValue(false)
    const closed = await parseJsonResponse<{ data: { enabled: boolean } }>(await creditorLookup(createMockRequest('/api/payments/creditor-lookup'), noParams))
    expect(closed.body.data).toEqual({ enabled: false })

    vi.stubEnv('OPENPAYMENTS_BANKGIRO_LOOKUP', '')
    const off = await parseJsonResponse<{ data: { enabled: boolean } }>(await creditorLookup(createMockRequest('/api/payments/creditor-lookup'), noParams))
    expect(off.status).toBe(200)
    expect(off.body.data).toEqual({ enabled: false })
    expect(creditor).not.toHaveBeenCalled()
  })

  it('answers enabled false without validating when the flag is off, even with a broken query', async () => {
    vi.stubEnv('OPENPAYMENTS_BANKGIRO_LOOKUP', 'false')
    const { status, body } = await parseJsonResponse<{ data: { enabled: boolean } }>(
      await creditorLookup(createMockRequest('/api/payments/creditor-lookup', { searchParams: { giro: '1', type: 'iban' } }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ enabled: false })
    expect(creditor).not.toHaveBeenCalled()
  })

  it('refuses a giro without a valid type, or too short, with 400', async () => {
    const noType = await creditorLookup(createMockRequest('/api/payments/creditor-lookup', { searchParams: { giro: '5050-1055' } }), noParams)
    expect(noType.status).toBe(400)
    const badType = await creditorLookup(createMockRequest('/api/payments/creditor-lookup', { searchParams: { giro: '5050-1055', type: 'iban' } }), noParams)
    expect(badType.status).toBe(400)
    const short = await creditorLookup(createMockRequest('/api/payments/creditor-lookup', { searchParams: { giro: '1234', type: 'bankgiro' } }), noParams)
    expect(short.status).toBe(400)
    expect(creditor).not.toHaveBeenCalled()
  })

  it('answers the flattened lookup for a giro, passing the OCR and the invoice reference', async () => {
    creditor.mockResolvedValue({ enabled: true, available: true, creditorName: 'Derome Bygg AB', ocrValid: false, warnings: [{ code: 'OCR_REF_INVALID', text: null }] })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await creditorLookup(createMockRequest('/api/payments/creditor-lookup', { searchParams: { giro: '5050-1055', type: 'bankgiro', ocr: '12' } }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ enabled: true, available: true, reason: null, creditor_name: 'Derome Bygg AB', ocr_valid: false, warnings: [{ code: 'OCR_REF_INVALID', text: null }] })
    expect(creditor).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), { giro: '5050-1055', type: 'bankgiro', ocr: '12', invoiceRef: null })

    creditor.mockResolvedValue({ enabled: true, available: false, reason: 'not_found' })
    const missing = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await creditorLookup(createMockRequest('/api/payments/creditor-lookup', { searchParams: { giro: '5050-1055', type: 'plusgiro', invoice_ref: 'INV-1' } }), noParams),
    )
    expect(missing.body.data).toMatchObject({ enabled: true, available: false, reason: 'not_found', creditor_name: null })
    expect(creditor).toHaveBeenLastCalledWith(expect.anything(), { giro: '5050-1055', type: 'plusgiro', ocr: null, invoiceRef: 'INV-1' })
  })
})

describe('GET /api/payments/giro-numbers', () => {
  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await giroNumbers(createMockRequest('/api/payments/giro-numbers'), noParams)).status).toBe(401)
    expect(giros).not.toHaveBeenCalled()
  })

  it('answers the company\'s registered giro numbers, flattened', async () => {
    giros.mockResolvedValue({ enabled: true, available: true, giroNumbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }] })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await giroNumbers(createMockRequest('/api/payments/giro-numbers'), noParams))
    expect(status).toBe(200)
    expect(body.data).toEqual({ enabled: true, available: true, reason: null, giro_numbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }] })
    expect(giros).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }))
  })

  it('answers enabled false as a 200 when the service says so', async () => {
    giros.mockResolvedValue({ enabled: false })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await giroNumbers(createMockRequest('/api/payments/giro-numbers'), noParams))
    expect(status).toBe(200)
    expect(body.data).toEqual({ enabled: false, available: false, reason: null, giro_numbers: [] })
  })
})
