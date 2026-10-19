/**
 * proposeForTransactions and the assistant's stored reads: which reads it
 * asks for, which it keeps, where a kept read's proposal lands among the
 * row's others, and that a failed read never takes the list down. Pinned at
 * the table (transaction_assistant_reads), so it holds wherever the read
 * helpers live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'

const { counterparts, suggested } = vi.hoisted(() => ({ counterparts: vi.fn(), suggested: vi.fn() }))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
}))
vi.mock('@/lib/transactions/category-suggestions', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/category-suggestions')>()),
  getSuggestedTemplates: suggested,
}))

import { mergeAssistantSuggestion, proposeForTransactions } from '../propose'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { proposalFromTemplate } from '@/lib/bookkeeping/proposal'

const COMPANY_ID = 'company-1'

const fresh = makeTransaction({ id: 'tx-fresh', amount: -500, document_id: 'doc-1', description: 'Kontorsbolaget' })
const stale = makeTransaction({ id: 'tx-stale', amount: -200, document_id: 'doc-new', description: 'Kontorsbolaget' })
const unread = makeTransaction({ id: 'tx-unread', amount: -100, document_id: null, description: 'Kontorsbolaget' })

const readRow = (over: Record<string, unknown>) => ({
  company_id: COMPANY_ID,
  has_underlag: true,
  account: '5410',
  category: 'expense_office',
  vat_treatment: 'standard_25',
  reverse_charge: false,
  reverse_charge_kind: null,
  confidence: '0.7',
  model_confidence: 'medium',
  agreement: 1,
  from_candidate: false,
  reasoning: 'Förbrukningsinventarier. Kontorsstol.',
  candidates: [],
  model: 'm',
  ...over,
})

const catalog = () => {
  const template = getTemplateById('financial_tax_account')!
  return proposalFromTemplate(template, 'catalog', 0.3)
}

function ledger(reads: NonNullable<Parameters<typeof createTableMockSupabase>[0]>[string]) {
  return createTableMockSupabase({
    mapping_rules: { data: [], error: null },
    company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
    transaction_assistant_reads: reads,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  counterparts.mockResolvedValue(new Map<string, CounterpartyTemplateMatch>())
  suggested.mockImplementation(async () => [catalog()])
})

describe('proposeForTransactions: the assistant\'s stored reads', () => {
  it('asks for the rows\' reads, keeps the fresh ones and puts a likely read\'s proposal ahead of the catalog', async () => {
    const { supabase, findCalls } = ledger({
      data: [
        readRow({ transaction_id: 'tx-fresh', underlag_key: 'doc-1' }),
        readRow({ transaction_id: 'tx-stale', underlag_key: 'doc-old' }),
      ],
      error: null,
    })

    const out = await proposeForTransactions(supabase as unknown as SupabaseClient, COMPANY_ID, [fresh, stale, unread])

    expect(findCalls('transaction_assistant_reads', 'select')).toEqual([['*']])
    expect(findCalls('transaction_assistant_reads', 'eq')).toEqual([['company_id', COMPANY_ID]])
    expect(findCalls('transaction_assistant_reads', 'in')).toEqual([['transaction_id', ['tx-fresh', 'tx-stale', 'tx-unread']]])

    expect(Object.keys(out.assistant_reads)).toEqual(['tx-fresh'])
    expect(out.assistant_reads['tx-fresh']).toMatchObject({ transaction_id: 'tx-fresh', confidence: 0.7, candidates: [] })

    expect(out.proposals['tx-fresh']!.map((p) => p.source)).toEqual(['assistant', 'catalog'])
    expect(out.proposals['tx-fresh']![0]).toEqual({
      template_id: 'assistant:tx-fresh',
      source: 'assistant',
      group: 'account',
      booking: { kind: 'account', account: '5410', category: 'expense_office', vat_treatment: 'standard_25' },
      name_sv: 'Förbrukningsinventarier',
      name_en: 'Förbrukningsinventarier',
      description_sv: 'Förbrukningsinventarier.',
      debit_account: '5410',
      credit_account: '1930',
      vat_treatment: 'standard_25',
      risk_level: 'LOW',
      requires_review: false,
      confidence: 0.7,
      has_underlag: true,
    })
    expect(out.proposals['tx-stale']!.map((p) => p.source)).toEqual(['catalog'])
    expect(out.proposals['tx-unread']!.map((p) => p.source)).toEqual(['catalog'])
  })

  it('puts an unsure read\'s proposal last and contests a weak counterpart the read saw and booked elsewhere', async () => {
    const template = makeCategorizationTemplate({ id: 'cp-1', counterparty_name: 'kontorsbolaget', debit_account: '6110', occurrence_count: 1 })
    counterparts.mockResolvedValue(new Map([['tx-fresh', { template, matchMethod: 'fuzzy', confidence: 0.4 }]]))
    const { supabase } = ledger({
      data: [
        readRow({
          transaction_id: 'tx-fresh',
          underlag_key: 'doc-1',
          confidence: 0.2,
          candidates: [{ account: '6110', label: 'Kontorsmateriel', source: 'counterparty_template' }],
        }),
      ],
      error: null,
    })

    const out = await proposeForTransactions(supabase as unknown as SupabaseClient, COMPANY_ID, [fresh])

    expect(out.proposals['tx-fresh']!.map((p) => [p.source, p.contested ?? false])).toEqual([
      ['counterparty', true],
      ['catalog', false],
      ['assistant', false],
    ])
  })

  it('reads nothing with withReads: false', async () => {
    const { supabase, calls } = ledger({ data: [readRow({ transaction_id: 'tx-fresh', underlag_key: 'doc-1' })], error: null })

    const out = await proposeForTransactions(supabase as unknown as SupabaseClient, COMPANY_ID, [fresh], { withReads: false })

    expect(calls.some((c) => c.table === 'transaction_assistant_reads')).toBe(false)
    expect(out.assistant_reads).toEqual({})
    expect(out.proposals['tx-fresh']!.map((p) => p.source)).toEqual(['catalog'])
  })

  it('answers without reads when the read throws', async () => {
    const { supabase } = ledger(() => {
      throw new Error('connection reset')
    })

    const out = await proposeForTransactions(supabase as unknown as SupabaseClient, COMPANY_ID, [fresh])

    expect(out.assistant_reads).toEqual({})
    expect(out.proposals['tx-fresh']!.map((p) => p.source)).toEqual(['catalog'])
  })
})

const sug = (source: SuggestedTemplate['source'], confidence = 0.9): SuggestedTemplate => ({
  template_id: `${source}-x`, source, booking: { kind: 'template', template_id: 'x', category: 'expense_other' },
  name_sv: 'x', name_en: 'x', group: 'g', debit_account: '5410', credit_account: '1930',
  confidence, description_sv: '', risk_level: 'LOW', requires_review: false,
})

describe('mergeAssistantSuggestion', () => {
  it('sits behind a rule and a counterpart but ahead of the catalog when likely', () => {
    const out = mergeAssistantSuggestion([sug('rule'), sug('counterparty'), sug('catalog')], sug('assistant', 0.6))
    expect(out.map((s) => s.source)).toEqual(['rule', 'counterparty', 'assistant', 'catalog'])
  })
  it('goes last when unsure', () => {
    const out = mergeAssistantSuggestion([sug('catalog')], sug('assistant', 0.2))
    expect(out.map((s) => s.source)).toEqual(['catalog', 'assistant'])
  })
  it('replaces an earlier assistant suggestion instead of stacking', () => {
    const out = mergeAssistantSuggestion([sug('assistant', 0.9), sug('catalog')], sug('assistant', 0.6))
    expect(out.filter((s) => s.source === 'assistant')).toHaveLength(1)
  })
})
