/**
 * Company cards on the bank leg (bank-leg.ts, counterparty-templates.ts):
 *   - settleBankLeg / templateBankLeg move a card ledger on the bank side
 *     when the caller names the company's card ledgers (moneyLedgers);
 *   - a card row's booking is learned with the 1930 placeholder, so it
 *     replays on a bank row as K 1930 and never as K 2890;
 *   - the card's payment (D 2890 / K 1930) is a transfer and stays as booked.
 */
import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { learnableBankPair, settleBankLeg, templateBankLeg } from '../bank-leg'
import {
  bindTemplateToSettlementAccount,
  samePairButBankLedger,
  upsertCounterpartyTemplate,
} from '../counterparty-templates'
import type { CategorizationTemplate } from '@/types'

const pair = (debit_account: string, credit_account: string) => ({ debit_account, credit_account })

describe('settleBankLeg with the company card ledgers', () => {
  it('moves a card-learned K 2890 to the bank row\'s own ledger', () => {
    expect(settleBankLeg(pair('6540', '2890'), 'credit', '1930', ['2890'])).toEqual(pair('6540', '1930'))
    expect(settleBankLeg(pair('6540', '2890'), 'credit', '1940', ['2890'])).toEqual(pair('6540', '1940'))
  })

  it('leaves 2890 alone when it is no card of the company', () => {
    expect(settleBankLeg(pair('6540', '2890'), 'credit', '1930')).toEqual(pair('6540', '2890'))
  })

  it('moves the 1930 placeholder onto the card ledger on a card row', () => {
    expect(settleBankLeg(pair('6540', '1930'), 'credit', '2890', ['2890'])).toEqual(pair('6540', '2890'))
    // A refund on the card: money in, debit side.
    expect(settleBankLeg(pair('1930', '6540'), 'debit', '2899', ['2899'])).toEqual(pair('2899', '6540'))
  })

  it('leaves the card payment D 2890 / K 1930 as is on the card inflow and on the bank outflow', () => {
    // Card inflow (+12 345 on 2890): the bank side is the debit, already the card.
    expect(settleBankLeg(pair('2890', '1930'), 'debit', '2890', ['2890'])).toEqual(pair('2890', '1930'))
    // Bank outflow (-12 345 on 1930): the bank side is the credit, already 1930.
    expect(settleBankLeg(pair('2890', '1930'), 'credit', '1930', ['2890'])).toEqual(pair('2890', '1930'))
    // The same payment from a bank on 1940: only the bank leg moves.
    expect(settleBankLeg(pair('2890', '1930'), 'credit', '1940', ['2890'])).toEqual(pair('2890', '1940'))
  })
})

describe('templateBankLeg with the company card ledgers', () => {
  const mall = [
    { account: '6540', side: 'debit' as const },
    { account: '2641', side: 'debit' as const },
    { account: '2890', side: 'credit' as const },
  ]

  it('moves a mall\'s card line onto the bank row\'s ledger', () => {
    expect(templateBankLeg(mall, 'credit', '1930', ['2890'])).toEqual({ index: 2, moves: true })
  })

  it('books the mall as saved on the card row itself', () => {
    expect(templateBankLeg(mall, 'credit', '2890', ['2890'])).toEqual({ index: 2, moves: false })
  })

  it('without the card ledgers a 2890 line is no bank line', () => {
    expect(templateBankLeg(mall, 'credit', '1930')).toBeNull()
  })
})

