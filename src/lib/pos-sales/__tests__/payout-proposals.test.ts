import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClearingBankRow, ClearingBankRows } from '@/lib/transactions/clearing-proposals'
import { categorizeArgsFor, categorizeBodyFor, whyKeyFor, whyTextSv } from '@/lib/bookkeeping/proposal'
import { applyAccountOverride } from '@/lib/bookkeeping/account-override'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { createMockSupabase } from '@/tests/helpers'
import type { Transaction } from '@/types'
import { booksWithoutReview } from '@/lib/transactions/direct-booking'
import { namesCounterparty, posPayoutProposer, receiptPaidOn, saysSwish } from '../payout-proposals'
import { createFakeDb } from './fake-db'

/**
 * The till's payouts as bank-row proposals, end to end over the POS tables
 * (a fake PostgREST) and the bank side's rows (a fake ClearingBankRows):
 * what is read for a company without a till, the Swish and card proposals
 * and their shape, and the rows that get none.
 */

const COMPANY = 'company-cafe-exempel'
const CONN = 'conn-cafe-exempel'

const connection = (over: Record<string, unknown> = {}) => ({
  id: CONN,
  company_id: COMPANY,
  status: 'active',
  venue_ref: '5550000000000001',
  venue_name: 'Café Exempel',
  settings: {},
  ...over,
})

const day = (business_date: string, tenders: Array<Record<string, unknown>>, receipts: Array<Record<string, unknown>> = []) => ({
  id: `day-${business_date}`,
  company_id: COMPANY,
  connection_id: CONN,
  business_date,
  currency: 'SEK',
  status: 'ready',
  tenders,
  // What the select alias receipts:day->receipts answers with.
  receipts,
  day: { receipts },
})

const tender = (kind: string, method: string, amount: number) => ({ kind, method, amount, tips: 0, receiptCount: 1 })

const row = (over: Partial<ClearingBankRow> & Pick<ClearingBankRow, 'id' | 'date' | 'amount'>): ClearingBankRow => ({
  currency: 'SEK',
  text: '',
  merchant_name: null,
  transaction_method: null,
  ...over,
})

function bankRows(open: ClearingBankRow[] = [], cleared: ClearingBankRow[] = []) {
  const bank: ClearingBankRows & { open: ReturnType<typeof vi.fn>; cleared: ReturnType<typeof vi.fn> } = {
    open: vi.fn(async () => open),
    cleared: vi.fn(async () => cleared),
  }
  return bank
}

function client(seed: Record<string, Array<Record<string, unknown>>>) {
  const db = createFakeDb(seed)
  const reads: string[] = []
  const supabase = {
    from: (table: string) => {
      reads.push(table)
      return db.client.from(table)
    },
  } as unknown as SupabaseClient
  return { supabase, reads }
}

const swishRow = row({ id: 'tx-swish', date: '2026-10-06', amount: 145.5, text: '+46700000000 1834 swish +' })
const swishDay = day(
  '2026-10-06',
  [tender('swish', 'Swish', 145.5), tender('card', 'Kort', 10_000)],
  [
    { number: '1834', kind: 'sale', paidAt: '2026-10-06T12:14:00+02:00', method: 'Swish', gross: 140, tips: 5.5 },
    { number: '1835', kind: 'sale', paidAt: '2026-10-06T12:20:00+02:00', method: 'Kort', gross: 10_000, tips: 0 },
  ],
)

