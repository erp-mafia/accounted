/**
 * gnubok_suggest_categories: the company's own earlier booking of a
 * counterparty (source 'precedent') reaches an agent as the app shows it: its
 * source, its why, never bookable without a review, and the arguments that
 * book it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import { precedentProposal, type PrecedentBooking } from '@/lib/transactions/booking-precedent'

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

const suggest = tools.find((t) => t.name === 'gnubok_suggest_categories')!

const row = makeTransaction({ id: 'tx-1', amount: -500, description: 'Zqxw Vrpt', original_description: 'Zqxw Vrpt', merchant_name: null })
const earlier = (n: number): PrecedentBooking => ({
  transaction_id: `earlier-${n}`,
  date: '2026-06-01',
  amount: -500,
  journal_entry_id: `entry-${n}`,
  settlement_ledger: null,
  lines: [
    { account: '5420', debit: 400, credit: 0 },
    { account: '2641', debit: 100, credit: 0 },
    { account: '1930', debit: 0, credit: 500 },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_suggest_categories: a precedent proposal', () => {
  it('names its source and why, never books without a review, and carries the arguments that book it', async () => {
    const precedent = precedentProposal(row, [earlier(1), earlier(2), earlier(3)], 'aktiebolag')!
    counterparts.mockResolvedValue(new Map())
    proposeMock.mockResolvedValue({ proposals: { 'tx-1': [precedent] }, assistant_reads: {}, direct_booking: { enabled: true } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row], error: null }) // transactions
    enqueue({ data: [], error: null }) // mapping rules
    enqueue({ data: [], error: null }) // categorized history
    enqueue({ data: { entity_type: 'aktiebolag' }, error: null }) // companies

    const out = (await suggest.execute({ transaction_ids: ['tx-1'] }, 'company-1', 'user-1', supabase as never)) as {
      proposals: Record<string, Array<Record<string, unknown>>>
      no_signal_transaction_ids: string[]
    }

    expect(out.proposals['tx-1']).toEqual([
      {
        id: 'precedent:5420',
        source: 'precedent',
        label: 'Programvaror',
        why: expect.stringContaining('Som förra gången: motparten är bokförd så 3 gånger tidigare'),
        confidence: precedent.confidence,
        books_without_review: false,
        account: '5420',
        vat_treatment: 'standard_25',
        categorize_args: {
          category: 'expense_software',
          account_override: '5420',
          vat_treatment: 'standard_25',
          proposal_id: 'precedent:5420',
        },
      },
    ])
    expect(out.no_signal_transaction_ids).toEqual([])
  })
})