describe('learnableBankPair', () => {
  it('learns a card purchase with the bank placeholder', () => {
    expect(learnableBankPair(pair('6540', '2890'), -349)).toEqual(pair('6540', '1930'))
    expect(learnableBankPair(pair('6570', '2899'), -95)).toEqual(pair('6570', '1930'))
    expect(learnableBankPair(pair('8410', '2480'), -12)).toEqual(pair('8410', '1930'))
  })

  it('learns a card refund with the bank placeholder on the debit side', () => {
    expect(learnableBankPair(pair('2890', '6540'), 349)).toEqual(pair('1930', '6540'))
  })

  it('learns the card payment (a transfer) as booked', () => {
    const payment = pair('2890', '1930')
    expect(learnableBankPair(payment, 12345)).toBe(payment)
    expect(learnableBankPair(payment, -12345)).toBe(payment)
  })

  it('leaves bank bookings and other liabilities alone', () => {
    const bank = pair('6540', '1930')
    expect(learnableBankPair(bank, -349)).toBe(bank)
    const payable = pair('2440', '1930')
    expect(learnableBankPair(payable, -500)).toBe(payable)
    // 2893 is never a card: a bank-side 2893 is not rewritten.
    const related = pair('6540', '2893')
    expect(learnableBankPair(related, -100)).toBe(related)
  })
})

describe('samePairButBankLedger with a card ledger', () => {
  it('reads a stored K 2890 and the learned K 1930 as one habit when 2890 is the card', () => {
    expect(samePairButBankLedger(pair('6540', '2890'), '6540', '1930', ['2890'])).toBe(true)
    expect(samePairButBankLedger(pair('6540', '2899'), '6540', '1930', ['2899'])).toBe(true)
  })

  it('keeps reading another cost account as a correction', () => {
    expect(samePairButBankLedger(pair('6540', '2890'), '6550', '1930', ['2890'])).toBe(false)
  })

  it('without the card ledgers a 2899 pair is a correction', () => {
    expect(samePairButBankLedger(pair('6540', '2899'), '6540', '1930')).toBe(false)
  })
})

describe('bindTemplateToSettlementAccount with a card ledger', () => {
  const template = (debit_account: string, credit_account: string) =>
    ({ id: 't-1', debit_account, credit_account, line_pattern: null }) as unknown as CategorizationTemplate

  it('replays a card-learned template on a bank row as K 1930', () => {
    const bound = bindTemplateToSettlementAccount(template('6540', '2890'), -349, '1930', ['2890'])
    expect([bound.debit_account, bound.credit_account]).toEqual(['6540', '1930'])
  })

  it('leaves the payment template on a 2899 card\'s inflow as booked', () => {
    const bound = bindTemplateToSettlementAccount(template('2899', '1930'), 12345, '2899', ['2899'])
    expect([bound.debit_account, bound.credit_account]).toEqual(['2899', '1930'])
  })
})

describe('upsertCounterpartyTemplate on a card row', () => {
  function capturingSupabase() {
    const inserted: Record<string, unknown>[] = []
    const chain = {
      select: () => chain,
      eq: () => chain,
      contains: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async (payload: Record<string, unknown>) => {
        inserted.push(payload)
        return { error: null }
      },
    }
    return { supabase: { from: () => chain } as never, inserted }
  }
  const booked = (debit_account: string, credit_account: string) => ({
    rule: null,
    debit_account,
    credit_account,
    risk_level: 'NONE' as const,
    confidence: 0.9,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Kortköp',
  })

  it('stores the bank placeholder, never the card ledger', async () => {
    const { supabase, inserted } = capturingSupabase()
    const tx = makeTransaction({ merchant_name: 'Molnkontoret AB', amount: -349, cash_account_id: 'card-1' })
    await upsertCounterpartyTemplate(supabase, 'company-1', tx, booked('6540', '2890'), 'user_approved')
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ debit_account: '6540', credit_account: '1930' })
  })

  it('stores the card payment as booked', async () => {
    const { supabase, inserted } = capturingSupabase()
    const tx = makeTransaction({ merchant_name: 'Eurocard', amount: 12345, cash_account_id: 'card-1' })
    await upsertCounterpartyTemplate(supabase, 'company-1', tx, booked('2890', '1930'), 'user_approved')
    expect(inserted[0]).toMatchObject({ debit_account: '2890', credit_account: '1930' })
  })
})
