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
  mappingRulesBesideSwitchedOff,
  mappingRulesRead,
  readsAutoLearnedMappingRules,
  saveUserMappingRule,
} from '../mapping-engine'
import { readSwitchedOffRulesByName, upsertCounterpartyTemplate, type SwitchedOffCounterpartyRule } from '../counterparty-templates'

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

/** switchedOff: the counterparty rules the company switched off (categorization_templates, is_active false). */
async function evaluate(rules: unknown[], switchedOff: unknown[] = []) {
  const { supabase, findCalls, tables } = createTableMockSupabase({
    mapping_rules: { data: rules },
    categorization_templates: { data: switchedOff, error: null },
  })
  return Object.assign(await evaluateMappingRules(supabase as never, COMPANY, expense, 'aktiebolag'), { findCalls, tables })
}

/** The counterparty rule the booking learned beside the auto-learned row, paused in Regler after it. */
const pausedRule = (counterparty = 'clas ohlson') =>
  makeCategorizationTemplate({
    counterparty_name: counterparty,
    counterparty_aliases: [counterparty],
    debit_account: '5410',
    mode: 'paused',
    is_active: false,
    paused_at: '2026-06-01T00:00:00+00:00',
  })

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

describe('mappingRulesBesideSwitchedOff', () => {
  const stored = () => [described(), learned(), systemDefault()]
  const ids = (rules: MappingRule[]) => rules.map((r) => r.id)
  /** Switched-off rules by name; by default money out (D 5410 / K 1930), as the learned row. */
  const off = (names: string[], over: Partial<SwitchedOffCounterpartyRule> = {}) =>
    new Map(names.map((name) => [name, [{ debit_account: '5410', credit_account: '1930', ...over }]]))

  it('no switched-off rule: every rule it was handed, in order', () => {
    expect(ids(mappingRulesBesideSwitchedOff(stored(), new Map()))).toEqual(['rule-described', 'rule-learned', 'rule-system'])
  })

  it('a switched-off rule named by the learned text silences the learned row, and nothing else', () => {
    expect(ids(mappingRulesBesideSwitchedOff(stored(), off(['clas ohlson'])))).toEqual(['rule-described', 'rule-system'])
  })

  it('reads the learned pattern back as the text it was learned from, and normalizes it as a key', () => {
    const card = rule({ id: 'rule-card', merchant_pattern: 'KORT             FACEBK \\*27MAE32 71' })
    expect(ids(mappingRulesBesideSwitchedOff([card], off(['kort             facebk *27mae32 71'])))).toEqual([])
    const shop = rule({ id: 'rule-shop', merchant_pattern: 'Shop payout AB' })
    expect(ids(mappingRulesBesideSwitchedOff([shop], off(['shop payout'])))).toEqual([])
  })

  it('a switched-off rule of a near name silences nothing: the link is the name, never a fuzzy match', () => {
    const telia = rule({ id: 'rule-telia', merchant_pattern: 'TELIA' })
    expect(ids(mappingRulesBesideSwitchedOff([telia], off(['tele2'])))).toEqual(['rule-telia'])
  })

  it('a row learned from a booking by hand after the pause is silenced too, while the rule shows as paused', () => {
    const rebooked = rule({ id: 'rule-rebooked', created_at: '2026-07-01T00:00:00+00:00' })
    expect(ids(mappingRulesBesideSwitchedOff([learned(), rebooked], off(['clas ohlson'])))).toEqual([])
  })

  it('a rule switched off on one direction leaves the row learned the other way round', () => {
    const payout = rule({ id: 'rule-payout', debit_account: '1930', credit_account: '3001' })
    expect(ids(mappingRulesBesideSwitchedOff([learned(), payout], off(['clas ohlson'])))).toEqual(['rule-payout'])
    expect(ids(mappingRulesBesideSwitchedOff([learned(), payout], off(['clas ohlson'], { debit_account: '1930', credit_account: '3001' })))).toEqual(['rule-learned'])
  })
})

describe('the link, from what the two writers store for one booking', () => {
  it('the counterparty rule and the learned row of one booking are linked, and a pause silences the row', async () => {
    const payout = makeTransaction({ amount: 8180.1, merchant_name: 'Shop payout', description: 'Shop payout 000123', original_description: 'Shop payout 000123' })
    const written = createTableMockSupabase({ categorization_templates: { data: null, error: null } })
    await saveUserMappingRule(written.supabase as never, COMPANY, 'Shop payout', '1930', '3001', false)
    await upsertCounterpartyTemplate(written.supabase as never, COMPANY, payout, { debit_account: '1930', credit_account: '3001', vat_lines: [], confidence: 1, requires_review: false } as never, 'user_approved')
    const [learnedRow] = written.payloads('mapping_rules', 'insert') as Record<string, unknown>[]
    const [template] = written.payloads('categorization_templates', 'insert') as Record<string, unknown>[]
    expect(template).toBeDefined()

    // The rule as the table holds it once paused, read back by name.
    const read = createTableMockSupabase({
      categorization_templates: { data: [{ id: 'tpl-1', ...template, is_active: false, paused_at: '2026-06-01T00:00:00+00:00' }], error: null },
    })
    const byName = await readSwitchedOffRulesByName(read.supabase as never, COMPANY)
    const row = rule({ ...(learnedRow as Partial<MappingRule>), id: 'rule-learned' })
    expect(mappingRulesBesideSwitchedOff([row], byName)).toEqual([])
  })
})

describe('evaluateMappingRules: a counterparty rule the company paused', () => {
  it('silences the auto-learned row, and the row falls through to the later steps', async () => {
    const result = await evaluate([learned()], [pausedRule()])
    expect(result.rule).toBeNull()
    expect(result.requires_review).toBe(true)
    expect(result.findCalls('categorization_templates', 'eq')).toEqual([['company_id', COMPANY], ['is_active', false]])
  })

  it('a paused rule of another counterparty silences nothing', async () => {
    const result = await evaluate([learned()], [pausedRule('sydkraft')])
    expect(result.rule?.id).toBe('rule-learned')
  })

  it('a described row still answers, and the switched-off rules are not read for it', async () => {
    const result = await evaluate([described(), learned()], [pausedRule()])
    expect(result.rule?.id).toBe('rule-described')
    expect(result.tables()).not.toContain('categorization_templates')
  })
})
