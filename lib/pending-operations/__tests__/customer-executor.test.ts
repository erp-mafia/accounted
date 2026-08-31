import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { commitPendingOperation } from '../commit'
import { validateVatNumber } from '@/lib/vat/vies-client'

vi.mock('@/lib/vat/vies-client', () => ({
  validateVatNumber: vi.fn(),
}))

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-customer-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'update_customer',
    status: 'pending',
    title: 'Update customer',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Test key',
    risk_level: 'low',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-07-21T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-21T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commitPendingOperation: update_customer', () => {
  it('updates the selected customer and returns the qualified id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: { customer_type: 'swedish_business' } })
    enqueue({
      data: {
        id: CUSTOMER_ID,
        name: 'Test Customer AB',
        customer_type: 'swedish_business',
        customer_number: '1001',
        email: 'billing@example.test',
        phone: '0701234567',
        address_line1: 'Testgatan 1',
        address_line2: null,
        postal_code: '12345',
        city: 'New City',
        country: 'Sweden',
        org_number: '556000-0000',
        vat_number: null,
        vat_number_validated: false,
        language: 'sv',
        default_payment_terms: 14,
        notes: null,
      },
    })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { city: 'New City', default_payment_terms: 14 },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      customer_id: CUSTOMER_ID,
      city: 'New City',
      default_payment_terms: 14,
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'customers')
    expect(supabase.from).toHaveBeenNthCalledWith(3, 'customers')
  })

  it('auto-rejects when the customer no longer exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { city: 'New City' },
      }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
  })

  it('revalidates an updated EU VAT number at commit time', async () => {
    vi.mocked(validateVatNumber).mockResolvedValueOnce({
      valid: true,
      name: 'Test Customer GmbH',
      address: 'Teststrasse 1',
      country_code: 'DE',
      vat_number: 'DE123456789',
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: { customer_type: 'eu_business' } })
    enqueue({
      data: {
        id: CUSTOMER_ID,
        name: 'Test Customer GmbH',
        customer_type: 'eu_business',
        customer_number: null,
        email: null,
        phone: null,
        address_line1: 'Teststrasse 1',
        address_line2: null,
        postal_code: '10115',
        city: 'Berlin',
        country: 'Germany',
        org_number: null,
        vat_number: 'DE123456789',
        vat_number_validated: true,
        language: 'en',
        default_payment_terms: 30,
        notes: null,
      },
    })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { vat_number: 'DE123456789' },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      customer_id: CUSTOMER_ID,
      vat_number: 'DE123456789',
      vat_number_validated: true,
    })
    expect(validateVatNumber).toHaveBeenCalledWith('DE123456789')
  })

  it('clears the personal number when an individual becomes a business', async () => {
    const results = [
      { data: { id: 'op-customer-1' }, error: null },
      { data: { customer_type: 'individual' }, error: null },
      {
        data: {
          id: CUSTOMER_ID,
          name: 'Test Customer AB',
          customer_type: 'swedish_business',
          customer_number: null,
          email: null,
          phone: null,
          address_line1: null,
          address_line2: null,
          postal_code: null,
          city: null,
          country: 'Sweden',
          org_number: null,
          vat_number: null,
          vat_number_validated: false,
          language: 'sv',
          default_payment_terms: 30,
          notes: null,
        },
        error: null,
      },
      { data: null, error: null },
    ]
    const customerUpdates: Record<string, unknown>[] = []
    const supabase = {
      from: vi.fn((table: string) => {
        const result = results.shift() ?? { data: null, error: null }
        const chain: Record<string, unknown> = new Proxy({}, {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (value: unknown) => void) => resolve(result)
            }
            if (prop === 'update') {
              return (payload: Record<string, unknown>) => {
                if (table === 'customers') customerUpdates.push(payload)
                return chain
              }
            }
            return () => chain
          },
        })
        return chain
      }),
    }

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { customer_type: 'swedish_business' },
      }),
    )

    expect(result.status).toBe('committed')
    expect(customerUpdates).toEqual([
      expect.objectContaining({
        customer_type: 'swedish_business',
        personal_number: null,
      }),
    ])
  })

  it('rejects tampered fields before reading the customer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { company_id: 'other-company', city: 'New City' },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/unrecognized key/i)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})

// ── personal_number (#1876) ───────────────────────────────────────────
//
// Synthetic personnummer, never a real one. Staging encrypts, so the
// executor only ever sees personal_number_encrypted: ciphertext sets the
// column, explicit null clears it, absent leaves it untouched.
const PERSONAL_NUMBER = '19900101-1234'

function individualRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    name: 'Anna Andersson',
    customer_type: 'individual',
    customer_number: null,
    email: null,
    phone: null,
    address_line1: null,
    address_line2: null,
    postal_code: null,
    city: null,
    country: 'Sweden',
    org_number: null,
    vat_number: null,
    vat_number_validated: false,
    language: 'sv',
    default_payment_terms: 30,
    notes: null,
    personal_number: null,
    ...overrides,
  }
}

