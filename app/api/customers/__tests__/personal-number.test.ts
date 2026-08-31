import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'

const captured: { insert: unknown[]; update: unknown[] } = { insert: [], update: [] }
let queryResult: { data: unknown; error: unknown } = { data: null, error: null }

const buildChain = (): unknown =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => resolve(queryResult)
        }
        return (...args: unknown[]) => {
          if (prop === 'insert') captured.insert.push(args[0])
          if (prop === 'update') captured.update.push(args[0])
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

import { POST } from '../route'
import { PATCH } from '../[id]/route'

type CustomerWrite = { personal_number?: string | null }

// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'
const MASKED = '********-1234'
// What a row whose stored ciphertext cannot be decrypted reads back as.
const UNDECRYPTABLE_MASK = '********-????'

/**
 * The shape customers_personal_number_check accepts as of 20260726110000:
 * lowercase hex, 76 to 255 chars (24 iv + 32 auth tag + >= 20 ciphertext).
 * Asserting against it is the point of these tests. The routes encrypt before
 * writing, and until 20260726110000 the column still demanded the plaintext
 * personnummer format below, so every write was rejected by Postgres while
 * this mocked suite passed. Pinning both directions is what makes the unit
 * test able to catch that mismatch; tests/pg/customers-personal-number-
 * ciphertext.pg.test.ts proves the constraint itself.
 */
const CIPHERTEXT_SHAPE = /^[0-9a-f]{76,255}$/
const OLD_PLAINTEXT_CHECK = /^(\d{6}|\d{8})[-+]?\d{4}$/

describe('personal_number on customer routes', () => {
  const routeParams = { params: Promise.resolve({ id: 'customer-1' }) }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    captured.insert.length = 0
    captured.update.length = 0
    queryResult = { data: null, error: null }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 before creating a customer when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: { name: 'Anna Andersson', customer_type: 'individual' },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(401)
    expect(captured.insert).toHaveLength(0)
  })

  it('returns 400 for an invalid personal number', async () => {
    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: {
          name: 'Anna Andersson',
          customer_type: 'individual',
          personal_number: 'not-a-personal-number',
        },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
    expect(captured.insert).toHaveLength(0)
  })

  it('stores the personal number when creating a private customer', async () => {
    // What the insert returns is what the DB would hold: ciphertext.
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    queryResult = {
      data: {
        id: 'customer-1',
        name: 'Anna Andersson',
        customer_type: 'individual',
        personal_number: stored,
      },
      error: null,
    }

    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: {
          name: 'Anna Andersson',
          customer_type: 'individual',
          personal_number: PERSONAL_NUMBER,
        },
      }),
      { params: Promise.resolve({}) },
    )

    const { status, body } = await parseJsonResponse<{ data: { personal_number: string } }>(response)
    expect(status).toBe(200)

    const written = (captured.insert[0] as CustomerWrite).personal_number as string
    // The value must be storable: Postgres accepts ciphertext shape only.
    expect(written).toMatch(CIPHERTEXT_SHAPE)
    expect(written).not.toMatch(OLD_PLAINTEXT_CHECK)
    // ...and it must still be the customer's personnummer.
    expect(written).not.toBe(PERSONAL_NUMBER)
    expect(decryptPersonnummer(written)).toBe(PERSONAL_NUMBER)
    // Read back masked: no read path returns the personnummer itself.
    expect(body.data.personal_number).toBe(MASKED)
  })

  it('updates the personal number for an existing private customer', async () => {
    const stored = encryptPersonnummer('900101-1234')
    queryResult = {
      data: {
        id: 'customer-1',
        customer_type: 'individual',
        personal_number: stored,
      },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { personal_number: '900101-1234' },
      }),
      routeParams,
    )

    const { status, body } = await parseJsonResponse<{ data: { personal_number: string } }>(response)
    expect(status).toBe(200)

    const written = (captured.update[0] as CustomerWrite).personal_number as string
    expect(written).toMatch(CIPHERTEXT_SHAPE)
    expect(written).not.toMatch(OLD_PLAINTEXT_CHECK)
    expect(written).not.toBe('900101-1234')
    expect(decryptPersonnummer(written)).toBe('900101-1234')
    expect(body.data.personal_number).toBe(MASKED)
  })

  it('keeps the stored personal number when the masked value is sent back', async () => {
    queryResult = {
      data: {
        id: 'customer-1',
        customer_type: 'individual',
        name: 'Anna A',
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
      error: null,
    }

    // A client that PATCHes back the customer it just read submits the mask.
    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { name: 'Anna A', personal_number: MASKED },
      }),
      routeParams,
    )

    const { status, body } = await parseJsonResponse<{ data: { personal_number: string } }>(response)
    expect(status).toBe(200)
    // Neither stored literally nor cleared: the column is left untouched.
    expect(captured.update[0]).not.toHaveProperty('personal_number')
    expect(body.data.personal_number).toBe(MASKED)
  })

  it('keeps the stored value when the undecryptable placeholder is sent back', async () => {
    // A row whose ciphertext cannot be decrypted reads back as
    // '********-????'. That is still a mask, so PATCHing it must leave the
    // column alone. When only '********-1234' was recognized, this 400'd and
    // took the whole edit with it: the customer's name and address could not
    // be saved either, over a field the user had no way to correct.
    queryResult = {
      data: {
        id: 'customer-1',
        customer_type: 'individual',
        name: 'Anna Andersson',
        personal_number: 'ab'.repeat(40),
      },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: {
          name: 'Anna Andersson',
          city: 'Göteborg',
          personal_number: UNDECRYPTABLE_MASK,
        },
      }),
      routeParams,
    )

    const { status, body } = await parseJsonResponse<{ data: { personal_number: string } }>(response)
    expect(status).toBe(200)
    // The rest of the edit went through...
    expect(captured.update[0]).toMatchObject({ name: 'Anna Andersson', city: 'Göteborg' })
    // ...and the unreadable ciphertext was neither stored over nor cleared.
    expect(captured.update[0]).not.toHaveProperty('personal_number')
    expect(body.data.personal_number).toBe(UNDECRYPTABLE_MASK)
  })

  it('replaces an undecryptable value when the user types a real personnummer', async () => {
    // The repair path, and the only "backfill" that can exist: nothing can
    // recover the unreadable ciphertext, but the user can overwrite it.
    queryResult = {
      data: {
        id: 'customer-1',
        customer_type: 'individual',
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { personal_number: PERSONAL_NUMBER },
      }),
      routeParams,
    )

    expect(response.status).toBe(200)
    const written = (captured.update[0] as CustomerWrite).personal_number as string
    expect(written).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(written)).toBe(PERSONAL_NUMBER)
  })

  it('rejects the undecryptable placeholder on create', async () => {
    // Same rule as the '-1234' mask: on create there is no stored value to
    // preserve, so a mask is a client error.
    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: {
          name: 'Anna Andersson',
          customer_type: 'individual',
          personal_number: UNDECRYPTABLE_MASK,
        },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
    expect(captured.insert).toHaveLength(0)
  })

  it('does not treat a masked value as a personal number on a corporate customer', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'individual', name: 'Anna A' },
      error: null,
    }

    // Switching type away from individual while echoing the mask clears the
    // column, and must not trip the "not allowed for businesses" guard.
    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { customer_type: 'swedish_business', personal_number: MASKED },
      }),
      routeParams,
    )

    expect(response.status).toBe(200)
    expect((captured.update[0] as CustomerWrite).personal_number).toBeNull()
  })

  it('rejects the masked value on create, where there is nothing to preserve', async () => {
    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: {
          name: 'Anna Andersson',
          customer_type: 'individual',
          personal_number: MASKED,
        },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
    expect(captured.insert).toHaveLength(0)
  })

  it('clears the personal number when null is sent', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'individual', personal_number: null },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { personal_number: null },
      }),
      routeParams,
    )

    expect(response.status).toBe(200)
    expect((captured.update[0] as CustomerWrite).personal_number).toBeNull()
  })

  it('does not change the personal number when the field is omitted', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'individual', name: 'Anna A' },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { name: 'Anna A' },
      }),
      routeParams,
    )

    expect(response.status).toBe(200)
    expect(captured.update[0]).not.toHaveProperty('personal_number')
  })

  it('rejects a personal number for a corporate customer', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'swedish_business' },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { personal_number: '900101-1234' },
      }),
      routeParams,
    )

    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('CUSTOMER_PERSONAL_NUMBER_NOT_ALLOWED')
    expect(captured.update).toHaveLength(0)
  })

  it('returns 404 when the customer does not exist', async () => {
    queryResult = {
      data: null,
      error: { code: 'PGRST116', message: 'No rows returned' },
    }

    const response = await PATCH(
      createMockRequest('/api/customers/missing', {
        method: 'PATCH',
        body: { personal_number: '900101-1234' },
      }),
      { params: Promise.resolve({ id: 'missing' }) },
    )

    expect(response.status).toBe(404)
  })
})

