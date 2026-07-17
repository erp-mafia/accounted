import { describe, expect, it } from 'vitest'
import { suggestVatPeriod } from '@/lib/workspace/date-tools'

describe('date-tools', () => {
  it('suggests monthly VAT period', () => {
    expect(suggestVatPeriod('2026-07-15')).toBe('2026-07')
  })

  it('suggests quarterly VAT period', () => {
    expect(suggestVatPeriod('2026-07-15', 3)).toBe('2026-Q3')
  })
})
