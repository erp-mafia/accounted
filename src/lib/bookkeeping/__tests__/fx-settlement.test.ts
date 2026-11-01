import { describe, expect, it } from 'vitest'
import { FX_FULL_SETTLEMENT_BAND, fxDeviationTooLarge, fxSettlementOutcome } from '../fx-settlement'

/** 1000 EUR left at 11.40 on the payment day: 11 400 kr is the remainder at the mid rate. */
const read = (sek: number, side: 'customer' | 'supplier', remaining = 1000) =>
  fxSettlementOutcome(sek, 11.4, remaining, side)

describe('fxSettlementOutcome', () => {
  it.each(['customer', 'supplier'] as const)('%s: inside the band the whole remainder settles', (side) => {
    expect(read(11400, side)).toEqual({ outcome: 'settles', paidInInvoiceCurrency: 1000 })
    expect(read(11180, side)).toEqual({ outcome: 'settles', paidInInvoiceCurrency: 1000 })
  })

  it.each(['customer', 'supplier'] as const)('%s: exactly on the band still settles, just past it does not', (side) => {
    expect(read(11400 * (1 - FX_FULL_SETTLEMENT_BAND), side).outcome).toBe('settles')
    expect(read(11171, side).outcome).toBe('partial')
  })

  it.each(['customer', 'supplier'] as const)('%s: short of the band is a part payment of what the kronor buy', (side) => {
    expect(read(5700, side)).toEqual({ outcome: 'partial', paidInInvoiceCurrency: 500 })
    expect(read(10830, side)).toEqual({ outcome: 'partial', paidInInvoiceCurrency: 950 })
  })

  it('a customer who paid past the band is refused: the excess is theirs, not a kursvinst', () => {
    expect(read(12312, 'customer')).toEqual({ outcome: 'refused', paidInInvoiceCurrency: 1080 })
  })

  it('a supplier payment over the mid rate is a card rate, and settles up to the limit', () => {
    expect(read(12312, 'supplier')).toEqual({ outcome: 'settles', paidInInvoiceCurrency: 1000 })
    expect(read(12540, 'supplier').outcome).toBe('settles')
    expect(read(12541, 'supplier').outcome).toBe('refused')
  })

  it.each(['customer', 'supplier'] as const)('%s: nothing left to settle is refused', (side) => {
    expect(read(100, side, 0).outcome).toBe('refused')
  })

  it('reads a SEK invoice paid from a foreign account at rate 1', () => {
    expect(fxSettlementOutcome(1000, 1, 1000, 'supplier')).toEqual({ outcome: 'settles', paidInInvoiceCurrency: 1000 })
    expect(fxSettlementOutcome(500, 1, 1000, 'supplier')).toEqual({ outcome: 'partial', paidInInvoiceCurrency: 500 })
  })

  it('keeps four decimals of a part payment', () => {
    expect(fxSettlementOutcome(1000, 11.123, 500, 'supplier').paidInInvoiceCurrency).toBe(89.9038)
  })
})

describe('fxDeviationTooLarge', () => {
  it('is false up to and on the limit, true past it', () => {
    expect(fxDeviationTooLarge(1100, 1000)).toBe(false)
    expect(fxDeviationTooLarge(900, 1000)).toBe(false)
    expect(fxDeviationTooLarge(1100.01, 1000)).toBe(true)
    expect(fxDeviationTooLarge(899.99, 1000)).toBe(true)
  })

  it('counts in whole öre, so a limit with no binary form lands where numeric puts it', () => {
    expect(fxDeviationTooLarge(2161.94, 1965.4)).toBe(false)
    expect(fxDeviationTooLarge(2161.95, 1965.4)).toBe(true)
  })

  it('reads a negative booked figure by its size', () => {
    expect(fxDeviationTooLarge(-950, -1000)).toBe(false)
    expect(fxDeviationTooLarge(-800, -1000)).toBe(true)
  })
})
