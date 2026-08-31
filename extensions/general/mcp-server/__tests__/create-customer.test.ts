import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { hashRequest } from '@/lib/api/idempotency'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { tools } from '../server'

const tool = () => tools.find((candidate) => candidate.name === 'gnubok_create_customer')!

describe('gnubok_create_customer: customer_number input', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('exposes customer_number in the strict input schema', () => {
    const properties = tool().inputSchema.properties as Record<string, Record<string, unknown>>
    expect(tool().inputSchema.additionalProperties).toBe(false)
    expect(properties.customer_number).toMatchObject({ type: 'string', maxLength: 32 })
  })

  it('stages the trimmed customer_number in params and preview', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings read (payment-terms default)
    enqueue({ data: { id: 'op-create-customer-1' } })

    const result = (await tool().execute(
      {
        name: 'Kund AB',
        customer_type: 'swedish_business',
        customer_number: ' K-1001 ',
        email: 'faktura@example.test',
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-create-customer-1')
    expect(result.preview).toMatchObject({
      customer_number: 'K-1001',
      email: 'faktura@example.test',
    })

    const inserted = findCall('pending_operations', 'insert')?.[0] as {
      params: Record<string, unknown>
    }
    expect(inserted.params).toMatchObject({ customer_number: 'K-1001' })
  })

  it('rejects a customer_number longer than 32 characters before staging', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { name: 'Kund AB', customer_type: 'swedish_business', customer_number: 'X'.repeat(33) },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/32/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a non-string customer_number before staging', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { name: 'Kund AB', customer_type: 'swedish_business', customer_number: 1001 },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/string/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('stages customer_number as null when omitted', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings read (payment-terms default)
    enqueue({ data: { id: 'op-create-customer-2' } })

    const result = (await tool().execute(
      { name: 'Kund AB', customer_type: 'swedish_business' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ customer_number: null })

    const inserted = findCall('pending_operations', 'insert')?.[0] as {
      params: Record<string, unknown>
    }
    expect(inserted.params).toMatchObject({ customer_number: null })
  })
})

// ── personal_number (privatperson) ────────────────────────────────────
//
// Synthetic personnummer, never a real one. Ciphertext shape enforced by
// customers_personal_number_check (20260726110000).
const PERSONAL_NUMBER = '19900101-1234'
const MASKED = '********-1234'
const CIPHERTEXT_SHAPE = /^[0-9a-f]{76,255}$/

type StagedInsert = {
  title: string
  params: Record<string, unknown>
  preview_data: Record<string, unknown>
}

describe('gnubok_create_customer: personal_number', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('exposes personal_number in the strict input schema', () => {
    const properties = tool().inputSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.personal_number).toMatchObject({ type: 'string' })
  })

  it('stages the personnummer encrypted and previews it masked, never in plaintext', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings read (payment-terms default)
    enqueue({ data: { id: 'op-pn-1' } }) // pending_operations insert

    const result = (await tool().execute(
      { name: 'Anna Andersson', customer_type: 'individual', personal_number: PERSONAL_NUMBER },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.personal_number_masked).toBe(MASKED)
    expect(result.preview).not.toHaveProperty('personal_number')
    expect(result.preview).not.toHaveProperty('personal_number_encrypted')
    expect(JSON.stringify(result)).not.toContain(PERSONAL_NUMBER)

    const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
    expect(inserted.params.personal_number_encrypted).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(inserted.params.personal_number_encrypted as string)).toBe(PERSONAL_NUMBER)
    expect(inserted.params).not.toHaveProperty('personal_number')
    expect(inserted.preview_data.personal_number_masked).toBe(MASKED)
    // Nothing persisted carries the plaintext: not params, not preview, not title.
    expect(JSON.stringify(inserted)).not.toContain(PERSONAL_NUMBER)
  })

  it('moves a personnummer-shaped org_number on an individual into personal_number', async () => {
    // What every agent had to do before this tool had a personal_number input.
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ data: { id: 'op-pn-2' } })

    const result = (await tool().execute(
      { name: 'Bertil Bengtsson', customer_type: 'individual', org_number: PERSONAL_NUMBER },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.preview.org_number).toBeNull()
    expect(result.preview.personal_number_masked).toBe(MASKED)

    const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
    expect(inserted.params.org_number).toBeNull()
    expect(decryptPersonnummer(inserted.params.personal_number_encrypted as string)).toBe(PERSONAL_NUMBER)
    expect(JSON.stringify(inserted)).not.toContain(PERSONAL_NUMBER)
  })

  it('refuses a personnummer-shaped org_number on a business customer before staging', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { name: 'Enskild Firma X', customer_type: 'swedish_business', org_number: PERSONAL_NUMBER },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/personnummer/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses personal_number on a business customer', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { name: 'Kund AB', customer_type: 'swedish_business', personal_number: PERSONAL_NUMBER },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/individual/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a malformed personal_number', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { name: 'Anna Andersson', customer_type: 'individual', personal_number: 'not-a-personnummer' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/personnummer/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses an org_number that is a different personnummer than personal_number', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        {
          name: 'Anna Andersson',
          customer_type: 'individual',
          org_number: '19850505-5555',
          personal_number: PERSONAL_NUMBER,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/differs/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('dry_run returns the masked preview without staging', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings read

    const result = (await tool().execute(
      { name: 'Anna Andersson', customer_type: 'individual', personal_number: PERSONAL_NUMBER, dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview.personal_number_masked).toBe(MASKED)
    expect(JSON.stringify(result)).not.toContain(PERSONAL_NUMBER)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('replays an identical retry under the same idempotency_key despite the random-IV ciphertext', async () => {
    const args = {
      name: 'Anna Andersson',
      customer_type: 'individual',
      personal_number: PERSONAL_NUMBER,
      idempotency_key: '0f2b6f5e-3f2a-4b9e-9c1d-6e9c2a1b7d55',
    }

    // First call: miss, stage, store.
    const first = createQueuedMockSupabase()
    first.enqueue({ data: null }) // company_settings read
    first.enqueue({ data: null }) // idempotency_keys lookup: miss
    first.enqueue({ data: { id: 'op-pn-idem' } }) // pending_operations insert
    first.enqueue({ data: null }) // idempotency_keys store
    const firstResult = (await tool().execute(args, 'company-1', 'user-1', first.supabase as never)) as {
      operation_id?: string
      preview: Record<string, unknown>
    }
    expect(firstResult.operation_id).toBe('op-pn-idem')
    const stored = first.findCall('idempotency_keys', 'insert')?.[0] as {
      request_hash: string
      response_body: Record<string, unknown>
    }
    // The hash is over the masked preview, which is stable across calls;
    // hashing params (random-IV ciphertext) would make every retry look like
    // a different payload and fail with IDEMPOTENCY_KEY_REUSE.
    expect(stored.request_hash).toBe(
      hashRequest({ operationType: 'create_customer', params: firstResult.preview, companyId: 'company-1' }),
    )
    expect(JSON.stringify(stored)).not.toContain(PERSONAL_NUMBER)

    // Second call: hit with the stored hash; nothing new is staged.
    const second = createQueuedMockSupabase()
    second.enqueue({ data: null }) // company_settings read
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

// ── payment terms ─────────────────────────────────────────────────────
//
// #1708: staging hardcoded `|| 30`, so the company's invoice_default_days
// never reached customers created through MCP even after the web/v1 fix.
describe('gnubok_create_customer: payment terms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('defaults to the company setting when payment_terms is omitted', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { invoice_default_days: 10 } }) // company_settings read
    enqueue({ data: { id: 'op-pt-1' } })

    const result = (await tool().execute(
      { name: 'Kund AB', customer_type: 'swedish_business' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.payment_terms).toBe(10)
    const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
    expect(inserted.params.payment_terms).toBe(10)
  })

  it('falls back to 30 when the company has no default', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings read: no row
    enqueue({ data: { id: 'op-pt-2' } })

    const result = (await tool().execute(
      { name: 'Kund AB', customer_type: 'swedish_business' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.payment_terms).toBe(30)
    const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
    expect(inserted.params.payment_terms).toBe(30)
  })

  it('keeps an explicit payment_terms without reading the company setting', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-pt-3' } }) // only the insert: no settings read

    const result = (await tool().execute(
      { name: 'Kund AB', customer_type: 'swedish_business', payment_terms: 14 },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.payment_terms).toBe(14)
    const inserted = findCall('pending_operations', 'insert')?.[0] as StagedInsert
    expect(inserted.params.payment_terms).toBe(14)
  })
})
