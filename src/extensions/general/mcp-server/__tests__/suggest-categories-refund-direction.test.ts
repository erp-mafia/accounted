/**
 * gnubok_suggest_categories on money in from a counterpart learned as a
 * cost (crm#1598). counterparty_matches printed the learned expense legs
 * (debit 5420, credit 1930) for a +766.70 row, and the proposal looked like
 * a habit that books without review. Both now follow the one decision the
 * booking makes (contradictsLearnedDirection): legs mirrored, flagged, and
 * never booked without a review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'

const { proposeMock, counterparts } = vi.hoisted(() => ({ proposeMock: vi.fn(), counterparts: vi.fn() }))
vi.mock('@/lib/transactions/propose', () => ({
  proposeForTransactions: (...args: unknown[]) => proposeMock(...args),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
}))
vi.mock('@/lib/transactions/salary-run-payouts', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/salary-run-payouts')>()),
  findSalaryRunPayouts: vi.fn().mockResolvedValue({ links: new Map(), without_run: new Set() }),
}))

import { tools } from '../server'
import { buildCounterpartySuggestion } from '@/lib/transactions/category-suggestions'

const suggest = tools.find((t) => t.name === 'gnubok_suggest_categories')!

const software = makeCategorizationTemplate({
  counterparty_name: 'zqxw software',
  debit_account: '5420',
  credit_account: '1930',
  category: 'expense_software',
  vat_treatment: 'reverse_charge',
  occurrence_count: 9,
  mode: 'propose',
  source: 'user_approved',
})
const refundRow = makeTransaction({ id: 'tx-refund', amount: 766.7, description: 'Zqxw Software', original_description: 'Zqxw Software', merchant_name: null })
const purchaseRow = makeTransaction({ id: 'tx-purchase', amount: -766.7, description: 'Zqxw Software', original_description: 'Zqxw Software', merchant_name: null })
const match = { template: software, confidence: 0.95, matchMethod: 'exact_normalized' } as CounterpartyTemplateMatch

beforeEach(() => {
  vi.clearAllMocks()
})

function run(proposals: Record<string, BookingProposal[]>) {
  counterparts.mockResolvedValue(new Map([['tx-refund', match], ['tx-purchase', match]]))
  proposeMock.mockResolvedValue({ proposals, assistant_reads: {}, direct_booking: { enabled: true } })
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: [refundRow, purchaseRow], error: null }) // transactions
  enqueue({ data: [], error: null }) // mapping rules
  enqueue({ data: [], error: null }) // categorized history
  enqueue({ data: { entity_type: 'aktiebolag' }, error: null }) // companies
  return suggest.execute(
    { transaction_ids: ['tx-refund', 'tx-purchase'] },
    'company-1',
    'user-1',
    supabase as never,
  ) as Promise<{
    counterparty_matches: Record<string, Record<string, unknown>>
    proposals: Record<string, Array<Record<string, unknown>>>
  }>
}

describe('gnubok_suggest_categories: money against a learned direction (crm#1598)', () => {
  it('prints the counterpart match mirrored and flagged on the refund row, unchanged on the purchase', async () => {
    const out = await run({})
    expect(out.counterparty_matches['tx-refund']).toMatchObject({
      debit_account: '1930',
      credit_account: '5420',
      direction_mismatch: true,
    })
    expect(out.counterparty_matches['tx-purchase']).toMatchObject({ debit_account: '5420', credit_account: '1930' })
    expect(out.counterparty_matches['tx-purchase']).not.toHaveProperty('direction_mismatch')
  })

  it('hands the agent a flagged refund proposal that does not book without review, and says why', async () => {
    const out = await run({
      'tx-refund': [buildCounterpartySuggestion(software, 0.95, { directionMismatch: true })],
      'tx-purchase': [buildCounterpartySuggestion(software, 0.95)],
    })
    const refund = out.proposals['tx-refund'][0]
    expect(refund).toMatchObject({ source: 'counterparty', direction_mismatch: true, books_without_review: false, account: '5420' })
    expect(refund.why).toMatch(/troligen en återbetalning eller kreditering/)
    const purchase = out.proposals['tx-purchase'][0]
    expect(purchase).toMatchObject({ books_without_review: true })
    expect(purchase).not.toHaveProperty('direction_mismatch')
  })
})
