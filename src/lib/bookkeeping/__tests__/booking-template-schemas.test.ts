import { describe, expect, it } from 'vitest'
import { BookingTemplateLineSchema } from '../booking-template-schemas'

describe('BookingTemplateLineSchema ratio', () => {
  const line = { account: '7533', label: 'Särskild löneskatt', side: 'debit', type: 'business' } as const

  it('accepts a four-decimal share such as särskild löneskatt 0.2426 (crm#1657)', () => {
    const parsed = BookingTemplateLineSchema.safeParse({ ...line, ratio: 0.2426 })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.ratio).toBe(0.2426)
  })

  it('still refuses a share outside 0 to 10', () => {
    expect(BookingTemplateLineSchema.safeParse({ ...line, ratio: -0.1 }).success).toBe(false)
    expect(BookingTemplateLineSchema.safeParse({ ...line, ratio: 10.5 }).success).toBe(false)
  })
})
