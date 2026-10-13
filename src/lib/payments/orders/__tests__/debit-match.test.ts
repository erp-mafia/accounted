import { describe, expect, it } from 'vitest'
import type { Transaction } from '@/types'
import { debitInExecutionWindow, debitNamesPayee, findOrderForDebit, type OrderDebit } from '../debit-match'
import { ARCIM, arcimDebit, arcimOrder } from './fixtures'

function debitOf(row: Transaction): OrderDebit {
  return {
    amount: row.amount,
    currency: row.currency,
    date: row.date,
    value_date: row.value_date ?? null,
    cash_account_id: row.cash_account_id,
    description: row.description,
    reference: row.reference,
    counterparty_iban: row.counterparty_iban,
    counterparty_account: row.counterparty_account,
    end_to_end_id: row.end_to_end_id ?? null,
  }
}

/** Row 7af13560: Swedbank's debit of order 4e42c482, no end-to-end id, bankgiro zero-padded in the text. */
const SWEDBANK = debitOf(arcimDebit())
/** The same debit as a bank that writes nothing a matcher can read would report it. */
const BARE = { ...SWEDBANK, description: 'UTBETALNING', reference: null }

describe('findOrderForDebit', () => {
  it('matches the production Swedbank debit to its executed order: amount, account, date and the zero-padded bankgiro', () => {
    const match = findOrderForDebit(SWEDBANK, [arcimOrder()])

    expect(match).toMatchObject({ confidence: 0.98, basis: 'payee' })
    expect(match?.order.id).toBe(ARCIM.orderId)
  })

  it('matches by the end-to-end id whatever its case, before amount or date are even looked at', () => {
    const other = arcimOrder({
      id: 'other',
      supplier_invoice_id: 'inv-other',
      amount: 9.5,
      requested_execution_date: '2026-01-01',
      cash_account_id: 'acct-x',
      end_to_end_id: `ACC${'b'.repeat(32)}`,
    })
    const debit = { ...BARE, amount: -9.5, end_to_end_id: `ACC${'B'.repeat(32)}` }

    const match = findOrderForDebit(debit, [arcimOrder(), other])

    expect(match).toMatchObject({ confidence: 0.99, basis: 'end_to_end_id' })
    expect(match?.order.id).toBe('other')
  })

  it('settles a unique amount, account and date match without payee evidence at 0.95', () => {
    expect(findOrderForDebit(BARE, [arcimOrder()])).toMatchObject({ confidence: 0.95, basis: 'amount_account_date' })
  })

  it('lets a debit the feed could not bind to an account match', () => {
    expect(findOrderForDebit({ ...SWEDBANK, cash_account_id: null }, [arcimOrder()])).toMatchObject({ confidence: 0.98 })
  })

  it('never matches a debit from another account', () => {
    expect(findOrderForDebit({ ...SWEDBANK, cash_account_id: 'another-account' }, [arcimOrder()])).toBeNull()
  })

  it('never matches another amount, a credit or another currency', () => {
    expect(findOrderForDebit({ ...SWEDBANK, amount: -10.01 }, [arcimOrder()])).toBeNull()
    expect(findOrderForDebit({ ...SWEDBANK, amount: 10 }, [arcimOrder()])).toBeNull()
    expect(findOrderForDebit({ ...SWEDBANK, currency: 'EUR' }, [arcimOrder()])).toBeNull()
  })

  it('keeps to the execution window, the day before to three days after, by booking date or value date', () => {
    const orders = [arcimOrder()]
    expect(findOrderForDebit({ ...SWEDBANK, date: '2026-10-12', value_date: null }, orders)).not.toBeNull()
    expect(findOrderForDebit({ ...SWEDBANK, date: '2026-10-16', value_date: null }, orders)).not.toBeNull()
    expect(findOrderForDebit({ ...SWEDBANK, date: '2026-10-11', value_date: null }, orders)).toBeNull()
    expect(findOrderForDebit({ ...SWEDBANK, date: '2026-10-17', value_date: null }, orders)).toBeNull()
    // Booked after a weekend, value-dated on the execution day.
    expect(findOrderForDebit({ ...SWEDBANK, date: '2026-10-20', value_date: '2026-10-14' }, orders)).not.toBeNull()
  })

  it('refuses two orders of the same amount on the same day without payee evidence, and picks the one the text names', () => {
    const mattsson = arcimOrder()
    const derome = arcimOrder({
      id: 'order-derome',
      supplier_invoice_id: 'inv-derome',
      end_to_end_id: `ACC${'1'.repeat(32)}`,
      payee_bankgiro: '50501055',
      payee_name: 'Derome Bygg AB',
    })

    expect(findOrderForDebit(BARE, [mattsson, derome])).toBeNull()
    expect(findOrderForDebit(SWEDBANK, [mattsson, derome])?.order.id).toBe(ARCIM.orderId)
    expect(findOrderForDebit({ ...BARE, description: 'DEROME BYGG BG 5050-1055' }, [mattsson, derome])?.order.id).toBe('order-derome')
    expect(findOrderForDebit({ ...BARE, counterparty_account: '5050-1055' }, [mattsson, derome])?.order.id).toBe('order-derome')
  })

  it('ignores orders no debit may settle: unsigned, already matched, without an invoice or without a payment at the bank', () => {
    expect(findOrderForDebit(SWEDBANK, [arcimOrder({ status: 'approved' })])).toBeNull()
    expect(findOrderForDebit(SWEDBANK, [arcimOrder({ status: 'submitted' })])).toBeNull()
    expect(findOrderForDebit(SWEDBANK, [arcimOrder({ supplier_invoice_payment_id: 'sip-earlier' })])).toBeNull()
    expect(findOrderForDebit(SWEDBANK, [arcimOrder({ supplier_invoice_id: null })])).toBeNull()
    expect(findOrderForDebit(SWEDBANK, [arcimOrder({ provider_payment_id: null })])).toBeNull()
    expect(findOrderForDebit(SWEDBANK, [arcimOrder({ status: 'accepted' })])).toMatchObject({ confidence: 0.98 })
    expect(findOrderForDebit(SWEDBANK, [arcimOrder({ status: 'awaiting_second_signer' })])).toMatchObject({ confidence: 0.98 })
  })

  it('never settles by amount a debit that carries another of our end-to-end ids, but a bank id of its own does not stand in the way', () => {
    expect(findOrderForDebit({ ...SWEDBANK, end_to_end_id: `ACC${'f'.repeat(32)}` }, [arcimOrder()])).toBeNull()
    expect(findOrderForDebit({ ...SWEDBANK, end_to_end_id: 'NOTPROVIDED' }, [arcimOrder()])).toMatchObject({ confidence: 0.98 })
  })

  it('answers null for no candidates', () => {
    expect(findOrderForDebit(SWEDBANK, [])).toBeNull()
  })
})

