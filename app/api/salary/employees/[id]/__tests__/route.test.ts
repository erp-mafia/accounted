/**
 * Auth-wiring tests for /api/salary/employees/[id] (GET/PATCH/DELETE).
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers 401 (unauth), 403 (viewer role), and a DELETE happy path
 * (soft delete, BFL retention).
 *
 * Plus the personnummer contract on this route, which handles encrypted PII on
 * both the read and the write side:
 *   - reads expose the mask under `personnummer_masked`, never under the
 *     writable `personnummer` key (no mask round-trip into the encrypt path),
 *   - a PATCH that omits personnummer must leave the ciphertext and
 *     personnummer_last4 completely untouched,
 *   - a masked value offered as a write is refused,
 *   - a genuine new value is stored encrypted, never plaintext.
 * The empty-string / null wipe guard is pinned in personnummer-write-guard.test.ts,
 * which loosens the Zod schema to prove the defence lives in the route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { DELETE, GET, PATCH } from '../route'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

// Obviously synthetic fixtures. STORED_PNR is only ever masked, so it needs no
// check digit; NEW_PNR goes through validatePersonnummer, so its Luhn check
// digit is genuinely correct (sum over 0001010008 = 10).
const STORED_PNR = '190203040000'
const STORED_CIPHERTEXT = encryptPersonnummer(STORED_PNR)
const NEW_PNR = '190001010008'

const EXISTING_ROW = {
  id: 'emp-1',
  company_id: 'company-1',
  first_name: 'Test',
  last_name: 'Testsson',
  personnummer: STORED_CIPHERTEXT,
  personnummer_last4: '0000',
  employment_type: 'employee',
  salary_type: 'monthly',
  monthly_salary: 30000,
  f_skatt_status: 'a_skatt',
  is_sidoinkomst: false,
  tax_table_number: 34,
} as const

/**
 * Supabase double that returns EXISTING_ROW on reads, records the payload handed
 * to `.update()`, and resolves the update chain with the merged row. `captured.updates`
 * staying null is the assertion that no write was attempted at all.
 */
function employeeSupabase(existing: Record<string, unknown> = { ...EXISTING_ROW }) {
  const captured: { updates: Record<string, unknown> | null } = { updates: null }

  function chainFor(state: { isUpdate: boolean }): unknown {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const data = state.isUpdate ? { ...existing, ...(captured.updates ?? {}) } : existing
          return (resolve: (v: unknown) => void) => resolve({ data, error: null })
        }
        return (...args: unknown[]) => {
          if (prop === 'update') {
            state.isUpdate = true
            captured.updates = args[0] as Record<string, unknown>
          }
          return chainFor(state)
        }
      },
    }
    return new Proxy({}, handler)
  }

  return { supabase: { from: vi.fn(() => chainFor({ isUpdate: false })) }, captured }
}

function patchRequest(body: Record<string, unknown>) {
  return createMockRequest('/api/salary/employees/emp-1', { method: 'PATCH', body })
}

describe('DELETE /api/salary/employees/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(createMockRequest('/api/salary/employees/emp-1', { method: 'DELETE' }), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(createMockRequest('/api/salary/employees/emp-1', { method: 'DELETE' }), params)
    expect(response.status).toBe(403)
  })

  it('soft-deletes the employee (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } })

    const response = await DELETE(createMockRequest('/api/salary/employees/emp-1', { method: 'DELETE' }), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string; is_active: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'emp-1', is_active: false })
  })
})

describe('personnummer contract on /api/salary/employees/[id]', () => {
  let captured: { updates: Record<string, unknown> | null }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    const mock = employeeSupabase()
    captured = mock.captured
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('GET returns the mask under personnummer_masked and drops the ciphertext', async () => {
    const response = await GET(createMockRequest('/api/salary/employees/emp-1'), params)
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    expect(body.data.personnummer_masked).toBe('19020304-XXXX')
    // The writable key name must not carry the mask: a client that reads this
    // object and writes it back would otherwise send the mask to the encrypt path.
    expect('personnummer' in body.data).toBe(false)
    // personnummer_last4 must not ride along either: the mask is
    // YYYYMMDD-XXXX, so mask + last4 reassembles the full personnummer.
    expect('personnummer_last4' in body.data).toBe(false)
    // Neither the plaintext nor the stored ciphertext may leave the server.
    expect(JSON.stringify(body)).not.toContain(STORED_PNR)
    expect(JSON.stringify(body)).not.toContain(STORED_CIPHERTEXT)
  })

  it('PATCH without personnummer leaves the ciphertext and last4 untouched', async () => {
    const response = await PATCH(patchRequest({ first_name: 'Ny' }), params)
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    expect(captured.updates).toEqual({ first_name: 'Ny' })
    // Absent key means "identity unchanged": neither column may appear.
    expect(captured.updates).not.toHaveProperty('personnummer')
    expect(captured.updates).not.toHaveProperty('personnummer_last4')
    expect(body.data.personnummer_masked).toBe('19020304-XXXX')
    expect('personnummer' in body.data).toBe(false)
    expect('personnummer_last4' in body.data).toBe(false)
  })

  it('PATCH refuses a masked personnummer instead of encrypting the mask', async () => {
    const response = await PATCH(patchRequest({ personnummer: '19020304-XXXX' }), params)

    expect(response.status).toBe(400)
    expect(captured.updates).toBeNull()
  })

  it('PATCH stores a genuine new personnummer encrypted, never plaintext', async () => {
    const response = await PATCH(patchRequest({ personnummer: NEW_PNR }), params)
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    const stored = captured.updates?.personnummer as string
    expect(stored).not.toBe(NEW_PNR)
    expect(decryptPersonnummer(stored)).toBe(NEW_PNR)
    expect(captured.updates?.personnummer_last4).toBe('0008')
    // The response echoes only the mask, under the read-only key. The updated
    // last4 is written to the row but must not appear in the response.
    expect(body.data.personnummer_masked).toBe('19000101-XXXX')
    expect('personnummer' in body.data).toBe(false)
    expect('personnummer_last4' in body.data).toBe(false)
    expect(JSON.stringify(body)).not.toContain(NEW_PNR)
    expect(JSON.stringify(body)).not.toContain('"0008"')
  })
})

