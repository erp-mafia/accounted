/**
 * The company's own earlier booking of a counterparty as a proposal
 * (../booking-precedent.ts): which rows look for one, the one read that
 * fetches them, what an earlier booking says, and the proposal built from
 * them.
 */
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase, makeTransaction } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PRECEDENT_BOOKINGS_READ,
  PRECEDENT_WINDOW_DAYS,
  bookedAs,
  loadBookingPrecedents,
  precedentProposal,
  precedentText,
  type PrecedentBooking,
  type PrecedentLine,
} from '../booking-precedent'
import { DIRECT_BOOKING_ON, reviewReason } from '../direct-booking'
import { categorizeBodyFor, whyKeyFor, whyTextSv } from '@/lib/bookkeeping/proposal'
import { offeredSuggestions } from '@/lib/suggestion-log/classify'

const COMPANY = 'company-1'

const line = (account: string, debit: number, credit: number): PrecedentLine => ({ account, debit, credit })

let seq = 0
function booking(lines: PrecedentLine[], over: Partial<PrecedentBooking> = {}): PrecedentBooking {
  seq += 1
  return {
    transaction_id: `earlier-${seq}`,
    date: '2026-06-01',
    amount: -500,
    journal_entry_id: `entry-${seq}`,
    settlement_ledger: null,
    lines,
    ...over,
  }
}

const purchase25 = (account = '5420') => [line(account, 400, 0), line('2641', 100, 0), line('1930', 0, 500)]
const noMoms = (account = '6570') => [line(account, 500, 0), line('1930', 0, 500)]

const row = makeTransaction({ id: 'tx-open', amount: -500, merchant_name: 'Nordverk AB', description: 'Nordverk AB', original_description: 'Nordverk AB' })

describe('precedentText', () => {
  it('reads the merchant name, else the original description, else the description', () => {
    expect(precedentText(makeTransaction({ merchant_name: 'Nordverk AB', original_description: 'X', description: 'Y' }))).toBe('Nordverk AB')
    expect(precedentText(makeTransaction({ merchant_name: null, original_description: 'Sydkraft', description: 'Y' }))).toBe('Sydkraft')
    expect(precedentText(makeTransaction({ merchant_name: null, original_description: null, description: 'Vattenverket' }))).toBe('Vattenverket')
  })

  it('has none for a text that names no one, a key under two characters, or a payment to Skatteverket', () => {
    expect(precedentText(makeTransaction({ merchant_name: null, original_description: 'INTERNET BET 4', description: 'INTERNET BET 4' }))).toBeNull()
    expect(precedentText(makeTransaction({ merchant_name: 'A', original_description: 'A', description: 'A' }))).toBeNull()
    expect(precedentText(makeTransaction({ amount: -1000, merchant_name: 'Skatteverket', original_description: 'Skatteverket', description: 'Skatteverket' }))).toBeNull()
  })
})

describe('loadBookingPrecedents', () => {
  const other = makeTransaction({ id: 'tx-other', amount: -90, merchant_name: 'Nordverk AB', description: 'Nordverk AB', original_description: 'Nordverk AB' })
  const second = makeTransaction({ id: 'tx-second', amount: -90, merchant_name: 'Sydkraft', description: 'Sydkraft', original_description: 'Sydkraft' })
  const nameless = makeTransaction({ id: 'tx-nameless', merchant_name: null, description: 'Överföring', original_description: 'Överföring' })

  it('asks once for all rows, with each text once, the company and the window', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      'rpc:booking_precedents': { data: { names: {}, bookings: {} }, error: null },
    })
    await loadBookingPrecedents(supabase as unknown as SupabaseClient, COMPANY, [row, other, second, nameless], '2026-11-23')

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(findCalls('rpc:booking_precedents', 'rpc')).toEqual([
      [
        {
          p_company_id: COMPANY,
          p_names: ['Nordverk AB', 'Sydkraft'],
          p_from_date: '2025-11-23',
          p_per_counterparty: PRECEDENT_BOOKINGS_READ,
        },
      ],
    ])
    expect(PRECEDENT_WINDOW_DAYS).toBe(365)
  })

  it('asks nothing when no row has a text to look for', async () => {
    const { supabase } = createTableMockSupabase()
    const out = await loadBookingPrecedents(supabase as unknown as SupabaseClient, COMPANY, [nameless])
    expect(out.size).toBe(0)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('hands each row the bookings of its key, never the row itself', async () => {
    const own = booking(noMoms(), { transaction_id: 'tx-open' })
    const earlier = booking(noMoms())
    const { supabase } = createTableMockSupabase({
      'rpc:booking_precedents': {
        data: { names: { 'Nordverk AB': 'nordverk', Sydkraft: 'sydkraft' }, bookings: { nordverk: [own, earlier] } },
        error: null,
      },
    })
    const out = await loadBookingPrecedents(supabase as unknown as SupabaseClient, COMPANY, [row, other, second])

    expect(out.get('tx-open')).toEqual([earlier])
    // Another open row of the same counterparty may take the booked one as its precedent.
    expect(out.get('tx-other')).toEqual([own, earlier])
    expect(out.has('tx-second')).toBe(false)
  })

  it('a row whose only booking in the window is itself has none', async () => {
    const { supabase } = createTableMockSupabase({
      'rpc:booking_precedents': {
        data: { names: { 'Nordverk AB': 'nordverk' }, bookings: { nordverk: [booking(noMoms(), { transaction_id: 'tx-open' })] } },
        error: null,
      },
    })
    const out = await loadBookingPrecedents(supabase as unknown as SupabaseClient, COMPANY, [row])
    expect(out.has('tx-open')).toBe(false)
  })

  it('fails loud on a failed read: the caller decides what the list does without it', async () => {
    const { supabase } = createTableMockSupabase({ 'rpc:booking_precedents': { data: null, error: { message: 'timeout' } } })
    await expect(loadBookingPrecedents(supabase as unknown as SupabaseClient, COMPANY, [row])).rejects.toThrow(
      'booking precedents read failed: timeout',
    )
  })
})

