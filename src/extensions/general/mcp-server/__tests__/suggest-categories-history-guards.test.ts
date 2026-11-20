/**
 * gnubok_suggest_categories: suggestions.history is a count of the category
 * tags on earlier rows with the same counterparty key. It had none of the
 * guards the learned counterpart beside it has (crm#1920): it keyed on a
 * bank text that names no one, counted tags on rows no verifikat books any
 * more, and printed a tag's default account next to a learned counterpart
 * that books another one. It now reads only what the counterpart rules let
 * through, and says nothing where the learned counterpart already answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
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

const suggest = tools.find((t) => t.name === 'gnubok_suggest_categories')!

// Texts no keyword pattern or rule knows, so only the history decides.
const row = (id: string, text: string) =>
  makeTransaction({ id, amount: -1200, description: text, original_description: text, merchant_name: null })
const tagged = (text: string, category: string, is_booked = true) => ({
  category,
  merchant_name: null,
  description: text,
  original_description: text,
  is_booked,
})

const namedRow = row('tx-named', 'Zqxw Vrpt')
const learnedRow = row('tx-learned', 'Zqxw Kbnt')
const genericRow = row('tx-generic', 'INTERNET BET 1')

const learned = makeCategorizationTemplate({
  counterparty_name: 'zqxw kbnt',
  debit_account: '4531',
  credit_account: '1930',
  category: 'expense_other',
  vat_treatment: 'reverse_charge',
  occurrence_count: 9,
})
const match = { template: learned, confidence: 0.76, matchMethod: 'exact_normalized' } as CounterpartyTemplateMatch

type Suggestion = { category: string; account: string | null; source: string }

beforeEach(() => {
  vi.clearAllMocks()
})

async function run() {
  counterparts.mockResolvedValue(new Map([['tx-learned', match]]))
  proposeMock.mockResolvedValue({ proposals: {}, assistant_reads: {}, direct_booking: { enabled: true } })
  const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
  enqueue({ data: [namedRow, learnedRow, genericRow], error: null }) // transactions
  enqueue({ data: [], error: null }) // mapping rules
  enqueue({
    data: [
      tagged('Zqxw Vrpt', 'expense_office'),
      tagged('Zqxw Vrpt', 'expense_office'),
      // Its verifikat was reversed from the ledger: the tag stayed.
      tagged('Zqxw Vrpt', 'expense_travel', false),
      tagged('Zqxw Kbnt', 'expense_other'),
      tagged('Zqxw Kbnt', 'expense_other'),
      tagged('INTERNET BET 1', 'expense_other'),
      tagged('INTERNET BET 1', 'expense_other'),
    ],
    error: null,
  }) // categorized history
  enqueue({ data: { entity_type: 'aktiebolag' }, error: null }) // companies
  const out = (await suggest.execute(
    { transaction_ids: ['tx-named', 'tx-learned', 'tx-generic'] },
    'company-1',
    'user-1',
    supabase as never,
  )) as {
    suggestions: Record<string, Suggestion[]>
    counterparty_matches: Record<string, Record<string, unknown>>
    no_signal_transaction_ids: string[]
  }
  return { out, selects: findCalls('transactions', 'select').map(([columns]) => String(columns)) }
}

describe('gnubok_suggest_categories: history behind the counterpart guards (crm#1920)', () => {
  it('still offers the tags of a named counterparty that has no learned counterpart, live bookings only', async () => {
    const { out, selects } = await run()
    // expense_travel sat on a row no verifikat books any more.
    expect(out.suggestions['tx-named']).toEqual([
      expect.objectContaining({ category: 'expense_office', source: 'history' }),
    ])
    expect(out.no_signal_transaction_ids).not.toContain('tx-named')
    expect(selects.some((columns) => columns.includes('is_booked'))).toBe(true)
  })

  it('prints no tag count beside a learned counterpart: the match names the account', async () => {
    const { out } = await run()
    expect(out.counterparty_matches['tx-learned']).toMatchObject({ debit_account: '4531', occurrence_count: 9 })
    // Before: expense_other with the tag's default account 6991, against the
    // 4531 the nine verifikat carry.
    expect(out.suggestions['tx-learned']).toEqual([])
  })

  it('offers nothing for a bank text that names no one, and calls the row no signal', async () => {
    const { out } = await run()
    expect(out.suggestions['tx-generic']).toEqual([])
    expect(out.counterparty_matches).not.toHaveProperty('tx-generic')
    expect(out.no_signal_transaction_ids).toContain('tx-generic')
  })
})
