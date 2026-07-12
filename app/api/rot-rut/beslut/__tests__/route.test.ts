import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST as importPOST } from '../import/route'

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
// Skatteverket official example personnummer (synthetic).
const PNR = '193610058590'
const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeBeslutFile(overrides: Record<string, unknown> = {}) {
  return {
    version: '1',
    utforare: '168780003656',
    beslut: [
      {
        namn: 'ROT 2026-07-02',
        referensnummer: '20260000185-01',
        arenden: [{ personnummer: PNR, fakturanummer: '96458', godkantBelopp: 2000 }],
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

describe('POST /api/rot-rut/beslut/import', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await importPOST(
      createMockRequest('/api/rot-rut/beslut/import', { method: 'POST', body: makeBeslutFile() }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 400 on a malformed beslutsfil', async () => {
    const response = await importPOST(
      createMockRequest('/api/rot-rut/beslut/import', {
        method: 'POST',
        body: { version: '1', utforare: 'not-digits', beslut: [] },
      }),
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 ROT_RUT_BESLUT_WRONG_COMPANY when utforare mismatches', async () => {
    enqueue({ data: { org_number: '556123-4567' } }) // company_settings

    const response = await importPOST(
      createMockRequest('/api/rot-rut/beslut/import', { method: 'POST', body: makeBeslutFile() }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ROT_RUT_BESLUT_WRONG_COMPANY')
  })

  it('imports a matching beslut and returns per-beslut outcomes', async () => {
    enqueue({ data: { org_number: '878000-3656' } }) // company_settings
    enqueue({
      data: [
        {
          id: REQUEST_ID,
          name: 'ROT 2026-07-02',
          status: 'submitted',
          requested_total: 3000,
          decided_total: null,
          decided_at: null,
          skv_referensnummer: null,
        },
      ],
    }) // requests
    enqueue({
      data: [
        {
          id: 'item-1',
          invoice_id: 'inv-1',
          requested_amount: 3000,
          invoice: {
            invoice_number: '96458',
            deduction_personnummer_encrypted: encryptPersonnummer(PNR),
          },
        },
      ],
    }) // items
    enqueue({ data: null }) // item update
    enqueue({ data: null }) // request update

    const response = await importPOST(
      createMockRequest('/api/rot-rut/beslut/import', { method: 'POST', body: makeBeslutFile() }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { imported: number; errors: number; results: Array<Record<string, unknown>> }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.imported).toBe(1)
    expect(body.data.errors).toBe(0)
    expect(body.data.results[0]).toMatchObject({
      status: 'imported',
      request_id: REQUEST_ID,
      decided_total: 2000,
    })
  })
})
