/**
 * gnubok_suggest_categories lists a row in no_signal_transaction_ids only
 * when its own answer offers nothing for it. A row that got a catalog
 * proposal was still called empty when no rule, history or learned
 * counterpart matched it (crm#1552), contradicting the proposal printed
 * right above it.
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
import { proposalFromTemplate } from '@/lib/bookkeeping/proposal'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'

const suggest = tools.find((t) => t.name === 'gnubok_suggest_categories')!

beforeEach(() => {
  vi.clearAllMocks()
})

// Descriptions no keyword pattern or rule knows, so only the mocked
// proposals decide.
const catalogRow = makeTransaction({ id: 'tx-catalog', amount: -351.28, description: 'Zqxw-G194', original_description: 'Zqxw-G194', merchant_name: null })
const emptyRow = makeTransaction({ id: 'tx-empty', amount: -120, description: 'Zqxw Vrpt', original_description: 'Zqxw Vrpt', merchant_name: null })
const clearingRow = makeTransaction({ id: 'tx-clearing', amount: 900, description: 'Zqxw Kbnt', original_description: 'Zqxw Kbnt', merchant_name: null })

function run(proposals: Record<string, BookingProposal[]>) {
  proposeMock.mockResolvedValue({ proposals, assistant_reads: {}, direct_booking: { enabled: true } })
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: [catalogRow, emptyRow, clearingRow], error: null }) // transactions
  enqueue({ data: [], error: null }) // mapping rules
  enqueue({ data: [], error: null }) // categorized history
  enqueue({ data: { entity_type: 'aktiebolag' }, error: null }) // companies
  return suggest.execute(
    { transaction_ids: ['tx-catalog', 'tx-empty', 'tx-clearing'] },
    'company-1',
    'user-1',
    supabase as never,
  ) as Promise<{ proposals: Record<string, unknown[]>; no_signal_transaction_ids: string[] }>
}

describe('gnubok_suggest_categories: no_signal_transaction_ids', () => {
  it('never lists a row that carries a catalog proposal (crm#1552)', async () => {
    const catalog = proposalFromTemplate(getTemplateById('it_saas_eu')!, 'catalog', 0.16)
    const out = await run({ 'tx-catalog': [catalog] })
    expect(out.proposals['tx-catalog']).toHaveLength(1)
    expect(out.no_signal_transaction_ids).not.toContain('tx-catalog')
  })

  it('lists a row nothing matched', async () => {
    const out = await run({})
    expect(out.proposals['tx-empty']).toEqual([])
    expect(out.no_signal_transaction_ids).toContain('tx-empty')
  })

  it('keeps a row with a clearing proposal out of the list', async () => {
    const clearing = { ...proposalFromTemplate(getTemplateById('it_saas_eu')!, 'clearing', 1), template_id: 'clearing:pos' }
    const out = await run({ 'tx-clearing': [clearing] })
    expect(out.no_signal_transaction_ids).not.toContain('tx-clearing')
  })

  it('treats a template merely used lately as no signal: it is not offered to the agent', async () => {
    const recent = proposalFromTemplate(getTemplateById('it_saas_eu')!, 'recent', 0.1)
    const out = await run({ 'tx-empty': [recent] })
    expect(out.proposals['tx-empty']).toEqual([])
    expect(out.no_signal_transaction_ids).toContain('tx-empty')
  })
})