describe('bookedAs', () => {
  it('reads the one business account, and no moms from a verifikat without a moms line', () => {
    expect(bookedAs(booking(noMoms('6570')))).toEqual({ account: '6570', vat_treatment: 'exempt', nature: null })
    // A payment of a debt books a balance account, like any other single account.
    expect(bookedAs(booking(noMoms('2440')))).toEqual({ account: '2440', vat_treatment: 'exempt', nature: null })
  })

  it('reads the rate of ingående moms off the amounts', () => {
    expect(bookedAs(booking(purchase25()))).toEqual({ account: '5420', vat_treatment: 'standard_25', nature: 'expense' })
    expect(bookedAs(booking([line('5800', 446.43, 0), line('2641', 53.57, 0), line('1930', 0, 500)]))).toEqual({
      account: '5800',
      vat_treatment: 'reduced_12',
      nature: 'expense',
    })
  })

  it('reads the rate of utgående moms off its account', () => {
    expect(bookedAs(booking([line('1930', 500, 0), line('3001', 0, 400), line('2611', 0, 100)], { amount: 500 }))).toEqual({
      account: '3001',
      vat_treatment: 'standard_25',
      nature: 'income',
    })
  })

  it('reads reverse charge from the fiktiv moms pair beside a single cost account', () => {
    expect(
      bookedAs(booking([line('5420', 500, 0), line('2645', 125, 0), line('2614', 0, 125), line('1930', 0, 500)])),
    ).toEqual({ account: '5420', vat_treatment: 'reverse_charge', nature: 'expense' })
  })

  it("leaves the row's own settlement ledger out, a card's as a bank ledger's", () => {
    expect(bookedAs(booking([line('5420', 400, 0), line('2641', 100, 0), line('2899', 0, 500)], { settlement_ledger: '2899' }))).toEqual({
      account: '5420',
      vat_treatment: 'standard_25',
      nature: 'expense',
    })
    // Without it the card's ledger is a second account.
    expect(bookedAs(booking([line('5420', 400, 0), line('2641', 100, 0), line('2899', 0, 500)]))).toBeNull()
  })

  it('passes over a verifikat with several business accounts, or none', () => {
    expect(bookedAs(booking([line('5420', 300, 0), line('6110', 200, 0), line('1930', 0, 500)]))).toBeNull()
    // A reverse-charge purchase booked with its basis pair carries three.
    expect(
      bookedAs(
        booking([
          line('5420', 500, 0),
          line('2645', 125, 0),
          line('2614', 0, 125),
          line('4535', 500, 0),
          line('4598', 0, 500),
          line('1930', 0, 500),
        ]),
      ),
    ).toBeNull()
    // A transfer between two bank ledgers carries none.
    expect(bookedAs(booking([line('1940', 500, 0), line('1930', 0, 500)]))).toBeNull()
  })

  it('passes over moms it cannot state as one treatment', () => {
    // Ingående moms at no legal rate of the amount (about 10 %).
    expect(bookedAs(booking([line('6071', 455, 0), line('2641', 45, 0), line('1930', 0, 500)]))).toBeNull()
    // A moms account outside the booked rates.
    expect(bookedAs(booking([line('5420', 400, 0), line('2650', 100, 0), line('1930', 0, 500)]))).toBeNull()
    // Import moms beside a cost account: a replay would book another ruta.
    expect(bookedAs(booking([line('4010', 500, 0), line('2645', 125, 0), line('2615', 0, 125), line('1930', 0, 500)]))).toBeNull()
  })
})