describe('posPayoutProposer', () => {
  it('reads one table and nothing else for a company without an active till', async () => {
    const { supabase, reads } = client({ pos_connections: [connection({ status: 'disconnected' })] })
    const bank = bankRows([swishRow])
    const out = await posPayoutProposer.propose(supabase, COMPANY, [swishRow], bank)
    expect(out.size).toBe(0)
    expect(reads).toEqual(['pos_connections'])
    expect(bank.open).not.toHaveBeenCalled()
    expect(bank.cleared).not.toHaveBeenCalled()
  })

  it('proposes the Swish row against 1686, as a review, with the receipt as the reason', async () => {
    const { supabase } = client({ pos_connections: [connection()], pos_sales_days: [swishDay] })
    const out = await posPayoutProposer.propose(supabase, COMPANY, [swishRow], bankRows([swishRow]))
    const p = out.get('tx-swish')!
    expect(p).toMatchObject({
      template_id: 'clearing:pos:swish',
      source: 'clearing',
      booking: { kind: 'account', account: '1686', vat_treatment: 'exempt', category: 'income_other' },
      debit_account: '1930',
      credit_account: '1686',
      requires_review: true,
      confidence: 0.9,
      clearing: { channel: 'pos', kind: 'swish', fit: 'receipt', account: '1686', business_dates: ['2026-10-06'], receipt_number: '1834', expected_amount: 145.5 },
    })
    expect(booksWithoutReview(p)).toBe(false)
    expect(whyKeyFor(p)).toEqual({ key: 'rec_why_clearing_receipt', values: { receipt: '1834', date: '2026-10-06', account: '1686' } })
    expect(whyTextSv(p)).toContain('två gånger')
    expect(p.description_sv).toContain('kvitto 1834')
    expect(categorizeArgsFor(p)).toEqual({ category: 'income_other', account_override: '1686', vat_treatment: 'exempt', proposal_id: 'clearing:pos:swish' })
  })

  it('books, as the categorize path builds it, bank against 1686 with no moms and no revenue', async () => {
    const { supabase } = client({ pos_connections: [connection()], pos_sales_days: [swishDay] })
    const p = (await posPayoutProposer.propose(supabase, COMPANY, [swishRow], bankRows([swishRow]))).get('tx-swish')!
    const body = categorizeBodyFor(p)
    const tx = { id: 'tx-swish', company_id: COMPANY, date: '2026-10-06', amount: 145.5, currency: 'SEK', description: swishRow.text } as Transaction
    const chart = createMockSupabase()
    chart.mockResult({ data: { account_number: '1686', account_class: 1, is_active: true } })
    let mapping = buildMappingResultFromCategory(body.category!, tx, true, 'aktiebolag', body.vat_treatment)
    mapping = await applyAccountOverride(chart.supabase as never, COMPANY, body.account_override!, tx.amount, mapping, true)
    const lines = buildTransactionEntryLines(tx, mapping)
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 145.5, 0],
      ['1686', 0, 145.5],
    ])
  })

  it('proposes a card payout without a name against the card account', async () => {
    const payout = row({ id: 'tx-card', date: '2026-10-07', amount: 9_910, text: 'REF2610070AB1CD' })
    const { supabase } = client({ pos_connections: [connection()], pos_sales_days: [swishDay] })
    const out = await posPayoutProposer.propose(supabase, COMPANY, [payout], bankRows([payout]))
    expect(out.get('tx-card')).toMatchObject({
      template_id: 'clearing:pos:card',
      credit_account: '1686',
      confidence: 0.7,
      clearing: { kind: 'card', fit: 'days', business_dates: ['2026-10-06'], expected_amount: 10_000 },
    })
  })

  it('offers nothing for a payout-sized row that names a counterparty', async () => {
    const named = row({ id: 'tx-named', date: '2026-10-07', amount: 9_910, text: 'Exempelföretaget AB catering' })
    const { supabase } = client({ pos_connections: [connection()], pos_sales_days: [swishDay] })
    const out = await posPayoutProposer.propose(supabase, COMPANY, [named], bankRows([named]))
    expect(out.size).toBe(0)
  })

  it('lets a row already booked against 1686 keep its receipt', async () => {
    const booked = row({ id: 'tx-booked', date: '2026-10-06', amount: 145.5, text: '+46700000000 1834 swish +' })
    const { supabase } = client({ pos_connections: [connection()], pos_sales_days: [swishDay] })
    const bank = bankRows([swishRow], [booked])
    const out = await posPayoutProposer.propose(supabase, COMPANY, [swishRow], bank)
    expect(out.size).toBe(0)
    expect(bank.cleared).toHaveBeenCalledWith(['1686'], '2026-09-15', '2026-10-11')
  })

  it('reads the receipts of the booked rows after the asked one, so they never take its receipt', async () => {
    const later = day('2026-10-08', [tender('swish', 'Swish', 145.5)], [
      { number: '1900', kind: 'sale', paidAt: '2026-10-08T11:02:00+02:00', method: 'Swish', gross: 145.5, tips: 0 },
    ])
    const booked = row({ id: 'tx-booked-later', date: '2026-10-08', amount: 145.5, text: '+46700000001 1900 swish +' })
    const { supabase } = client({ pos_connections: [connection()], pos_sales_days: [swishDay, later] })
    const out = await posPayoutProposer.propose(supabase, COMPANY, [swishRow], bankRows([swishRow], [booked]))
    expect(out.get('tx-swish')?.clearing?.receipt_number).toBe('1834')
  })

  it('proposes nothing for a kind whose tender account is a cash ledger, or a row in another currency', async () => {
    const straightToBank = connection({ settings: { tender_accounts: { swish: '1930' } } })
    const a = client({ pos_connections: [straightToBank], pos_sales_days: [swishDay] })
    expect((await posPayoutProposer.propose(a.supabase, COMPANY, [swishRow], bankRows([swishRow]))).size).toBe(0)

    const euro = { ...swishRow, currency: 'EUR' }
    const b = client({ pos_connections: [connection()], pos_sales_days: [swishDay] })
    expect((await posPayoutProposer.propose(b.supabase, COMPANY, [euro], bankRows([euro]))).size).toBe(0)
  })

  it('uses the connection\'s own tender account', async () => {
    const own = connection({ settings: { tender_accounts: { card: '1580' } } })
    const payout = row({ id: 'tx-card', date: '2026-10-07', amount: 9_910, text: 'REF2610070AB1CD' })
    const { supabase } = client({ pos_connections: [own], pos_sales_days: [swishDay] })
    const out = await posPayoutProposer.propose(supabase, COMPANY, [payout], bankRows([payout]))
    expect(out.get('tx-card')?.booking).toMatchObject({ kind: 'account', account: '1580' })
  })
})

