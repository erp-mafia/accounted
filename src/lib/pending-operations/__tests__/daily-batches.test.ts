import { describe, expect, it } from 'vitest'
import { DAILY_BATCH_TYPES, DAILY_BATCH_TYPES_FILTER, dailyBatchTypeOf, pendingDailyBatchTypeOf } from '../daily-batches'

describe('daily batches', () => {
  it('knows the collections run and the reminders, and nothing else', () => {
    expect(DAILY_BATCH_TYPES).toEqual(['collections_daily_batch', 'reminder_daily_batch'])
    expect(dailyBatchTypeOf('collections_daily_batch')).toBe('collections_daily_batch')
    expect(dailyBatchTypeOf('reminder_daily_batch')).toBe('reminder_daily_batch')
    expect(dailyBatchTypeOf('send_invoice')).toBeNull()
    expect(DAILY_BATCH_TYPES_FILTER).toBe('(collections_daily_batch,reminder_daily_batch)')
  })

  it('opens the review dialog only while the batch waits for it', () => {
    expect(pendingDailyBatchTypeOf({ operation_type: 'reminder_daily_batch', status: 'pending' })).toBe('reminder_daily_batch')
    expect(pendingDailyBatchTypeOf({ operation_type: 'reminder_daily_batch', status: 'committed' })).toBeNull()
    expect(pendingDailyBatchTypeOf({ operation_type: 'create_invoice', status: 'pending' })).toBeNull()
  })
})
