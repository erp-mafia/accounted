/**
 * Auto-learned mapping rows ("Learned: <merchant>", source 'auto') and the
 * company switch BOOKING_PRECEDENT_COMPANY_IDS: off, every row is written and
 * read as before; on, no booking writes one and evaluateMappingRules reads
 * none, while a row a person described and the system defaults stay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { MappingRule } from '@/types'

const { findTemplate } = vi.hoisted(() => ({ findTemplate: vi.fn() }))
vi.mock('../counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('../counterparty-templates')>()),
  findCounterpartyTemplate: (...args: unknown[]) => findTemplate(...args),
}))

import {
  AUTO_LEARNED_MAPPING_SOURCE,
  evaluateMappingRules,
  isAutoLearnedMappingRule,
  mappingRulesRead,
  readsAutoLearnedMappingRules,
  saveUserMappingRule,
} from '../mapping-engine'

const COMPANY = 'company-1'
const OTHER = 'company-2'

function rule(overrides: Partial<MappingRule> = {}): MappingRule {
  return {
    id: 'rule-learned',
    user_id: null,
    company_id: COMPANY,
    rule_name: 'Learned: Clas Ohlson',
    rule_type: 'merchant_name',
    priority: 10,
    mcc_codes: null,
    merchant_pattern: 'Clas Ohlson',
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
    rule_name: 'Described: Clas Ohlson',
    priority: 5,
    debit_account: '6110',
    confidence_score: 0.98,
    source: 'user_description',
    user_description: 'kontorsmaterial',
  })
const systemDefault = () =>
  rule({ id: 'rule-system', company_id: null, rule_name: 'System: hardware', priority: 80, debit_account: '5460' })

const expense = makeTransaction({ amount: -299, merchant_name: 'Clas Ohlson', counterparty_iban: null })

const switchOn = (company = COMPANY) => vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', company)

async function evaluate(rules: unknown[]) {
  const { supabase } = createTableMockSupabase({ mapping_rules: { data: rules } })
  return evaluateMappingRules(supabase as never, COMPANY, expense, 'aktiebolag')
}

beforeEach(() => {
  vi.clearAllMocks()
  findTemplate.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isAutoLearnedMappingRule', () => {
  it('is a company row with the auto-learned source, never a described row or a system default', () => {
    expect(AUTO_LEARNED_MAPPING_SOURCE).toBe('auto')
    expect(isAutoLearnedMappingRule(learned())).toBe(true)
    expect(isAutoLearnedMappingRule(described())).toBe(false)
    // A system default keeps the column's default source and is still not one.
    expect(isAutoLearnedMappingRule(systemDefault())).toBe(false)
  })
})

describe('mappingRulesRead', () => {
  const stored = () => [described(), learned(), systemDefault()]

  it('switch off: hands back every row, in order', () => {
    expect(readsAutoLearnedMappingRules(COMPANY)).toBe(true)
    expect(mappingRulesRead(COMPANY, stored()).map((r) => r.id)).toEqual(['rule-described', 'rule-learned', 'rule-system'])
  })

  it('switch on: leaves out the auto-learned rows of the company and nothing else', () => {
    switchOn()
    expect(readsAutoLearnedMappingRules(COMPANY)).toBe(false)
    expect(mappingRulesRead(COMPANY, stored()).map((r) => r.id)).toEqual(['rule-described', 'rule-system'])
  })

  it('the switch of one company leaves another company as it was', () => {
    switchOn(OTHER)
    expect(readsAutoLearnedMappingRules(COMPANY)).toBe(true)
    expect(mappingRulesRead(COMPANY, stored())).toHaveLength(3)
  })
})

describe('saveUserMappingRule', () => {
  it('switch off: a booking without a description writes the auto-learned row', async () => {
    const { supabase, payloads } = createTableMockSupabase()
    await saveUserMappingRule(supabase as never, COMPANY, 'Clas Ohlson', '5410', '1930', false)
    expect(payloads('mapping_rules', 'insert')).toEqual([
      expect.objectContaining({ company_id: COMPANY, rule_name: 'Learned: Clas Ohlson', source: 'auto', priority: 10, confidence_score: 0.95 }),
    ])
  })

  it('switch on: a booking without a description writes nothing and deletes nothing', async () => {
    switchOn()
    const { supabase, tables } = createTableMockSupabase()
    await saveUserMappingRule(supabase as never, COMPANY, 'Clas Ohlson', '5410', '1930', false)
    expect(tables()).toEqual([])
  })

  it('switch on: a described rule is still saved, replacing the earlier description', async () => {
    switchOn()
    const { supabase, payloads, findCalls } = createTableMockSupabase()
    await saveUserMappingRule(supabase as never, COMPANY, 'Clas Ohlson', '6110', '1930', false, 'kontorsmaterial', 'office_supplies')
    expect(findCalls('mapping_rules', 'delete')).toHaveLength(1)
    expect(findCalls('mapping_rules', 'eq')).toContainEqual(['source', 'user_description'])
    expect(payloads('mapping_rules', 'insert')).toEqual([
      expect.objectContaining({ rule_name: 'Described: Clas Ohlson', source: 'user_description', priority: 5, template_id: 'office_supplies' }),
    ])
  })
})

describe('evaluateMappingRules: its first step', () => {
  it('switch off: the auto-learned row books the row, as before', async () => {
    const result = await evaluate([learned()])
    expect(result.rule?.id).toBe('rule-learned')
    expect(result.debit_account).toBe('5410')
  })

  it('switch on: the auto-learned row is not read, and the row falls through to the later steps', async () => {
    switchOn()
    const result = await evaluate([learned()])
    expect(result.rule).toBeNull()
    expect(result.confidence).toBe(0.1)
    expect(result.requires_review).toBe(true)
  })

  it('switch on: the counterparty rule answers where the auto-learned row used to', async () => {
    switchOn()
    findTemplate.mockResolvedValue({
      template: makeCategorizationTemplate({ counterparty_name: 'clas ohlson', debit_account: '6110', vat_treatment: null, confidence: 0.9 }),
      matchMethod: 'exact_alias',
      confidence: 0.9,
    })
    const result = await evaluate([learned()])
    expect(result.rule).toBeNull()
    expect(result.debit_account).toBe('6110')
  })

  it.each([
    ['off', false],
    ['on', true],
  ])('switch %s: a described row answers first, before a counterparty rule', async (_label, on) => {
    if (on) switchOn()
    findTemplate.mockResolvedValue({
      template: makeCategorizationTemplate({ counterparty_name: 'clas ohlson', debit_account: '5460', vat_treatment: null, confidence: 0.9 }),
      matchMethod: 'exact_alias',
      confidence: 0.9,
    })
    const result = await evaluate([described(), learned()])
    expect(result.rule?.id).toBe('rule-described')
    expect(result.debit_account).toBe('6110')
  })

  it.each([
    ['off', false],
    ['on', true],
  ])('switch %s: a system default still answers', async (_label, on) => {
    if (on) switchOn()
    const result = await evaluate([systemDefault()])
    expect(result.rule?.id).toBe('rule-system')
    expect(result.debit_account).toBe('5460')
  })
})
