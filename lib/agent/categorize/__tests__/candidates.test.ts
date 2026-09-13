import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Transaction } from '@/types'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'

const propose = vi.fn()
vi.mock('@/lib/transactions/propose', () => ({
  proposeForTransactions: (...a: unknown[]) => propose(...a),
}))

import { gatherCandidates } from '../candidates'

const TX = { id: 't1', merchant_name: 'Biltema', description: 'Kortköp', amount: -499 } as unknown as Transaction
const supabase = {} as SupabaseClient

function proposal(over: Partial<BookingProposal>): BookingProposal {
  return {
    template_id: 'x', source: 'catalog', booking: { kind: 'template', template_id: 'x', category: 'expense_other' },
    name_sv: 'x', name_en: 'x', group: 'g', debit_account: '5410', credit_account: '1930', confidence: 0.5,
    description_sv: '', risk_level: 'LOW', requires_review: false, ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  propose.mockResolvedValue({ proposals: {}, assistant_reads: {} })
})

describe('gatherCandidates', () => {
  it('asks the one proposer, without the assistant\'s own reads', async () => {
    await gatherCandidates(supabase, 'c1', TX)
    expect(propose).toHaveBeenCalledWith(supabase, 'c1', [TX], { withReads: false })
  })

  it('reduces a counterpart to its account, VAT and evidence', async () => {
    propose.mockResolvedValue({ proposals: { t1: [proposal({
      template_id: 'cp:abc', source: 'counterparty', booking: { kind: 'counterparty', counterparty_template_id: 'abc' },
      name_sv: 'Biltema', debit_account: '5410', vat_treatment: 'standard_25', confidence: 0.9, description_sv: '4 tidigare bokföringar', seen_count: 4,
    })] }, assistant_reads: {} })
    const out = await gatherCandidates(supabase, 'c1', TX)
    expect(out[0]).toMatchObject({ account: '5410', source: 'counterparty_template', vatTreatment: 'standard_25', confidence: 0.9 })
    expect(out[0].matchReason).toContain('4 tidigare')
  })

  it('maps a matched rule and a catalog match to the slate\'s sources', async () => {
    propose.mockResolvedValue({ proposals: { t1: [
      proposal({ source: 'rule', debit_account: '6570', vat_treatment: 'exempt', confidence: 0.9 }),
      proposal({ source: 'catalog', debit_account: '5420', vat_treatment: 'standard_25', confidence: 0.3 }),
    ] }, assistant_reads: {} })
    const out = await gatherCandidates(supabase, 'c1', TX)
    expect(out.map((c) => [c.account, c.source])).toEqual([['6570', 'mapping_rule'], ['5420', 'pattern']])
  })

  it('leaves out the assistant\'s earlier read and templates merely used lately', async () => {
    propose.mockResolvedValue({ proposals: { t1: [
      proposal({ source: 'assistant', booking: { kind: 'account', account: '6071', vat_treatment: 'reduced_12', category: 'expense_representation' }, debit_account: '6071' }),
      proposal({ source: 'recent', debit_account: '6110', confidence: 0.1 }),
      proposal({ source: 'catalog', debit_account: '5410', confidence: 0.3 }),
    ] }, assistant_reads: {} })
    const out = await gatherCandidates(supabase, 'c1', TX)
    expect(out.map((c) => c.account)).toEqual(['5410'])
  })

  it('de-duplicates by account, keeping the highest confidence, sorted and capped', async () => {
    propose.mockResolvedValue({ proposals: { t1: [
      proposal({ source: 'catalog', debit_account: '5410', confidence: 0.3 }),
      proposal({ source: 'rule', debit_account: '5410', confidence: 0.9 }),
      proposal({ source: 'catalog', debit_account: '6110', confidence: 0.2 }),
      proposal({ source: 'catalog', debit_account: '5800', confidence: 0.25 }),
    ] }, assistant_reads: {} })
    const out = await gatherCandidates(supabase, 'c1', TX, 2)
    expect(out.map((c) => [c.account, c.source])).toEqual([['5410', 'mapping_rule'], ['5800', 'pattern']])
  })
})