describe('commitPendingOperation: update_customer personal_number', () => {
  it('stores the staged ciphertext as the customer personal_number and returns only the mask', async () => {
    const encrypted = encryptPersonnummer(PERSONAL_NUMBER)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } }) // CAS claim
    enqueue({ data: { customer_type: 'individual' } }) // current read
    enqueue({ data: individualRow({ personal_number: encrypted }) }) // update returning
    enqueue({ data: null }) // dispatcher update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { personal_number_encrypted: encrypted },
      }),
    )

    expect(result.status).toBe('committed')
    const updatePayload = findCall('customers', 'update')?.[0] as Record<string, unknown>
    expect(updatePayload).toMatchObject({ personal_number: encrypted })
    expect(updatePayload).not.toHaveProperty('personal_number_encrypted')
    expect(result.data).toMatchObject({
      customer_id: CUSTOMER_ID,
      personal_number_masked: '********-1234',
    })
    // result_data is persisted and rendered in approval UIs: never the
    // plaintext, never the raw ciphertext.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(PERSONAL_NUMBER)
    expect(serialized).not.toContain(encrypted)
  })

  it('clears the stored personnummer on explicit null', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: { customer_type: 'individual' } })
    enqueue({ data: individualRow() })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { personal_number_encrypted: null },
      }),
    )

    expect(result.status).toBe('committed')
    const updatePayload = findCall('customers', 'update')?.[0] as Record<string, unknown>
    expect(updatePayload).toHaveProperty('personal_number', null)
    expect(result.data).toMatchObject({ personal_number_masked: null })
  })

  it('leaves the stored personnummer untouched when the field is absent', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: { customer_type: 'individual' } })
    enqueue({ data: individualRow({ city: 'New City' }) })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { city: 'New City' },
      }),
    )

    expect(result.status).toBe('committed')
    const updatePayload = findCall('customers', 'update')?.[0] as Record<string, unknown>
    expect(updatePayload).not.toHaveProperty('personal_number')
  })

  it('refuses a staged personnummer on a business customer without writing', async () => {
    const encrypted = encryptPersonnummer(PERSONAL_NUMBER)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: { customer_type: 'swedish_business' } })
    enqueue({ data: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { personal_number_encrypted: encrypted },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/individual/)
    expect(findCall('customers', 'update')).toBeUndefined()
  })

  it('rejects a tampered plaintext personal_number key in changes', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { personal_number: PERSONAL_NUMBER },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/unrecognized key/i)
    expect(findCall('customers', 'update')).toBeUndefined()
  })

  it('rejects a tampered plaintext value under personal_number_encrypted', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-customer-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        customer_id: CUSTOMER_ID,
        changes: { personal_number_encrypted: PERSONAL_NUMBER },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/encrypted personal number/i)
    expect(findCall('customers', 'update')).toBeUndefined()
  })
})
