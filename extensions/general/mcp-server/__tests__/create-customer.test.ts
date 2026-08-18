import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
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
