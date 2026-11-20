import { describe, it, expect } from 'vitest'
import { makeJournalEntryLine } from '@/tests/helpers'
import { postedLineAsInput } from '../posted-line-input'

describe('postedLineAsInput', () => {
  it('copies the whole dimensions bag, custom dimensions included', () => {
    const line = makeJournalEntryLine({
      account_number: '6540',
      debit_amount: 1000,
      dimensions: { '1': 'KS01', '2': 'AVD3', '6': 'P001', '7': 'ANST9', '20': 'KUND42' },
      // The generated mirrors of keys 1 and 6, as a posted row carries them.
      cost_center: 'KS01',
      project: 'P001',
    })

    expect(postedLineAsInput(line).dimensions).toEqual({
      '1': 'KS01',
      '2': 'AVD3',
      '6': 'P001',
      '7': 'ANST9',
      '20': 'KUND42',
    })
  })

  it('folds a legacy row that only carries the cost_center/project columns into the bag', () => {
    const line = makeJournalEntryLine({ cost_center: 'KS01', project: 'P001' })

    expect(postedLineAsInput(line).dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('leaves an untagged line untagged', () => {
    expect(postedLineAsInput(makeJournalEntryLine({ dimensions: {} }))).not.toHaveProperty('dimensions')
  })

  it('copies amounts, currency facts, text and tax code, coercing numeric strings', () => {
    const line = makeJournalEntryLine({
      account_number: '1930',
      debit_amount: '0' as unknown as number,
      credit_amount: '1150.5' as unknown as number,
      currency: 'EUR',
      amount_in_currency: '100' as unknown as number,
      exchange_rate: '11.505' as unknown as number,
      line_description: 'Betalning',
      tax_code: 'X',
    })

    expect(postedLineAsInput(line)).toEqual({
      account_number: '1930',
      debit_amount: 0,
      credit_amount: 1150.5,
      currency: 'EUR',
      amount_in_currency: 100,
      exchange_rate: 11.505,
      line_description: 'Betalning',
      tax_code: 'X',
    })
  })
})
