import { describe, it, expect } from 'vitest'
import { lineTextAddsSomething, voucherLinesTotals } from '../VoucherLinesTable'

describe('voucherLinesTotals', () => {
  it('sums every line that is not struck, to the öre, whatever the amount type', () => {
    // The verifikat list summed the raw lines and the approval card took the
    // staged totals; one rule now: the lines shown, minus rättelse-struck ones.
    expect(
      voucherLinesTotals([
        { account_number: '5410', debit_amount: '100.10', credit_amount: 0 },
        { account_number: '2641', debit_amount: 25.025, credit_amount: null },
        { account_number: '1930', debit_amount: 0, credit_amount: 125.13 },
        { account_number: '5410', debit_amount: 999, credit_amount: 0, struck: true },
      ]),
    ).toEqual({ debit: 125.13, credit: 125.13 })
  })
})

describe('lineTextAddsSomething', () => {
  it('hides a text that only repeats the account name or the verifikat text', () => {
    expect(lineTextAddsSomething('Företagskonto', 'Företagskonto')).toBe(false)
    expect(lineTextAddsSomething(' telia mars ', 'Telefon', ['Telia mars'])).toBe(false)
    expect(lineTextAddsSomething('', 'Telefon')).toBe(false)
  })

  it('shows a text that adds something', () => {
    expect(lineTextAddsSomething('Telia mars', 'Telefon', ['Mars'])).toBe(true)
    expect(lineTextAddsSomething('Telia mars', null)).toBe(true)
  })
})
