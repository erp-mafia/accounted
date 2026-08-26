import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { hashRequest } from '@/lib/api/idempotency'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'
import { tools } from '../server'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const tool = () => tools.find((candidate) => candidate.name === 'gnubok_update_customer')!

function currentCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    name: 'Test Customer AB',
    customer_type: 'swedish_business',
    customer_number: '1001',
    email: 'billing@example.test',
    phone: '',
    address_line1: 'Testgatan 1',
    address_line2: null,
    postal_code: '12345',
    city: 'Teststad',
    country: 'Sweden',
    org_number: '556000-0000',
    vat_number: null,
    vat_number_validated: false,
    language: 'sv',
    default_payment_terms: 30,
    notes: null,
    ...overrides,
  }
}

describe('gnubok_update_customer: registration', () => {
  it('is a strict, staged customers:write tool at low risk', () => {
    expect(tool()).toBeDefined()
    expect(tool().inputSchema.additionalProperties).toBe(false)
    expect(tool().annotations.readOnlyHint).toBe(false)
    expect(tool().annotations.idempotentHint).toBe(true)
    expect(tool().catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_update_customer).toBe('customers:write')
    expect(OPERATION_RISK_TIERS.update_customer).toBe('low')
  })

  it('exposes personal_number in the strict input schema, nullable for clearing', () => {
    const properties = tool().inputSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.personal_number).toMatchObject({ type: ['string', 'null'] })
  })

  it('keeps the wide write schema discoverable through tool search', async () => {
    const search = tools.find((candidate) => candidate.name === 'gnubok_search_tools')!
    const result = (await search.execute(
      {
        query: 'update customer',
        detail: 'full',
        __keyScopes: ['customers:write'],
      },
      'company-1',
      'user-1',
      {} as never,
    )) as { tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> }

    expect(result.tools).toEqual([
      expect.objectContaining({
        name: 'gnubok_update_customer',
        inputSchema: expect.any(Object),
      }),
    ])
  })
})

