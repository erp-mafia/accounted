/**
 * gnubok_suggest_categories: a Stripe sale (a card payment from the Stripe
 * feed, money in) carries no moms and no buyer country, so nothing matched
 * it and it was listed in no_signal_transaction_ids with nothing to go on.
 * It now leads with how Stripe sales are booked (one samlingsverifikat per
 * day), the verifikat that booked the latest one, and where its moms comes
 * from: never an account or a rate. A row nothing matched that is not a
 * Stripe sale is still listed as no signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'

const proposeMock = vi.fn()
vi.mock('@/lib/transactions/propose', () => ({
  proposeForTransactions: (...args: unknown[]) => proposeMock(...args),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('@/lib/transactions/salary-run-payouts', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/salary-run-payouts')>()),
  findSalaryRunPayouts: vi.fn().mockResolvedValue({ links: new Map(), without_run: new Set() }),
}))

import { tools } from '../server'
import { STRIPE_DAILY_SALES_PROPOSAL_ID, STRIPE_SALE_VAT_HINT, isStripeSaleRow } from '../stripe-sales'

const suggest = tools.find((t) => t.name === 'gnubok_suggest_categories')!

beforeEach(() => {
  vi.clearAllMocks()
})

// Descriptions no keyword pattern or rule knows, so only the Stripe hint and
// the mocked proposals decide.
const stripeSale = makeTransaction({
  id: 'tx-stripe-sale',
  amount: 1250,
  description: 'Stripe-betalning Zqxw Vrpt',
  original_description: null,
  merchant_name: null,
  import_source: 'stripe',
  transaction_method: 'card',
})
const stripeFee = makeTransaction({
  id: 'tx-stripe-fee',
  amount: -21.5,
  description: 'Zqxw Kbnt',
  original_description: null,
  merchant_name: null,
  import_source: 'stripe',
  transaction_method: 'fee',
})
const bankRow = makeTransaction({ id: 'tx-bank', amount: 900, description: 'Zqxw Lmpq', original_description: 'Zqxw Lmpq', merchant_name: null })

type Out = { proposals: Record<string, Array<Record<string, unknown>>>; no_signal_transaction_ids: string[] }

function run(rows: ReturnType<typeof makeTransaction>[], stripeRead?: { data?: unknown; error?: unknown }, proposals: Record<string, BookingProposal[]> = {}) {
  proposeMock.mockResolvedValue({ proposals, assistant_reads: {}, direct_booking: { enabled: true } })
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: rows, error: null }) // transactions
  mock.enqueue({ data: [], error: null }) // mapping rules
  mock.enqueue({ data: [], error: null }) // categorized history
  mock.enqueue({ data: { entity_type: 'aktiebolag' }, error: null }) // companies
  if (stripeRead) mock.enqueue(stripeRead) // the latest booked Stripe sale
  const out = suggest.execute(
    { transaction_ids: rows.map((r) => r.id) },
    'company-1',
    'user-1',
    mock.supabase as never,
  ) as Promise<Out>
  return { out, mock }
}

describe('gnubok_suggest_categories: Stripe sales', () => {
  it('leads a Stripe sale with how Stripe sales are booked and the verifikat that booked the latest one', async () => {
    const { out, mock } = run([stripeSale], {
      data: [{ journal_entry: { id: 'entry-77', voucher_series: 'A', voucher_number: 77, entry_date: '2026-11-20', status: 'posted' } }],
    })
    const result = await out
    const [first] = result.proposals['tx-stripe-sale']
    expect(first.id).toBe(STRIPE_DAILY_SALES_PROPOSAL_ID)
    expect(first.why).toContain('en samlingsverifikat per dag')
    expect(first.why).toContain('gnubok_bulk_book_transactions')
    expect(first.why).toContain('verifikat A77 (2026-11-20)')
    expect(first.example_voucher).toEqual({ journal_entry_id: 'entry-77', voucher: 'A77', entry_date: '2026-11-20' })
    expect(first.hint).toBe(STRIPE_SALE_VAT_HINT)
    expect(first.books_without_review).toBe(false)
    // Never a booking of its own: no account, no moms, nothing to book with.
    expect(first).not.toHaveProperty('categorize_args')
    expect(first).not.toHaveProperty('account')
    expect(first).not.toHaveProperty('vat_treatment')
    expect(result.no_signal_transaction_ids).not.toContain('tx-stripe-sale')
    // The example is read among the company's booked Stripe sales only.
    expect(mock.findCalls('transactions', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['import_source', 'stripe'],
        ['transaction_method', 'card'],
      ]),
    )
  })

  it('keeps the hint, without an example, when no Stripe sale is booked yet', async () => {
    const { out } = run([stripeSale], { data: [] })
    const result = await out
    const [first] = result.proposals['tx-stripe-sale']
    expect(first.id).toBe(STRIPE_DAILY_SALES_PROPOSAL_ID)
    expect(first.why).not.toContain('Senast')
    expect(first).not.toHaveProperty('example_voucher')
    expect(first.hint).toBe(STRIPE_SALE_VAT_HINT)
    expect(result.no_signal_transaction_ids).not.toContain('tx-stripe-sale')
  })

  it('names no example when the read fails or the verifikat is no longer posted', async () => {
    const failed = await run([stripeSale], { error: { message: 'boom' } }).out
    expect(failed.proposals['tx-stripe-sale'][0]).not.toHaveProperty('example_voucher')
    const reversed = await run([stripeSale], {
      data: [{ journal_entry: { id: 'entry-78', voucher_series: 'A', voucher_number: 78, entry_date: '2026-11-21', status: 'reversed' } }],
    }).out
    expect(reversed.proposals['tx-stripe-sale'][0]).not.toHaveProperty('example_voucher')
    expect(reversed.no_signal_transaction_ids).not.toContain('tx-stripe-sale')
  })

  it('still lists a row nothing matched that is not a Stripe sale, and reads nothing for it', async () => {
    const { out, mock } = run([bankRow, stripeFee])
    const result = await out
    expect(result.proposals['tx-bank']).toEqual([])
    expect(result.proposals['tx-stripe-fee']).toEqual([])
    expect(result.no_signal_transaction_ids).toEqual(expect.arrayContaining(['tx-bank', 'tx-stripe-fee']))
    expect(mock.findCalls('transactions', 'eq')).not.toContainEqual(['import_source', 'stripe'])
  })
})

describe('isStripeSaleRow', () => {
  it('is a card payment from the Stripe feed with money in', () => {
    expect(isStripeSaleRow(stripeSale)).toBe(true)
    expect(isStripeSaleRow({ ...stripeSale, amount: -1250 })).toBe(false) // a refund
    expect(isStripeSaleRow(stripeFee)).toBe(false)
    expect(isStripeSaleRow({ ...stripeSale, transaction_method: 'transfer' })).toBe(false) // a payout
    expect(isStripeSaleRow({ ...stripeSale, import_source: null })).toBe(false) // a bank row
  })
})
