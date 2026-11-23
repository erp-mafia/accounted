/**
 * proposeForTransactions and the company's auto-learned mapping rows
 * ("Learned: <merchant>", source 'auto') under BOOKING_PRECEDENT_COMPANY_IDS.
 * Off: the row proposes and books by one click as before. On: the row
 * proposes nothing, a row a person described and a system default still do,
 * and the assistant's read that then stands first on the row never books
 * without a review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeTransaction } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'

const { counterparts } = vi.hoisted(() => ({ counterparts: vi.fn() }))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
}))
vi.mock('@/lib/composition/clearing-proposals', () => ({ CLEARING_PROPOSERS: [] }))

import { proposeForTransactions } from '../propose'
import { rowProposal } from '../category-suggestions'
import { DIRECT_BOOKING_ON, reviewReason } from '../direct-booking'
import { offeredSuggestions } from '@/lib/suggestion-log/classify'

const COMPANY = 'company-1'

const row = makeTransaction({
  id: 'tx-1',
  amount: -299,
  merchant_name: 'Nordverk',
  description: 'Nordverk',
  original_description: 'Nordverk',
  document_id: 'doc-1',
})

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-learned',
    user_id: null,
    company_id: COMPANY,
    rule_name: 'Learned: Nordverk',
    rule_type: 'merchant_name',
    priority: 10,
    mcc_codes: null,
    merchant_pattern: 'Nordverk',
    description_pattern: null,
    amount_min: null,
    amount_max: null,
    debit_account: '5410',
    credit_account: '1930',
    vat_treatment: null,
    vat_debit_account: null,
    vat_credit_account: null,
    risk_level: 'NONE',
    default_private: false,
    requires_review: false,
    confidence_score: 0.95,
    capitalization_threshold: null,
    capitalized_debit_account: null,
    is_active: true,
    source: 'auto',
    user_description: null,
    template_id: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  }
}

const learned = () => rule()
const described = () =>
  rule({
    id: 'rule-described',
    rule_name: 'Described: Nordverk',
    priority: 5,
    debit_account: '6110',
    confidence_score: 0.98,
    source: 'user_description',
    user_description: 'kontorsmaterial',
    template_id: 'office_supplies_general',
  })
const systemDefault = () => rule({ id: 'rule-system', company_id: null, rule_name: 'System: Nordverk', priority: 80, debit_account: '6110' })

/** A sure read of the row's receipt: books by one click when it stands first. */
const sureRead = () => ({
  company_id: COMPANY,
  transaction_id: 'tx-1',
  underlag_key: 'doc-1',
  has_underlag: true,
  account: '6250',
  category: 'expense_other',
  vat_treatment: 'standard_25',
  reverse_charge: false,
  reverse_charge_kind: null,
  confidence: '0.9',
  model_confidence: 'high',
  agreement: 1,
  from_candidate: false,
  reasoning: 'Porto.',
  candidates: [],
  model: 'm',
})

/** The company's own rules answer the company read, the system defaults the other. */
function ledger(opts: { company?: unknown[]; system?: unknown[]; reads?: unknown[] }) {
  return createTableMockSupabase({
    mapping_rules: (chain) => ({
      data: chain.some((c) => c.method === 'is') ? (opts.system ?? []) : (opts.company ?? []),
      error: null,
    }),
    company_settings: { data: { entity_type: 'aktiebolag', direct_booking_enabled: true }, error: null },
    transaction_assistant_reads: { data: opts.reads ?? [], error: null },
  })
}

async function propose(opts: Parameters<typeof ledger>[0]) {
  const { supabase } = ledger(opts)
  const out = await proposeForTransactions(supabase as unknown as SupabaseClient, COMPANY, [row])
  return out.proposals['tx-1'] ?? []
}

const shape = (list: Awaited<ReturnType<typeof propose>>) => list.map((p) => [p.source, p.template_id])

beforeEach(() => {
  vi.clearAllMocks()
  counterparts.mockResolvedValue(new Map<string, CounterpartyTemplateMatch>())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('switch off: an auto-learned row proposes as before', () => {
  it('leads the row and books by one click, ahead of a sure read', async () => {
    const list = await propose({ company: [learned()], reads: [sureRead()] })
    expect(shape(list)).toEqual([
      ['rule', 'equipment_small'],
      ['assistant', 'assistant:tx-1'],
    ])
    expect(list[0]).toMatchObject({ rule_own: true, rule_requires_review: false, confidence: 0.95 })
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBeNull()
    // The read below it carries no mark, in the list or in the log.
    expect(list[1].replaces_learned_rule).toBeUndefined()
    expect(offeredSuggestions(list).suggestions.map((s) => [s.source, s.source_id, s.evidence])).toEqual([
      ['rule', 'equipment_small', { rule_own: true, rule_requires_review: false }],
      ['assistant', 'assistant:tx-1', { has_underlag: true }],
    ])
  })
})

describe('switch on: an auto-learned row proposes nothing', () => {
  beforeEach(() => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', COMPANY)
  })

  it('the row has no proposal from it', async () => {
    expect(await propose({ company: [learned()] })).toEqual([])
  })

  it('the read that then stands first never books by one click, and the log says why', async () => {
    const list = await propose({ company: [learned()], reads: [sureRead()] })
    expect(shape(list)).toEqual([['assistant', 'assistant:tx-1']])
    expect(list[0]).toMatchObject({ has_underlag: true, confidence: 0.9, replaces_learned_rule: true })
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBe('evidence')
    expect(offeredSuggestions(list).suggestions[0].evidence).toEqual({ has_underlag: true, replaces_learned_rule: true })
  })

  it('a sure read on a row no auto-learned row matched books by one click, as before', async () => {
    const list = await propose({ company: [learned()].map((r) => ({ ...r, merchant_pattern: 'Annan' })), reads: [sureRead()] })
    expect(shape(list)).toEqual([['assistant', 'assistant:tx-1']])
    expect(list[0].replaces_learned_rule).toBeUndefined()
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBeNull()
  })

  it('a row a person described still leads and books by one click', async () => {
    const list = await propose({ company: [learned(), described()], reads: [sureRead()] })
    expect(shape(list)).toEqual([
      ['rule', 'office_supplies_general'],
      ['assistant', 'assistant:tx-1'],
    ])
    expect(list[0]).toMatchObject({ rule_own: true, confidence: 0.98 })
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBeNull()
  })

  it('a system default still proposes, into a review', async () => {
    const list = await propose({ company: [learned()], system: [systemDefault()] })
    expect(shape(list)).toEqual([['rule', 'office_supplies_general']])
    expect(list[0].rule_own).toBe(false)
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBe('evidence')
  })

  it('another company keeps its auto-learned rows', async () => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', 'company-2')
    const list = await propose({ company: [learned()] })
    expect(shape(list)).toEqual([['rule', 'equipment_small']])
  })
})

describe('a described row beside an auto-learned one, on and off', () => {
  it.each([
    ['off', ''],
    ['on', COMPANY],
  ])('switch %s: the described row leads with the same booking', async (_label, value) => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', value)
    const list = await propose({ company: [learned(), described()] })
    expect(rowProposal(list)).toMatchObject({ source: 'rule', template_id: 'office_supplies_general', rule_own: true })
    expect(reviewReason(rowProposal(list)!, DIRECT_BOOKING_ON)).toBeNull()
  })
})
