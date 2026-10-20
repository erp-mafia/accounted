/**
 * The room a verifikat's bank leg has left for one more bank row (GitHub
 * #3507): the rule every linking door measures with.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  BANK_LEG_ROOM_TOLERANCE,
  bankLegConsumedMessage,
  bankLegRoom,
  fitsBankLeg,
  holdersOnAccount,
  readBankLegHolders,
  type BankLegHolder,
} from '../voucher-bank-leg'

const sek = (debit: number, credit: number) => ({ debit_amount: debit, credit_amount: credit })
const holder = (amount: number, over: Partial<BankLegHolder> = {}): BankLegHolder => ({
  transactionId: `tx-${amount}`,
  amount,
  currency: 'SEK',
  cashAccountId: 'ca-1930',
  ...over,
})

describe('bankLegRoom', () => {
  it('splits what the verifikat books and what the holders take by direction', () => {
    const room = bankLegRoom([sek(3000, 0), sek(0, 200)], [holder(2800), holder(-200)], 'SEK')
    expect(room).toEqual({ bookedIn: 3000, bookedOut: -200, heldIn: 2800, heldOut: -200, measurable: true })
  })

  it('measures a foreign account in amount_in_currency, never the SEK column', () => {
    const room = bankLegRoom([{ ...sek(11500, 0), currency: 'EUR', amount_in_currency: 1000 }], [], 'EUR')
    expect(room).toMatchObject({ bookedIn: 1000, measurable: true })
  })

  it('is not measurable when a line has no amount in the currency', () => {
    expect(bankLegRoom([sek(11500, 0)], [], 'EUR').measurable).toBe(false)
  })
})

describe('fitsBankLeg', () => {
  const sale = bankLegRoom([sek(2800, 0)], [], 'SEK')

  it('refuses a second 2 800 on a 2 800 verifikat a first row holds (the reported shape)', () => {
    const taken = bankLegRoom([sek(2800, 0)], [holder(2800)], 'SEK')
    expect(fitsBankLeg(taken, 2800)).toEqual({ fits: false, booked: 2800, held: 2800, remaining: 0 })
  })

  it('takes instalments until the leg is used up', () => {
    const payout = [sek(0, 2800)]
    expect(fitsBankLeg(bankLegRoom(payout, [], 'SEK'), -1400).fits).toBe(true)
    expect(fitsBankLeg(bankLegRoom(payout, [holder(-1400)], 'SEK'), -1400).fits).toBe(true)
    expect(fitsBankLeg(bankLegRoom(payout, [holder(-1400), holder(-1400)], 'SEK'), -1400)).toMatchObject({
      fits: false,
      remaining: 0,
    })
  })

  it('lets the first row in a direction through whatever its size (an öresavrundning stays on the status card)', () => {
    expect(fitsBankLeg(sale, 2800.42)).toEqual({ fits: true })
    expect(fitsBankLeg(sale, 3000)).toEqual({ fits: true })
  })

  it('keeps the one-öre fuzzy band and nothing more once another row holds the leg', () => {
    const half = bankLegRoom([sek(2800, 0)], [holder(1400)], 'SEK')
    expect(fitsBankLeg(half, 1400.01).fits).toBe(true)
    expect(fitsBankLeg(half, 1400.02)).toMatchObject({ fits: false, held: 1400, remaining: 1400 })
    expect(BANK_LEG_ROOM_TOLERANCE).toBeLessThan(0.02)
  })

  it('leaves a verifikat that books nothing in the row direction to the bank-anchor guard', () => {
    expect(fitsBankLeg(sale, -500)).toEqual({ fits: true })
  })

  it('never lets a deposit take the room of a payout', () => {
    const both = bankLegRoom([sek(2800, 0), sek(0, 500)], [holder(2800)], 'SEK')
    expect(fitsBankLeg(both, 100).fits).toBe(false)
    expect(fitsBankLeg(both, -500).fits).toBe(true)
  })

  it('widens the room by an overrun in the row direction only', () => {
    const lines = bankLegRoom([sek(1000, 0)], [holder(500)], 'SEK')
    expect(fitsBankLeg(lines, 505).fits).toBe(false)
    expect(fitsBankLeg(lines, 505, 5).fits).toBe(true)
    expect(fitsBankLeg(lines, 505, -5).fits).toBe(false)
  })

  it('takes the first row of an unmeasurable verifikat and refuses the next one in the same direction', () => {
    expect(fitsBankLeg(bankLegRoom([sek(11500, 0)], [], 'EUR'), 1000).fits).toBe(true)
    expect(fitsBankLeg(bankLegRoom([sek(11500, 0)], [holder(1000, { currency: 'EUR' })], 'EUR'), 1000)).toEqual({
      fits: false,
      booked: null,
      held: 1000,
      remaining: null,
    })
  })

  it('lets a zero row through', () => {
    expect(fitsBankLeg(bankLegRoom([sek(2800, 0)], [holder(2800)], 'SEK'), 0).fits).toBe(true)
  })
})

describe('holdersOnAccount', () => {
  const holders = [
    holder(100, { cashAccountId: 'ca-1930' }),
    holder(200, { cashAccountId: 'ca-1940' }),
    holder(300, { cashAccountId: null }),
    holder(400, { currency: 'EUR' }),
  ]

  it('keeps the same cash account and unbound legacy holders, in the same currency', () => {
    expect(holdersOnAccount(holders, { cashAccountId: 'ca-1930', currency: 'SEK' }).map((h) => h.amount)).toEqual([100, 300])
  })

  it('keeps only unbound holders for an unbound row', () => {
    expect(holdersOnAccount(holders, { cashAccountId: null, currency: 'SEK' }).map((h) => h.amount)).toEqual([300])
  })
})

describe('readBankLegHolders', () => {
  it('reads bank_line slices and pointers, counts a row anchored both ways once, and leaves the excluded rows out', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { transaction_id: 'tx-a', journal_entry_id: 'je-1', allocated_amount: '1400.00', transactions: { amount: 1400, currency: 'SEK', cash_account_id: 'ca-1' } },
        // The same row also points at je-1: its whole amount counts, once.
        { transaction_id: 'tx-b', journal_entry_id: 'je-1', allocated_amount: 500, transactions: [{ amount: 900, currency: 'SEK', cash_account_id: 'ca-1' }] },
        { transaction_id: 'tx-self', journal_entry_id: 'je-1', allocated_amount: 50, transactions: { amount: 50, currency: 'SEK', cash_account_id: 'ca-1' } },
      ],
    })
    enqueue({
      data: [
        { id: 'tx-b', journal_entry_id: 'je-1', amount: 900, currency: 'SEK', cash_account_id: 'ca-1' },
        { id: 'tx-c', journal_entry_id: 'je-2', amount: -300, currency: null, cash_account_id: null },
        { id: 'tx-self', journal_entry_id: 'je-2', amount: 50, currency: 'SEK', cash_account_id: null },
      ],
    })

    const read = await readBankLegHolders(supabase as never, 'company-1', ['je-1', 'je-2'], ['tx-self'])

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.holders.get('je-1')).toEqual([
      { transactionId: 'tx-b', amount: 900, currency: 'SEK', cashAccountId: 'ca-1' },
      { transactionId: 'tx-a', amount: 1400, currency: 'SEK', cashAccountId: 'ca-1' },
    ])
    expect(read.holders.get('je-2')).toEqual([{ transactionId: 'tx-c', amount: -300, currency: 'SEK', cashAccountId: null }])
    expect(findCalls('transaction_voucher_links', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['role', 'bank_line'],
    ])
    expect(findCalls('transactions', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it.each([
    ['the slices', [{ data: null, error: { message: 'timeout' } }]],
    ['the pointers', [{ data: [] }, { data: null, error: { message: 'timeout' } }]],
  ])('answers ok: false when %s cannot be read', async (_name, results) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    for (const r of results) enqueue(r)
    expect(await readBankLegHolders(supabase as never, 'company-1', ['je-1'])).toEqual({ ok: false })
  })
})

describe('bankLegConsumedMessage', () => {
  it('names the verifikat, what it books, what is held and what to do, in Swedish', () => {
    const message = bankLegConsumedMessage({
      voucherLabel: 'A-17',
      accountNumber: '1930',
      amount: 2800,
      verdict: { fits: false, booked: 2800, held: 2800, remaining: 0 },
    })
    expect(message).toBe(
      'Verifikat A-17 bokför 2800 på 1930, och 2800 av det är redan kopplat till andra transaktioner (kvar: 0). Transaktionen på 2800 ryms inte i verifikatet. Är den en egen affärshändelse, bokför den som ett eget verifikat. Är den andra kopplingen fel, koppla bort den transaktionen först.',
    )
  })
})
