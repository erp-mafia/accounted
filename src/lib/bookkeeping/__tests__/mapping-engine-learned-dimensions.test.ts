/**
 * A mapping rule wins the accounts; the counterparty template still lends its
 * learned dimensions (dimensions D6).
 *
 * Every business categorize writes a 'Learned: <merchant>' mapping rule, and
 * rules are evaluated before counterparty templates, so for a known merchant
 * the template (the one place the company's kostnadsställe/projekt habit is
 * learned) was never read and its bag was never proposed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { CategorizationTemplate } from '@/types'

const { findTemplate } = vi.hoisted(() => ({ findTemplate: vi.fn() }))
vi.mock('../counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('../counterparty-templates')>()),
  findCounterpartyTemplate: (...args: unknown[]) => findTemplate(...args),
}))

import { evaluateMappingRules } from '../mapping-engine'
import { buildTransactionEntryLines } from '../transaction-entries'

function learnedRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    company_id: 'company-1',
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
    ...overrides,
  }
}

function learnedTemplate(overrides: Partial<CategorizationTemplate> = {}) {
  return makeCategorizationTemplate({
    counterparty_name: 'clas ohlson',
    debit_account: '5410',
    credit_account: '1930',
    vat_treatment: null,
    confidence: 0.9,
    source: 'user_approved',
    default_dimensions: { '6': 'P001' },
    ...overrides,
  })
}

const expense = makeTransaction({ amount: -299, merchant_name: 'Clas Ohlson', counterparty_iban: null })

async function evaluate(tx = expense, rule = learnedRule()) {
  const { supabase } = createTableMockSupabase({ mapping_rules: { data: [rule] } })
  return evaluateMappingRules(supabase as never, 'company-1', tx, 'aktiebolag')
}

beforeEach(() => {
  vi.clearAllMocks()
  findTemplate.mockResolvedValue(null)
})

describe('evaluateMappingRules: a matched rule takes the learned bag of the template on its account', () => {
  it('the rule books the accounts and the template\'s bag tags its business line', async () => {
    findTemplate.mockResolvedValue({ template: learnedTemplate(), matchMethod: 'exact_alias', confidence: 0.9 })

    const result = await evaluate()

    expect(result.rule?.id).toBe('rule-1')
    expect(result.debit_account).toBe('5410')
    expect(result.dimensions).toEqual({ '6': 'P001' })
    const lines = buildTransactionEntryLines(expense, result)
    expect(lines.find((l) => l.account_number === '5410')?.dimensions).toEqual({ '6': 'P001' })
    expect(lines.find((l) => l.account_number === '1930')?.dimensions).toBeUndefined()
  })

  it('a multi-line template lends the bag of its business line on the rule\'s account', async () => {
    findTemplate.mockResolvedValue({
      template: learnedTemplate({
        default_dimensions: {},
        line_pattern: [
          { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
          { account: '5410', type: 'business', side: 'debit', ratio: 1, dimensions: { '1': 'KS01' } },
        ],
      }),
      matchMethod: 'exact_alias',
      confidence: 0.9,
    })

    expect((await evaluate()).dimensions).toEqual({ '1': 'KS01' })
  })

  it('lends nothing when the template books another account', async () => {
    findTemplate.mockResolvedValue({
      template: learnedTemplate({ debit_account: '6110' }),
      matchMethod: 'exact_alias',
      confidence: 0.9,
    })

    expect((await evaluate()).dimensions).toBeUndefined()
  })

  it('lends nothing from a template under its own confidence bar', async () => {
    findTemplate.mockResolvedValue({
      template: learnedTemplate({ source: 'auto_learned' }),
      matchMethod: 'fuzzy',
      confidence: 0.5,
    })

    expect((await evaluate()).dimensions).toBeUndefined()
  })

  it('lends nothing to money flowing the other way (a refund mirrors the template)', async () => {
    findTemplate.mockResolvedValue({ template: learnedTemplate(), matchMethod: 'exact_alias', confidence: 0.9 })
    const refund = makeTransaction({ amount: 299, merchant_name: 'Clas Ohlson', counterparty_iban: null })

    expect((await evaluate(refund, learnedRule({ debit_account: '1930', credit_account: '5410' }))).dimensions).toBeUndefined()
  })

  it('never looks for a bag behind a private rule', async () => {
    const result = await evaluate(expense, learnedRule({ default_private: true }))

    expect(result.dimensions).toBeUndefined()
    expect(findTemplate).not.toHaveBeenCalled()
  })

  it('a rule without a matching template is unchanged', async () => {
    const result = await evaluate()

    expect(result.debit_account).toBe('5410')
    expect(result).not.toHaveProperty('dimensions')
  })
})