describe('precedentProposal', () => {
  it('proposes the most recent booking as one account against the bank, with its moms and the count that agree', () => {
    const p = precedentProposal(row, [booking(purchase25()), booking(purchase25()), booking(noMoms('6110'))], 'aktiebolag')!

    expect(p).toMatchObject({
      template_id: 'precedent:5420',
      source: 'precedent',
      booking: { kind: 'account', account: '5420', vat_treatment: 'standard_25', category: 'expense_software' },
      debit_account: '5420',
      credit_account: '1930',
      vat_treatment: 'standard_25',
      requires_review: true,
      seen_count: 2,
      description_sv: 'Som förra gången: bokförd så 2 gånger tidigare',
    })
    expect(whyKeyFor(p)).toEqual({ key: 'rec_why_precedent', values: { count: 2 } })
    expect(whyTextSv(p)).toContain('Som förra gången')
    expect(categorizeBodyFor(p)).toEqual({
      is_business: true,
      category: 'expense_software',
      account_override: '5420',
      vat_treatment: 'standard_25',
      proposal_id: 'precedent:5420',
    })
  })

  it('never books without a review, whatever the count, and logs the count', () => {
    const many = Array.from({ length: 20 }, () => booking(purchase25()))
    const p = precedentProposal(row, many, 'aktiebolag')!
    expect(p.seen_count).toBe(20)
    expect(reviewReason(p, DIRECT_BOOKING_ON)).toBe('evidence')
    expect(offeredSuggestions([p]).suggestions).toEqual([
      expect.objectContaining({
        source: 'precedent',
        source_id: 'precedent:5420',
        rank: 0,
        evidence: { seen_count: 20 },
        proposal: expect.objectContaining({ debit_account: '5420', credit_account: '1930', vat_treatment: 'standard_25' }),
      }),
    ])
  })

  it('passes over a booking with several business accounts for the next most recent one', () => {
    const split = booking([line('5420', 300, 0), line('6110', 200, 0), line('1930', 0, 500)])
    const p = precedentProposal(row, [split, booking(noMoms('6110')), booking(purchase25())], 'aktiebolag')!
    expect(p.booking).toMatchObject({ account: '6110', vat_treatment: 'exempt' })
    expect(p.seen_count).toBe(1)
  })

  it('proposes nothing when no earlier booking says one account, or there is none', () => {
    expect(precedentProposal(row, [], 'aktiebolag')).toBeNull()
    expect(precedentProposal(row, [booking([line('5420', 300, 0), line('6110', 200, 0), line('1930', 0, 500)])], 'aktiebolag')).toBeNull()
  })

  it('never takes the row itself as its precedent', () => {
    expect(precedentProposal(row, [booking(purchase25(), { transaction_id: 'tx-open' })], 'aktiebolag')).toBeNull()
  })

  it('counts only bookings where the money moved the same way as on the row', () => {
    const refund = booking([line('1930', 500, 0), line('5420', 0, 400), line('2641', 0, 100)], { amount: 500 })
    expect(precedentProposal(row, [refund], 'aktiebolag')).toBeNull()

    const moneyIn = makeTransaction({ id: 'tx-in', amount: 500 })
    const p = precedentProposal(moneyIn, [booking(purchase25()), refund], 'aktiebolag')!
    // The earlier refund, booked back on the cost account with its moms: an expense category on money in.
    expect(p).toMatchObject({
      booking: { kind: 'account', account: '5420', vat_treatment: 'standard_25', category: 'expense_software' },
      debit_account: '1930',
      credit_account: '5420',
      seen_count: 1,
    })
  })

  it('books a sale as a sale and money in without moms under an income category', () => {
    const moneyIn = makeTransaction({ id: 'tx-in', amount: 500 })
    const sale = booking([line('1930', 500, 0), line('3001', 0, 400), line('2611', 0, 100)], { amount: 500 })
    expect(precedentProposal(moneyIn, [sale], 'aktiebolag')!.booking).toMatchObject({
      account: '3001',
      vat_treatment: 'standard_25',
      category: expect.stringMatching(/^income_/),
    })
    const settled = booking([line('1930', 500, 0), line('1510', 0, 500)], { amount: 500 })
    expect(precedentProposal(moneyIn, [settled], 'aktiebolag')!.booking).toMatchObject({
      account: '1510',
      vat_treatment: 'exempt',
      category: 'income_other',
    })
  })

  it('never proposes reverse charge on money in', () => {
    const moneyIn = makeTransaction({ id: 'tx-in', amount: 500 })
    const odd = booking([line('1930', 500, 0), line('5420', 0, 500), line('2645', 0, 125), line('2614', 125, 0)], { amount: 500 })
    expect(precedentProposal(moneyIn, [odd], 'aktiebolag')).toBeNull()
  })
})
