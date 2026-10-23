import { describe, it, expect } from 'vitest'
import { negatesOriginal } from '../correction-shape'

// A bank fee: D 6570 / C 1930 (crm#1397).
const fee = [
  { account_number: '6570', debit_amount: 100, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 100 },
]

describe('negatesOriginal', () => {
  it('is true for the original with debit and credit swapped (what the storno already posts)', () => {
    expect(
      negatesOriginal(
        [
          { account_number: '6570', debit_amount: 0, credit_amount: 100 },
          { account_number: '1930', debit_amount: 100, credit_amount: 0 },
        ],
        fee,
      ),
    ).toBe(true)
  })

  it('is true however the swapped amounts are split over lines', () => {
    expect(
      negatesOriginal(
        [
          { account_number: '6570', debit_amount: 0, credit_amount: 60 },
          { account_number: '6570', debit_amount: 0, credit_amount: 40 },
          { account_number: '1930', debit_amount: 100, credit_amount: 0 },
        ],
        fee,
      ),
    ).toBe(true)
  })

  it('reads string amounts from posted lines and ignores öre noise', () => {
    expect(
      negatesOriginal(
        [
          { account_number: '6570', debit_amount: 0, credit_amount: 100.001 },
          { account_number: '1930', debit_amount: 100.001, credit_amount: 0 },
        ],
        [
          { account_number: '6570', debit_amount: '100.00', credit_amount: '0' },
          { account_number: '1930', debit_amount: '0', credit_amount: '100.00' },
        ],
      ),
    ).toBe(true)
  })

  it('is false for the original itself', () => {
    expect(negatesOriginal(fee, fee)).toBe(false)
  })

  it('is false for a real correction: another account', () => {
    expect(
      negatesOriginal(
        [
          { account_number: '6590', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
        fee,
      ),
    ).toBe(false)
  })

  it('is false for a real correction: another amount', () => {
    expect(
      negatesOriginal(
        [
          { account_number: '6570', debit_amount: 0, credit_amount: 50 },
          { account_number: '1930', debit_amount: 50, credit_amount: 0 },
        ],
        fee,
      ),
    ).toBe(false)
  })

  it('is false when the swapped lines also move a third account', () => {
    expect(
      negatesOriginal(
        [
          { account_number: '6570', debit_amount: 0, credit_amount: 100 },
          { account_number: '1930', debit_amount: 80, credit_amount: 0 },
          { account_number: '2640', debit_amount: 20, credit_amount: 0 },
        ],
        fee,
      ),
    ).toBe(false)
  })

  it('is false for an original that nets to zero on every account', () => {
    const netZero = [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
    ]
    expect(negatesOriginal(netZero, netZero)).toBe(false)
  })
})
