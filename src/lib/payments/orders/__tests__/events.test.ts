import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { createTableMockSupabase } from '@/tests/helpers'
import { logPaymentOrderEvents } from '../types'

const EVENT = {
  company_id: 'company-1',
  payment_order_id: 'o1',
  batch_id: 'batch-1',
  event_type: 'status_changed' as const,
  detail: { provider_payment_id: 'pay-1' },
}

function setup(answers: Array<{ error: { message: string } | null }>) {
  const db = createTableMockSupabase({ payment_order_events: answers.map((a) => ({ data: null, error: a.error })) })
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
  return { db, log, writer: db.supabase as unknown as SupabaseClient }
}

describe('logPaymentOrderEvents', () => {
  it('tries a failed insert once more before giving up', async () => {
    const { db, log, writer } = setup([{ error: { message: 'connection reset' } }, { error: null }])

    expect(await logPaymentOrderEvents(writer, [EVENT], log)).toBe(true)
    expect(db.findCalls('payment_order_events', 'insert')).toHaveLength(2)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('puts events it could not write in the error log with their ids, never throwing', async () => {
    const { log, writer } = setup([{ error: { message: 'down' } }, { error: { message: 'down' } }])

    expect(await logPaymentOrderEvents(writer, [EVENT], log)).toBe(false)
    expect(log.error).toHaveBeenCalledWith('payment order events could not be recorded', undefined, {
      events: [{ companyId: 'company-1', orderId: 'o1', batchId: 'batch-1', type: 'status_changed', detail: { provider_payment_id: 'pay-1' } }],
    })
  })
})
