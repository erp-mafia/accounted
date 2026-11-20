import { describe, it, expect } from 'vitest'
import { formatVoucherGapRange } from '../voucher-gap-label'

describe('formatVoucherGapRange', () => {
  it('names a single missing number without a range', () => {
    expect(formatVoucherGapRange({ series: 'A', gap_start: 7, gap_end: 7 }, 'till')).toBe('A7')
  })

  it('joins a run with the translated joiner', () => {
    expect(formatVoucherGapRange({ series: 'A', gap_start: 1, gap_end: 5 }, 'till')).toBe('A1 till A5')
    expect(formatVoucherGapRange({ series: 'K', gap_start: 12, gap_end: 14 }, 'to')).toBe('K12 to K14')
  })

  it('never prints an inverted range', () => {
    expect(formatVoucherGapRange({ series: 'A', gap_start: 9, gap_end: 3 }, 'till')).toBe('A9')
  })
})
