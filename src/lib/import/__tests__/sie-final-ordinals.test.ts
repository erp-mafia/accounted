import { describe, expect, it } from 'vitest'
import { SIE_LIMITS, sealedSIEFinalOrdinals, sieFinalOrdinals } from '../sie-job-contract'

/**
 * A job writes its IB and its migration adjustment after the file's vouchers
 * (source ordinals 0 to vouchers - 1). They sat at 50 000 and 50 001, just
 * past the old 50 000-voucher limit, so a larger file collided with them.
 */
describe('sieFinalOrdinals', () => {
  it('keeps 50 000 and 50 001 up to the old limit, so a job prepared across the deploy saves the same chunk', () => {
    expect(sieFinalOrdinals(1)).toEqual({ openingBalance: 50_000, adjustment: 50_001 })
    expect(sieFinalOrdinals(50_000)).toEqual({ openingBalance: 50_000, adjustment: 50_001 })
  })

  it('puts them past every voucher of a larger file, clear of the undo receipts at 150 000 to 179 999', () => {
    const ordinals = sieFinalOrdinals(50_001)
    expect(ordinals).toEqual({ openingBalance: 1_000_000, adjustment: 1_000_001 })
    expect(sieFinalOrdinals(SIE_LIMITS.fileVouchers)).toEqual(ordinals)
    // The last voucher of the largest file the job accepts sits below both.
    expect(SIE_LIMITS.fileVouchers - 1).toBeLessThan(ordinals.openingBalance)
    // An undo receipt is numbered by the lowest ordinal it reverses; the name
    // and VAT restore receipts take 150 000 to 179 999.
    expect(SIE_LIMITS.fileVouchers - 1).toBeLessThan(150_000)
    expect(ordinals.openingBalance).toBeGreaterThanOrEqual(180_000)
  })
})

describe('sealedSIEFinalOrdinals', () => {
  it('reads the pair the job sealed', () => {
    expect(sealedSIEFinalOrdinals({ finalOrdinals: { openingBalance: 1_000_000, adjustment: 1_000_001 } }))
      .toEqual({ openingBalance: 1_000_000, adjustment: 1_000_001 })
  })

  it('answers 50 000 and 50 001 for a job sealed before the manifest carried them', () => {
    expect(sealedSIEFinalOrdinals({})).toEqual({ openingBalance: 50_000, adjustment: 50_001 })
    expect(sealedSIEFinalOrdinals({ finalOrdinals: { adjustment: 'x' } })).toEqual({ openingBalance: 50_000, adjustment: 50_001 })
  })
})
