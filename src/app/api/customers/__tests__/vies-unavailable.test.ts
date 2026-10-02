/**
 * PATCH /api/customers/[id] re-runs VIES when an EU business customer's VAT
 * number is saved. When VIES gives no verdict (member state down or
 * throttled) the save must not persist that as a failed validation: an
 * unchanged number keeps its earlier check, a changed one is unverified.
 *
 * Same harness as country.test.ts: a hand-rolled Supabase mock that records
 * update payloads and answers every query with `queryResult`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { VatValidationResult } from '@/types'

const captured: { update: Record<string, unknown>[] } = { update: [] }
let queryResult: { data: unknown; error: unknown } = { data: null, error: null }

const buildChain = (): unknown =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(queryResult)
        }
        return (...args: unknown[]) => {
          if (prop === 'update') captured.update.push(args[0] as Record<string, unknown>)
          return buildChain()
        }
      },
    },
  )

const supabase = {
  from: vi.fn(() => buildChain()),
  rpc: vi.fn(() => buildChain()),
}

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const validateVatNumberMock = vi.fn<(vat: string) => Promise<VatValidationResult>>()
vi.mock('@/lib/vat/vies-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vat/vies-client')>()),
  validateVatNumber: (vat: string) => validateVatNumberMock(vat),
}))

const syncDraftsMock = vi.fn().mockResolvedValue(0)
vi.mock('@/lib/invoices/sync-draft-vat-headers', () => ({
  syncDraftVatHeadersForCustomer: (...args: unknown[]) => syncDraftsMock(...args),
}))

import { PATCH } from '../[id]/route'

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const params = { params: Promise.resolve({ id: CUSTOMER_ID }) }
const STORED_VAT = 'FR40303265045'

const UNAVAILABLE: VatValidationResult = {
  valid: false,
  unavailable: true,
  error: 'VAT validation service unavailable. Please try again later.',
}

function validationWrites() {
  return captured.update.filter((u) => 'vat_number_validated' in u)
}

function patch(vatNumber: string) {
  return PATCH(
    createMockRequest(`/api/customers/${CUSTOMER_ID}`, {
      method: 'PATCH',
      body: { vat_number: vatNumber },
    }),
    params,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  captured.update.length = 0
  queryResult = {
    data: {
      id: CUSTOMER_ID,
      customer_type: 'eu_business',
      country: 'FR',
      vat_number: STORED_VAT,
      org_number: null,
    },
    error: null,
  }
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('PATCH /api/customers/[id]: VIES re-validation', () => {
  it('keeps the earlier validation when VIES is unavailable and the number is unchanged', async () => {
    validateVatNumberMock.mockResolvedValue(UNAVAILABLE)
    const response = await patch(STORED_VAT)
    expect(response.status).toBe(200)
    expect(validateVatNumberMock).toHaveBeenCalledWith(STORED_VAT)
    expect(validationWrites()).toHaveLength(0)
  })

  it('marks a changed number unverified when VIES is unavailable', async () => {
    validateVatNumberMock.mockResolvedValue(UNAVAILABLE)
    const response = await patch('FR12345678901')
    expect(response.status).toBe(200)
    expect(validationWrites()).toEqual([{ vat_number_validated: false, vat_number_validated_at: null }])
  })

  it('clears the flag on a definitive invalid verdict', async () => {
    validateVatNumberMock.mockResolvedValue({ valid: false })
    const response = await patch(STORED_VAT)
    expect(response.status).toBe(200)
    expect(validationWrites()).toEqual([{ vat_number_validated: false, vat_number_validated_at: null }])
  })

  it('stamps the flag on a valid verdict', async () => {
    validateVatNumberMock.mockResolvedValue({ valid: true, vat_number: STORED_VAT })
    const response = await patch(STORED_VAT)
    expect(response.status).toBe(200)
    const writes = validationWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0].vat_number_validated).toBe(true)
    expect(writes[0].vat_number_validated_at).toEqual(expect.any(String))
  })

  it('re-derives the customer open drafts after the save', async () => {
    validateVatNumberMock.mockResolvedValue({ valid: true, vat_number: STORED_VAT })
    const response = await patch(STORED_VAT)
    expect(response.status).toBe(200)
    expect(syncDraftsMock).toHaveBeenCalledWith(supabase, 'company-1', CUSTOMER_ID)
  })
})