describe('the row shape', () => {
  it('tells a name from a reference', () => {
    expect(namesCounterparty({ text: 'SWED2610020YC3IQ', merchant_name: null })).toBe(false)
    expect(namesCounterparty({ text: 'Insättning 4455-1234', merchant_name: null })).toBe(false)
    expect(namesCounterparty({ text: '+46700000000 1834 swish +', merchant_name: null })).toBe(false)
    expect(namesCounterparty({ text: 'Kalle Exempelsson', merchant_name: null })).toBe(true)
    expect(namesCounterparty({ text: 'REF123', merchant_name: 'Café Exempel' })).toBe(true)
  })

  it('reads Swish off the rail or the word', () => {
    expect(saysSwish({ text: '+46700000000 1834 swish +', transaction_method: 'transfer' })).toBe(true)
    expect(saysSwish({ text: 'REF123', transaction_method: 'swish' })).toBe(true)
    expect(saysSwish({ text: 'REF123', transaction_method: 'transfer' })).toBe(false)
  })

  it('dates a receipt in Swedish time, local time as given, the business day when missing or far off', () => {
    expect(receiptPaidOn('2026-10-06T23:30:00Z', '2026-10-06')).toBe('2026-10-07')
    expect(receiptPaidOn('2026-10-07T00:40:00', '2026-10-06')).toBe('2026-10-07')
    expect(receiptPaidOn(null, '2026-10-06')).toBe('2026-10-06')
    expect(receiptPaidOn('2026-11-30T12:00:00', '2026-10-06')).toBe('2026-10-06')
  })
})
