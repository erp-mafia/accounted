import { describe, expect, it } from 'vitest'
import { foreignAmountText, voucherLineView, voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'

// Intl's sv-SE grouping uses a no-break space; compare on plain spaces.
const plain = (s: string | null | undefined) => s?.replace(/\s/g, ' ') ?? s

describe('voucherLineView', () => {
  it('reads engine input (CreateJournalEntryLineInput) as is', () => {
    expect(
      voucherLineView({
        account_number: '6110',
        debit_amount: 1000,
        credit_amount: 0,
        line_description: 'Kontorsmaterial',
        dimensions: { '1': '10' },
        tax_code: 'MP1',
      }),
    ).toEqual({
      account_number: '6110',
      account_name: null,
      description: 'Kontorsmaterial',
      debit_amount: 1000,
      credit_amount: 0,
      foreignAmount: null,
      dimensions: { '1': '10' },
      tax_code: 'MP1',
    })
  })

  it('keys a posted row by its id and states its foreign amount', () => {
    const view = voucherLineView({
      id: 'line-1',
      account_number: '1930',
      debit_amount: '1094.50',
      credit_amount: '0',
      line_description: null,
      currency: 'EUR',
      amount_in_currency: 100,
    })
    expect(view.key).toBe('line-1')
    expect(view.debit_amount).toBe('1094.50')
    expect(plain(view.foreignAmount)).toBe('100,00 EUR')
  })

  it('reads a staged payload (account, debit, credit, description)', () => {
    expect(voucherLineView({ account: '2440', debit: 0, credit: 500, description: 'Leverantörsskuld' })).toMatchObject({
      account_number: '2440',
      description: 'Leverantörsskuld',
      debit_amount: 0,
      credit_amount: 500,
    })
  })

  it('turns side plus amount into the matching column', () => {
    expect(voucherLineView({ account: '1930', side: 'debet', amount: 250 })).toMatchObject({ debit_amount: 250, credit_amount: 0 })
    expect(voucherLineView({ account: '3001', side: 'kredit', amount: 250 })).toMatchObject({ debit_amount: 0, credit_amount: 250 })
    expect(voucherLineView({ account: '2820', side: 'K', amount: 99 })).toMatchObject({ debit_amount: 0, credit_amount: 99 })
  })

  it('prefers line_description over description and keeps a struck flag', () => {
    expect(
      voucherLineView({ account_number: '5410', debit_amount: 1, credit_amount: 0, line_description: 'A', description: 'B', struck: true }),
    ).toMatchObject({ description: 'A', struck: true })
  })

  it('shows a line without an account as "?" instead of an empty cell', () => {
    expect(voucherLineView({ debit_amount: 1, credit_amount: 0 }).account_number).toBe('?')
  })

  it('maps every line in order', () => {
    expect(voucherLineViews([{ account: '1', debit: 1 }, { account: '2', credit: 1 }]).map((l) => l.account_number)).toEqual(['1', '2'])
  })
})

describe('foreignAmountText', () => {
  it('is null for SEK, a missing currency or a missing amount', () => {
    expect(foreignAmountText('SEK', 100)).toBeNull()
    expect(foreignAmountText(null, 100)).toBeNull()
    expect(foreignAmountText('EUR', null)).toBeNull()
    expect(foreignAmountText('EUR', '')).toBeNull()
  })

  it('formats the original amount with its currency', () => {
    expect(plain(foreignAmountText('USD', '2500'))).toBe('2 500,00 USD')
  })
})