describe('debitInExecutionWindow', () => {
  it('is inclusive at both ends', () => {
    const order = { requested_execution_date: '2026-10-13' }
    expect(debitInExecutionWindow({ ...BARE, date: '2026-10-12', value_date: null }, order)).toBe(true)
    expect(debitInExecutionWindow({ ...BARE, date: '2026-10-16', value_date: null }, order)).toBe(true)
    expect(debitInExecutionWindow({ ...BARE, date: '2026-10-17', value_date: null }, order)).toBe(false)
  })
})

describe('debitNamesPayee', () => {
  it('finds the bankgiro zero-padded, hyphenated, or as the counterparty account, never inside a longer number', () => {
    const order = arcimOrder()
    expect(debitNamesPayee({ ...BARE, description: 'MATTSSON BG 0000052386828' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, description: 'BG 5238-6828' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, reference: '52386828' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, counterparty_account: '5238-6828' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, description: 'REF 152386828' }, order)).toBe(false)
    expect(debitNamesPayee({ ...BARE, description: 'REF 523868281' }, order)).toBe(false)
  })

  it('finds the plusgiro the same way, and never a run of four digits or fewer', () => {
    const order = arcimOrder({ payee_bankgiro: null, payee_plusgiro: '12345-6', payee_name: 'Okänd' })
    expect(debitNamesPayee({ ...BARE, description: 'PG 123456' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, description: 'PG 1234' }, arcimOrder({ payee_bankgiro: null, payee_plusgiro: '1234', payee_name: 'Okänd' }))).toBe(false)
  })

  it('matches the payee IBAN against the counterparty IBAN, spaces and case aside', () => {
    const order = arcimOrder({ payee_bankgiro: null, payee_iban: 'SE4550000000058398257466', payee_name: 'Okänd' })
    expect(debitNamesPayee({ ...BARE, counterparty_iban: 'se45 5000 0000 0583 9825 7466' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, counterparty_iban: 'SE4550000000058398257467' }, order)).toBe(false)
  })

  it('finds the payee name by its significant words, legal forms and short words aside, half of them enough', () => {
    const order = arcimOrder({ payee_bankgiro: null })
    expect(debitNamesPayee({ ...BARE, description: 'MATTSSON SYSTEMS' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, description: 'Mattsson System AB' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, description: 'SYSTEMS AB' }, order)).toBe(true)
    expect(debitNamesPayee({ ...BARE, description: 'AB' }, order)).toBe(false)
    expect(debitNamesPayee({ ...BARE, description: 'VATTENFALL' }, order)).toBe(false)
    expect(debitNamesPayee({ ...BARE, description: 'ICA' }, arcimOrder({ payee_bankgiro: null, payee_name: 'ICA AB' }))).toBe(false)
    expect(debitNamesPayee({ ...BARE, description: 'AKERI SVENSSON' }, arcimOrder({ payee_bankgiro: null, payee_name: 'Åkeri Svensson AB' }))).toBe(true)
  })
})