// A personnummer submitted as org_number on an individual is the personnummer
// in the wrong field: stored encrypted in personal_number, org_number left
// empty, on create and on update alike.
describe('personnummer submitted as org_number on an individual', () => {
  const routeParams = { params: Promise.resolve({ id: 'customer-1' }) }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    captured.insert.length = 0
    captured.update.length = 0
    queryResult = { data: null, error: null }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('POST stores it encrypted as personal_number and leaves org_number empty', async () => {
    queryResult = {
      data: {
        id: 'customer-1',
        name: 'Bertil Bengtsson',
        customer_type: 'individual',
        org_number: null,
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
      error: null,
    }

    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: { name: 'Bertil Bengtsson', customer_type: 'individual', org_number: PERSONAL_NUMBER },
      }),
      { params: Promise.resolve({}) },
    )

    const { status, body } = await parseJsonResponse<{ data: { personal_number: string; org_number: string | null } }>(response)
    expect(status).toBe(200)
    const inserted = captured.insert[0] as { org_number?: string | null; personal_number?: string | null }
    expect(inserted.org_number ?? null).toBeNull()
    expect(inserted.personal_number).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(inserted.personal_number!)).toBe(PERSONAL_NUMBER)
    expect(JSON.stringify(inserted)).not.toContain(PERSONAL_NUMBER)
    expect(body.data.personal_number).toBe(MASKED)
  })

  it('PATCH stores it encrypted as personal_number and clears org_number', async () => {
    queryResult = {
      data: {
        id: 'customer-1',
        customer_type: 'individual',
        org_number: null,
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { org_number: PERSONAL_NUMBER },
      }),
      routeParams,
    )

    const { status } = await parseJsonResponse<unknown>(response)
    expect(status).toBe(200)
    const updated = captured.update[0] as { org_number?: string | null; personal_number?: string | null }
    expect(updated.org_number).toBeNull()
    expect(updated.personal_number).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(updated.personal_number!)).toBe(PERSONAL_NUMBER)
  })

  it('PATCH refuses an org_number that is a different personnummer than personal_number', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'individual' },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { org_number: '19850505-5555', personal_number: PERSONAL_NUMBER },
      }),
      routeParams,
    )

    const { status, body } = await parseJsonResponse<unknown>(response)
    expect(status).toBe(400)
    expect(JSON.stringify(body)).toContain('CUSTOMER_PERSONAL_NUMBER_CONFLICT')
    expect(captured.update).toHaveLength(0)
  })
})
