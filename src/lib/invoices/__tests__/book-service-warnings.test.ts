/**
 * The deferred Bokför step answers its warnings in Swedish and English
 * (toOperationWarnings): a month of an upplupen intäkt that could not post
 * right after the booking (#62) carries the shared release warning's text.
 */
import { describe, expect, it } from 'vitest'
import { toOperationWarnings } from '@/lib/invoices/book-service'
import { ACCRUAL_RELEASE_FAILED_WARNING } from '@/lib/bookkeeping/accruals/from-invoices'

describe('toOperationWarnings', () => {
  it('gives the release warning its English twin', () => {
    expect(
      toOperationWarnings([{ code: ACCRUAL_RELEASE_FAILED_WARNING.code, message: ACCRUAL_RELEASE_FAILED_WARNING.message_sv }]),
    ).toEqual([
      {
        code: 'ACCRUAL_RELEASE_FAILED',
        message_sv: ACCRUAL_RELEASE_FAILED_WARNING.message_sv,
        message_en: ACCRUAL_RELEASE_FAILED_WARNING.message_en,
      },
    ])
  })

  it('keeps the existing twins and falls back to the Swedish text', () => {
    const [schedule, unknown] = toOperationWarnings([
      { code: 'ACCRUAL_SCHEDULE_FAILED', message: 'sv' },
      { code: 'SOMETHING_NEW', message: 'bara svenska' },
    ])
    expect(schedule.message_en).toMatch(/accrual schedules/)
    expect(unknown.message_en).toBe('bara svenska')
  })
})
