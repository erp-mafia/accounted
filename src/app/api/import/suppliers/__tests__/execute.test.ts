import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockEmit = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/events', () => ({ eventBus: { emit: (...a: unknown[]) => mockEmit(...a) } }))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

import { POST } from '../execute/route'
import type { SupplierImportExecuteResult } from '@/lib/import/suppliers/types'

type ExecuteBody = { data: SupplierImportExecuteResult }

const mockUser = { id: 'user-1', email: 'test@test.se' }

const KONTOR_ID = '0b7a3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

function row(overrides: Record<string, unknown> = {}) {
  return {
    row_index: 2,
    name: 'Kontorsvaror AB',
    supplier_type: 'swedish_business',
    org_number: null,
    email: null,
    phone: null,
    address_line1: null,
    address_line2: null,
    postal_code: null,
    city: null,
    country: 'SE',
    vat_number: null,
    bankgiro: null,
    plusgiro: null,
    bank_account: null,
    iban: null,
    bic: null,
    default_payment_terms: 30,
    default_currency: 'SEK',
    notes: null,
    ...overrides,
  }
}

function post(body: unknown) {
  const request = createMockRequest('/api/import/suppliers/execute', { method: 'POST', body })
  return POST(request, { params: Promise.resolve({}) })
}

describe('POST /api/import/suppliers/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await post({ rows: [row()], update_duplicates: false }))
    expect(status).toBe(401)
  })

  it('returns 400 for an empty rows array', async () => {
    const { status } = await parseJsonResponse(await post({ rows: [], update_duplicates: false }))
    expect(status).toBe(400)
  })

  it('returns 400 when confirmed_duplicate_of is not an id', async () => {
    const { status } = await parseJsonResponse(
      await post({ rows: [row({ confirmed_duplicate_of: 'Kontorsvaror AB' })], update_duplicates: true }),
    )
    expect(status).toBe(400)
  })

  it('still matches a 12-digit org number to the stored 10-digit one', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'x', name: 'Kontorsvaror AB', org_number: '5560217780', email: null },
    ])

    const { status, body } = await parseJsonResponse<ExecuteBody>(
      await post({ rows: [row({ org_number: '165560217780' })], update_duplicates: false }),
    )

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
    expect(findCall('suppliers', 'insert')).toBeUndefined()
  })

  it('creates a new supplier when only the name matches and the user did not confirm', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: KONTOR_ID, name: 'Kontorsvaror AB', org_number: null, email: null },
    ])
    enqueue({ data: { id: 's1', name: 'Kontorsvaror AB', org_number: null, email: null } })

    const { status, body } = await parseJsonResponse<ExecuteBody>(
      await post({ rows: [row()], update_duplicates: true }),
    )

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })

  it('updates the same-name supplier the user confirmed', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: KONTOR_ID, name: 'Kontorsvaror AB', org_number: null, email: null },
    ])
    enqueue({ data: { id: KONTOR_ID, name: 'Kontorsvaror AB', bankgiro: '5050-1055' } })

    const { status, body } = await parseJsonResponse<ExecuteBody>(
      await post({
        rows: [row({ bankgiro: '5050-1055', confirmed_duplicate_of: KONTOR_ID })],
        update_duplicates: true,
      }),
    )

    expect(status).toBe(200)
    expect(body.data.updated).toBe(1)
    expect(findCalls('suppliers', 'eq')[0]).toEqual(['id', KONTOR_ID])
    expect(findCall('suppliers', 'insert')).toBeUndefined()
  })
})
