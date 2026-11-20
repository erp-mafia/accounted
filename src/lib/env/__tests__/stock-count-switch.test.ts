import { describe, expect, it } from 'vitest'
import { stockCountConfigured, stockCountEnabledFor, stockCountRollout } from '../stock-count-switch'

describe('stock count switch (BOLAGET_COMPANY_IDS)', () => {
  it('is off for everyone while unset', () => {
    expect(stockCountRollout({})).toEqual([])
    expect(stockCountConfigured({})).toBe(false)
    expect(stockCountEnabledFor('company-1', {})).toBe(false)
  })

  it('opens the listed companies, case-insensitively, or everyone with *', () => {
    const env = { BOLAGET_COMPANY_IDS: ' Company-1 , company-2,' }
    expect(stockCountEnabledFor('company-1', env)).toBe(true)
    expect(stockCountEnabledFor('company-3', env)).toBe(false)
    expect(stockCountConfigured(env)).toBe(true)
    expect(stockCountEnabledFor('anyone', { BOLAGET_COMPANY_IDS: '*' })).toBe(true)
    expect(stockCountEnabledFor(null, { BOLAGET_COMPANY_IDS: '*' })).toBe(false)
  })
})