/**
 * Jämkning (Skatteverket beslut om ändrad beräkning av skatteavdrag) on the
 * legacy PATCH route, which is the one the employee edit page calls. #1913:
 * the merged-state check mirrors the v1 route so a percentage without a
 * start date gets a 400 instead of being stored as a silently inert beslut,
 * while explicit nulls must survive to the UPDATE (null = clear the beslut).
 */
describe('jämkning on PATCH /api/salary/employees/[id]', () => {
  const JAMKNING_START_REQUIRED = 'Jämkningens startdatum måste anges när jämkningsprocent sätts'
  const JAMKNING_END_REQUIRED = 'Jämkningens slutdatum måste anges när jämkningsprocent sätts'
  const JAMKNING_ORDER = 'Jämkningens slutdatum måste vara efter startdatumet'

  function useRow(existing: Record<string, unknown>) {
    const mock = employeeSupabase(existing)
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    return mock.captured
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('400 when a percentage is set with an explicit null start date', async () => {
    const captured = useRow({ ...EXISTING_ROW, jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null })

    const response = await PATCH(
      patchRequest({ jamkning_percentage: 20, jamkning_valid_from: null, jamkning_valid_to: null }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain(JAMKNING_START_REQUIRED)
    expect(captured.updates).toBeNull()
  })

  it('400 when only the percentage is sent and the stored row has no start date (sparse patch)', async () => {
    const captured = useRow({ ...EXISTING_ROW, jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null })

    const response = await PATCH(patchRequest({ jamkning_percentage: 20 }), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain(JAMKNING_START_REQUIRED)
    expect(captured.updates).toBeNull()
  })

  it('400 when a percentage is set with a start date but no end date (#2058)', async () => {
    const captured = useRow({ ...EXISTING_ROW, jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null })

    const response = await PATCH(
      patchRequest({ jamkning_percentage: 20, jamkning_valid_from: '2026-01-01', jamkning_valid_to: null }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain(JAMKNING_END_REQUIRED)
    expect(captured.updates).toBeNull()
  })

  it('400 when the end date precedes the start date within the body', async () => {
    const captured = useRow({ ...EXISTING_ROW })

    const response = await PATCH(
      patchRequest({ jamkning_percentage: 20, jamkning_valid_from: '2026-06-01', jamkning_valid_to: '2026-01-31' }),
      params,
    )

    expect(response.status).toBe(400)
    expect(captured.updates).toBeNull()
  })

  it('400 when a new end date precedes the stored start date (merged ordering)', async () => {
    const captured = useRow({
      ...EXISTING_ROW,
      jamkning_percentage: 20,
      jamkning_valid_from: '2026-06-01',
      jamkning_valid_to: '2026-12-31',
    })

    const response = await PATCH(patchRequest({ jamkning_valid_to: '2026-01-31' }), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain(JAMKNING_ORDER)
    expect(captured.updates).toBeNull()
  })

  it('200 and writes percentage + both dates (happy path)', async () => {
    const captured = useRow({ ...EXISTING_ROW, jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null })

    const response = await PATCH(
      patchRequest({ jamkning_percentage: 20, jamkning_valid_from: '2026-01-01', jamkning_valid_to: '2026-12-31' }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    expect(captured.updates).toEqual({
      jamkning_percentage: 20,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: '2026-12-31',
    })
    expect(body.data.jamkning_percentage).toBe(20)
  })

  it('200 and clears a stored beslut with explicit nulls (nulls must survive, not be dropped)', async () => {
    const captured = useRow({
      ...EXISTING_ROW,
      jamkning_percentage: 20,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: '2026-12-31',
    })

    const response = await PATCH(
      patchRequest({ jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    expect(captured.updates).toEqual({
      jamkning_percentage: null,
      jamkning_valid_from: null,
      jamkning_valid_to: null,
    })
    expect(body.data.jamkning_percentage).toBeNull()
  })

  it('200 on an unrelated edit to a legacy row with inconsistent jamkning state (touched-gate)', async () => {
    const captured = useRow({ ...EXISTING_ROW, jamkning_percentage: 15, jamkning_valid_from: null, jamkning_valid_to: null })

    const response = await PATCH(patchRequest({ first_name: 'Ny' }), params)

    expect(response.status).toBe(200)
    expect(captured.updates).toEqual({ first_name: 'Ny' })
  })
})
