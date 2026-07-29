/**
 * GET /api/customers/[id]/personal-number: the drill-in behind the mask.
 *
 * Every other customer read surface returns '********-1234'. Without this
 * endpoint the field was write-only by construction: a user could store a
 * personnummer and had no way to check what had actually been stored, which is
 * what made an unreadable value indistinguishable from a rendering fault.
 *
 * What these tests pin:
 *   - auth and tenancy run before anything is decrypted
 *   - a stored ciphertext comes back as the full personnummer
 *   - an undecryptable row answers with its own code, not a 500, because the
 *     user can fix it in one step by typing the number in again
 */
import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

let queryResult: { data: unknown; error: unknown } = { data: null, error: null }

const buildChain = (): unknown =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => resolve(queryResult)
        }
        return () => buildChain()
      },
    },
  )

const supabase = { from: vi.fn(() => buildChain()) }

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

import { GET } from '../[id]/personal-number/route'

// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'

// Hex of the shape customers_personal_number_check accepts that is NOT valid
// ciphertext: the GCM auth tag can never verify.
const GARBAGE_HEX = 'ab'.repeat(40)

describe('GET /api/customers/[id]/personal-number', () => {
  const routeParams = { params: Promise.resolve({ id: 'customer-1' }) }
  const request = () => createMockRequest('/api/customers/customer-1/personal-number')

  beforeEach(() => {
    vi.clearAllMocks()
    queryResult = { data: null, error: null }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 403 for a viewer, who keeps seeing the mask', async () => {
    // The drill-in retires the `no_full_value_read_endpoint` safeguard in
    // .compliance/ropa.yaml, so it stays as narrow as the purpose allows: the
    // person who needs to verify a personnummer is the one who can correct it.
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    queryResult = {
      data: { id: 'customer-1', personal_number: encryptPersonnummer(PERSONAL_NUMBER) },
      error: null,
    }

    const response = await GET(request(), routeParams)

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(PERSONAL_NUMBER)
  })

  it('returns 401 when unauthenticated, before touching the row', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(request(), routeParams)

    expect(response.status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns the full personnummer for a stored ciphertext', async () => {
    queryResult = {
      data: { id: 'customer-1', personal_number: encryptPersonnummer(PERSONAL_NUMBER) },
      error: null,
    }

    const response = await GET(request(), routeParams)
    const { status, body } = await parseJsonResponse<{ data: { personal_number: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.personal_number).toBe(PERSONAL_NUMBER)
  })

  it('returns a legacy plaintext value unchanged', async () => {
    queryResult = { data: { id: 'customer-1', personal_number: '900101-1234' }, error: null }

    const { status, body } = await parseJsonResponse<{ data: { personal_number: string } }>(
      await GET(request(), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data.personal_number).toBe('900101-1234')
  })

  it('returns 404 when the customer does not exist in the active company', async () => {
    queryResult = { data: null, error: { code: 'PGRST116', message: 'No rows returned' } }

    const response = await GET(request(), { params: Promise.resolve({ id: 'missing' }) })

    expect(response.status).toBe(404)
  })

  it('returns 404 when the customer has no stored personnummer', async () => {
    queryResult = { data: { id: 'customer-1', personal_number: null }, error: null }

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(request(), routeParams),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('CUSTOMER_NO_PERSONAL_NUMBER')
  })

  it('answers with a specific code, not a 500, when the value cannot be decrypted', async () => {
    // The row that renders as '********-????'. Retrying never helps, so this
    // must not look transient: the UI turns this code into "type it in again".
    queryResult = { data: { id: 'customer-1', personal_number: GARBAGE_HEX }, error: null }

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(request(), routeParams),
    )

    expect(status).toBe(422)
    expect(body.error.code).toBe('CUSTOMER_PERSONAL_NUMBER_UNREADABLE')
  })

  it('never leaks the stored ciphertext, whatever the outcome', async () => {
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    queryResult = { data: { id: 'customer-1', personal_number: stored }, error: null }

    const raw = await (await GET(request(), routeParams)).text()

    expect(raw).not.toContain(stored)
  })
})