describe('gnubok_update_customer: validation and staging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires at least one changed field', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/at least one/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects malformed email before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, email: 'not-an-email', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/email/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails when the customer is outside the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, city: 'New City', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
  })

  it('returns a merged dry-run preview without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer() })

    const result = (await tool().execute(
      {
        customer_id: CUSTOMER_ID,
        city: 'New City',
        default_payment_terms: 14,
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      dry_run?: boolean
      preview: { proposed?: Record<string, unknown> }
    }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview.proposed).toMatchObject({
      customer_id: CUSTOMER_ID,
      name: 'Test Customer AB',
      city: 'New City',
      default_payment_terms: 14,
    })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('stages the partial update for approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer() })
    enqueue({ data: { id: 'op-customer-1' } })

    const result = (await tool().execute(
      { customer_id: CUSTOMER_ID, phone: '0701234567' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; risk_level: string }

    expect(result).toMatchObject({
      staged: true,
      operation_id: 'op-customer-1',
      risk_level: 'low',
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
  })
})

// ── personal_number (#1876) ───────────────────────────────────────────
//
// Synthetic personnummer, never a real one. REST PATCH semantics
// (app/api/customers/[id]/route.ts): plaintext sets (encrypted at staging),
// masked echo means unchanged, explicit null clears.
const PERSONAL_NUMBER = '19900101-1234'
const MASKED = '********-1234'
const CIPHERTEXT_SHAPE = /^[0-9a-f]{76,255}$/

type StagedInsert = {
  params: { changes: Record<string, unknown> }
  preview_data: {
    current: Record<string, unknown>
    changes: Record<string, unknown>
    proposed: Record<string, unknown>
  }
}

describe('gnubok_update_customer: personal_number', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stages the personnummer encrypted and previews it masked, never in plaintext', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer({ customer_type: 'individual', org_number: null }) })
    enqueue({ data: { id: 'op-pn-1' } })

    const result = (await tool().execute(
      { customer_id: CUSTOMER_ID, personal_number: PERSONAL_NUMBER },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: StagedInsert['preview_data'] }

    expect(result.staged).toBe(true)
    expect(result.preview.changes.personal_number_masked).toBe(MASKED)
    expect(result.preview.proposed.personal_number_masked).toBe(MASKED)
    expect(result.preview.changes).not.toHaveProperty('personal_number')
    expect(result.preview.changes).not.toHaveProperty('personal_number_encrypted')
    expect(JSON.stringify(result)).not.toContain(PERSONAL_NUMBER)

    const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
    expect(inserted.params.changes.personal_number_encrypted).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(inserted.params.changes.personal_number_encrypted as string)).toBe(PERSONAL_NUMBER)
    expect(inserted.params.changes).not.toHaveProperty('personal_number')
    expect(inserted.preview_data.changes.personal_number_masked).toBe(MASKED)
    expect(inserted.preview_data.changes).not.toHaveProperty('personal_number_encrypted')
    // Nothing persisted carries the plaintext: not params, not preview, not title.
    expect(JSON.stringify(inserted)).not.toContain(PERSONAL_NUMBER)
  })

  it.each([MASKED, '********-????'])(
    'treats the masked echo %s as "leave unchanged" and stages no personnummer change',
    async (maskedForm) => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueue({ data: currentCustomer({ customer_type: 'individual', org_number: null }) })
      enqueue({ data: { id: 'op-pn-2' } })

      const result = (await tool().execute(
        { customer_id: CUSTOMER_ID, personal_number: maskedForm, city: 'New City' },
        'company-1',
        'user-1',
        supabase as never,
      )) as { staged: boolean; preview: StagedInsert['preview_data'] }

      expect(result.staged).toBe(true)
      expect(result.preview.changes).toEqual({ city: 'New City' })

      const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
      expect(inserted.params.changes).toEqual({ city: 'New City' })
    },
  )

  it('rejects an update whose only field is the masked echo (a no-op)', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, personal_number: MASKED },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/at least one/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('stages an explicit null as a clear', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer({ customer_type: 'individual', org_number: null }) })
    enqueue({ data: { id: 'op-pn-3' } })

    const result = (await tool().execute(
      { customer_id: CUSTOMER_ID, personal_number: null },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: StagedInsert['preview_data'] }

    expect(result.staged).toBe(true)
    expect(result.preview.changes.personal_number_masked).toBeNull()
    expect(result.preview.proposed.personal_number_masked).toBeNull()

    const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
    expect(inserted.params.changes.personal_number_encrypted).toBeNull()
  })

  it('shows the stored personnummer masked in the current preview, never the ciphertext', async () => {
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: currentCustomer({ customer_type: 'individual', org_number: null, personal_number: stored }),
    })
    enqueue({ data: { id: 'op-pn-4' } })

    const result = (await tool().execute(
      { customer_id: CUSTOMER_ID, city: 'New City' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: StagedInsert['preview_data'] }

    expect(result.preview.current.personal_number_masked).toBe(MASKED)
    expect(result.preview.proposed.personal_number_masked).toBe(MASKED)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(PERSONAL_NUMBER)
    expect(serialized).not.toContain(stored)
  })

  it('refuses personal_number on a business customer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer() }) // swedish_business

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, personal_number: PERSONAL_NUMBER },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/individual/)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('refuses personal_number when the same update turns the customer into a business', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer({ customer_type: 'individual', org_number: null }) })

    await expect(
      tool().execute(
        {
          customer_id: CUSTOMER_ID,
          customer_type: 'swedish_business',
          personal_number: PERSONAL_NUMBER,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/individual/)
  })

  it('rejects a malformed personal_number before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, personal_number: 'not-a-personnummer' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/personnummer/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('dry_run returns the masked preview without staging', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer({ customer_type: 'individual', org_number: null }) })

    const result = (await tool().execute(
      { customer_id: CUSTOMER_ID, personal_number: PERSONAL_NUMBER, dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: StagedInsert['preview_data'] }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview.changes.personal_number_masked).toBe(MASKED)
    expect(JSON.stringify(result)).not.toContain(PERSONAL_NUMBER)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('replays an identical retry under the same idempotency_key despite the random-IV ciphertext', async () => {
    const args = {
      customer_id: CUSTOMER_ID,
      personal_number: PERSONAL_NUMBER,
      idempotency_key: '4d9e8b1a-2c3f-4a5b-8c7d-0e1f2a3b4c5d',
    }

    // First call: miss, stage, store.
    const first = createQueuedMockSupabase()
    first.enqueue({ data: currentCustomer({ customer_type: 'individual', org_number: null }) })
    first.enqueue({ data: null }) // idempotency_keys lookup: miss
    first.enqueue({ data: { id: 'op-pn-idem' } }) // pending_operations insert
    first.enqueue({ data: null }) // idempotency_keys store
    const firstResult = (await tool().execute(args, 'company-1', 'user-1', first.supabase as never)) as {
      operation_id?: string
      preview: StagedInsert['preview_data']
    }
    expect(firstResult.operation_id).toBe('op-pn-idem')
    const stored = first.findCall('idempotency_keys', 'insert')?.[0] as {
      request_hash: string
      response_body: Record<string, unknown>
    }
    // The hash is over the masked changes, which are stable across calls;
    // hashing params (random-IV ciphertext) would make every retry look like
    // a different payload and fail with IDEMPOTENCY_KEY_REUSE.
    expect(stored.request_hash).toBe(
      hashRequest({
        operationType: 'update_customer',
        params: { customer_id: CUSTOMER_ID, changes: firstResult.preview.changes },
        companyId: 'company-1',
      }),
    )
    expect(JSON.stringify(stored)).not.toContain(PERSONAL_NUMBER)

    // Second call: hit with the stored hash; nothing new is staged.
    const second = createQueuedMockSupabase()
    second.enqueue({ data: currentCustomer({ customer_type: 'individual', org_number: null }) })
    second.enqueue({
      data: {
        request_hash: stored.request_hash,
        response_status: 'success',
        response_body: stored.response_body,
        expires_at: '2999-01-01T00:00:00Z',
      },
    })
    const replay = (await tool().execute(args, 'company-1', 'user-1', second.supabase as never)) as {
      idempotency_replay?: boolean
      operation_id?: string
    }
    expect(replay.idempotency_replay).toBe(true)
    expect(replay.operation_id).toBe('op-pn-idem')
    expect(second.findCall('pending_operations', 'insert')).toBeUndefined()
  })
})
