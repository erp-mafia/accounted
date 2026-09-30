/**
 * Pure-function tests for the account dimension rule layer (dimensions PR10).
 *
 * applyDimensionRules: 'default' fills only absent bag keys, 'fixed' always
 * overwrites (including alias-sourced values, with the deprecated aliases
 * cleared on changed lines), and the zero-effect paths preserve array/line
 * identity so the common rule-less booking allocates nothing.
 *
 * assertMandatoryDimensions: throws MandatoryDimensionMissingError with one
 * violation per (account, dimension) regardless of line count, treats
 * alias-sourced values as satisfying (normalize folds them into the bag),
 * and no-ops when no 'required' rule exists.
 */
import { describe, it, expect } from 'vitest'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  DIMENSION_RULE_EXEMPT_SOURCE_TYPES,
  DIMENSION_RULE_POLICY,
  DIMENSION_VALIDATION_EXEMPT_SOURCE_TYPES,
  isDimensionRuleExemptSource,
  isDimensionValidationExemptSource,
  type AccountDimensionRule,
} from '../dimension-rules'
import {
  API_VOUCHER_SOURCE_TYPES,
  CreateApiJournalEntrySchema,
  DASHBOARD_VOUCHER_SOURCE_TYPES,
  JournalEntrySourceTypeSchema,
} from '@/lib/api/schemas'
import {
  MANDATORY_DIMENSION_MISSING,
  MandatoryDimensionMissingError,
} from '../dimension-errors'

interface TestLine {
  account_number: string
  dimensions?: Record<string, string> | null
  cost_center?: string | null
  project?: string | null
}

function makeRule(overrides: Partial<AccountDimensionRule> = {}): AccountDimensionRule {
  return {
    account_number: '4010',
    rule_type: 'default',
    sie_dim_no: '6',
    dimension_name: 'Projekt',
    value_code: 'P001',
    ...overrides,
  }
}

describe('applyDimensionRules', () => {
  it('default fills only absent keys — caller-set keys win', () => {
    const lines: TestLine[] = [
      { account_number: '4010', dimensions: { '6': 'CALLER' } },
    ]
    const rules = [
      makeRule({ rule_type: 'default', sie_dim_no: '6', value_code: 'PDEF' }),
      makeRule({
        rule_type: 'default',
        sie_dim_no: '1',
        dimension_name: 'Kostnadsställe',
        value_code: 'KS01',
      }),
    ]

    const out = applyDimensionRules(lines, rules)

    // Absent key '1' filled; present key '6' untouched.
    expect(out[0].dimensions).toEqual({ '6': 'CALLER', '1': 'KS01' })
    // The input line object was not mutated.
    expect(lines[0].dimensions).toEqual({ '6': 'CALLER' })
  })

  it('default does not override an alias-sourced value (line identity preserved)', () => {
    const lines: TestLine[] = [{ account_number: '4010', cost_center: 'KS-ALIAS' }]
    const rules = [
      makeRule({
        rule_type: 'default',
        sie_dim_no: '1',
        dimension_name: 'Kostnadsställe',
        value_code: 'KS99',
      }),
    ]

    // normalize folds cost_center into key '1', so the default has nothing to
    // fill — nothing applies and the SAME array comes back.
    expect(applyDimensionRules(lines, rules)).toBe(lines)
    expect(lines[0].cost_center).toBe('KS-ALIAS')
  })

  it('fixed overwrites an alias-sourced value and clears the aliases', () => {
    const lines: TestLine[] = [{ account_number: '4010', cost_center: 'OLD' }]
    const rules = [
      makeRule({
        rule_type: 'fixed',
        sie_dim_no: '1',
        dimension_name: 'Kostnadsställe',
        value_code: 'KS99',
      }),
    ]

    const out = applyDimensionRules(lines, rules)

    expect(out[0].dimensions).toEqual({ '1': 'KS99' })
    // Aliases nulled so downstream normalization cannot resurrect 'OLD'.
    expect(out[0].cost_center).toBeNull()
    expect(out[0].project).toBeNull()
  })

  it('fixed overwrites a caller-supplied bag value', () => {
    const lines: TestLine[] = [{ account_number: '4010', dimensions: { '6': 'CALLER' } }]
    const rules = [makeRule({ rule_type: 'fixed', sie_dim_no: '6', value_code: 'PLOCK' })]

    const out = applyDimensionRules(lines, rules)

    expect(out[0].dimensions).toEqual({ '6': 'PLOCK' })
  })

  it('a fixed rule already satisfied is a no-op — same array identity', () => {
    const lines: TestLine[] = [{ account_number: '4010', dimensions: { '6': 'P001' } }]
    const rules = [makeRule({ rule_type: 'fixed', sie_dim_no: '6', value_code: 'P001' })]

    expect(applyDimensionRules(lines, rules)).toBe(lines)
  })

  it('untouched lines keep identity while changed lines are copied', () => {
    const lines: TestLine[] = [
      { account_number: '4010' },
      { account_number: '1930', dimensions: { '1': 'KS01' } },
    ]
    const rules = [makeRule({ rule_type: 'fixed', sie_dim_no: '6', value_code: 'P001' })]

    const out = applyDimensionRules(lines, rules)

    expect(out).not.toBe(lines)
    expect(out[0]).not.toBe(lines[0])
    expect(out[0].dimensions).toEqual({ '6': 'P001' })
    // The 1930 line has no rule — the exact same object rides through.
    expect(out[1]).toBe(lines[1])
  })

  it('returns the same array for zero rules and for required-only rules', () => {
    const lines: TestLine[] = [{ account_number: '4010' }]

    expect(applyDimensionRules(lines, [])).toBe(lines)
    // 'required' rules carry no value — they never apply at draft time.
    expect(
      applyDimensionRules(lines, [
        makeRule({ rule_type: 'required', value_code: null }),
      ]),
    ).toBe(lines)
  })

  it('rules for other accounts do not leak onto unrelated lines', () => {
    const lines: TestLine[] = [{ account_number: '4010' }]
    const rules = [
      makeRule({ account_number: '5010', rule_type: 'fixed', value_code: 'P001' }),
      makeRule({ account_number: '5010', rule_type: 'default', value_code: 'P002' }),
    ]

    expect(applyDimensionRules(lines, rules)).toBe(lines)
    expect(lines[0].dimensions).toBeUndefined()
  })
})

describe('assertMandatoryDimensions', () => {
  const requiredProjekt = makeRule({ rule_type: 'required', value_code: null })

  it('throws with one deduped violation across multiple missing lines', () => {
    const lines: TestLine[] = [
      { account_number: '4010', dimensions: {} },
      { account_number: '4010' },
      { account_number: '1930' },
    ]

    let caught: unknown
    try {
      assertMandatoryDimensions(lines, [requiredProjekt])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(MandatoryDimensionMissingError)
    const error = caught as MandatoryDimensionMissingError
    expect(error.code).toBe(MANDATORY_DIMENSION_MISSING)
    // Two 4010 lines miss the same rule → ONE violation, not two.
    expect(error.violations).toEqual([
      { account_number: '4010', sie_dim_no: '6', dimension_name: 'Projekt' },
    ])
  })

  it('reports one violation per (account, dimension) pair', () => {
    const lines: TestLine[] = [
      { account_number: '4010' },
      { account_number: '5010' },
    ]
    const rules = [
      requiredProjekt,
      makeRule({
        account_number: '5010',
        rule_type: 'required',
        sie_dim_no: '1',
        dimension_name: 'Kostnadsställe',
        value_code: null,
      }),
    ]

    let caught: unknown
    try {
      assertMandatoryDimensions(lines, rules)
    } catch (err) {
      caught = err
    }

    const error = caught as MandatoryDimensionMissingError
    expect(error.violations).toEqual([
      { account_number: '4010', sie_dim_no: '6', dimension_name: 'Projekt' },
      { account_number: '5010', sie_dim_no: '1', dimension_name: 'Kostnadsställe' },
    ])
  })

  it('uses the Swedish message format naming account and dimension', () => {
    expect(() =>
      assertMandatoryDimensions([{ account_number: '4010' }], [requiredProjekt]),
    ).toThrow('Konto 4010 kräver Projekt: välj ett värde innan bokföring.')
  })

  it('is satisfied via the deprecated cost_center alias through normalize', () => {
    const requiredKostnadsstalle = makeRule({
      rule_type: 'required',
      sie_dim_no: '1',
      dimension_name: 'Kostnadsställe',
      value_code: null,
    })
    const lines: TestLine[] = [{ account_number: '4010', cost_center: 'KS01' }]

    expect(() => assertMandatoryDimensions(lines, [requiredKostnadsstalle])).not.toThrow()
  })

  it('is satisfied by a bag value on the required key', () => {
    const lines: TestLine[] = [{ account_number: '4010', dimensions: { '6': 'P001' } }]

    expect(() => assertMandatoryDimensions(lines, [requiredProjekt])).not.toThrow()
  })

  it('never throws when no required rule exists (default/fixed only)', () => {
    const lines: TestLine[] = [{ account_number: '4010' }]
    const rules = [
      makeRule({ rule_type: 'default' }),
      makeRule({ rule_type: 'fixed', sie_dim_no: '1', value_code: 'KS01' }),
    ]

    expect(() => assertMandatoryDimensions(lines, rules)).not.toThrow()
    expect(() => assertMandatoryDimensions(lines, [])).not.toThrow()
  })

  it('required rules on other accounts do not fire', () => {
    const lines: TestLine[] = [{ account_number: '4010' }]
    const rules = [makeRule({ account_number: '5010', rule_type: 'required', value_code: null })]

    expect(() => assertMandatoryDimensions(lines, rules)).not.toThrow()
  })
})

/**
 * The source-type policy is a closed classification: every value of the
 * journal source_type enum sits in exactly one bucket, and the lists below
 * are the spec. A new source type fails here (and in the typecheck, through
 * the Record in dimension-rules.ts) until someone decides whether a user can
 * tag the lines it books.
 */
describe('dimension rule policy per source type', () => {
  const ENFORCED = [
    'manual',
    'bank_transaction',
    'inbox_item',
    'invoice_created',
    'invoice_paid',
    'invoice_cash_payment',
    'supplier_invoice_registered',
    'supplier_invoice_paid',
    'supplier_invoice_cash_payment',
    'supplier_invoice_privately_paid',
    'salary_payment',
    'webshop_order',
    'expense_claim',
    'reminder_fee',
  ]
  const EXEMPT = [
    'opening_balance',
    'import',
    'year_end',
    'result_appropriation',
    'currency_revaluation',
    'storno',
    'correction',
    'credit_note',
    'supplier_credit_note',
    'system',
    'accrual',
    'vat_settlement',
    'rot_rut_payout',
    'rot_rut_reclaim',
    'expense_payout',
    'stripe_payout',
  ]

  it('classifies every source type of the enum into exactly one bucket', () => {
    const all = [...JournalEntrySourceTypeSchema.options].sort()
    expect([...ENFORCED, ...EXEMPT].sort()).toEqual(all)
    expect(ENFORCED.filter((t) => EXEMPT.includes(t))).toEqual([])
    expect(Object.keys(DIMENSION_RULE_POLICY).sort()).toEqual(all)
  })

  it('exempts exactly the exempt bucket from rules', () => {
    for (const sourceType of ENFORCED) {
      expect(isDimensionRuleExemptSource(sourceType), sourceType).toBe(false)
    }
    for (const sourceType of EXEMPT) {
      expect(isDimensionRuleExemptSource(sourceType), sourceType).toBe(true)
    }
    expect([...DIMENSION_RULE_EXEMPT_SOURCE_TYPES].sort()).toEqual([...EXEMPT].sort())
    // Unknown or missing source types are never exempt: the engine enforces.
    expect(isDimensionRuleExemptSource(undefined)).toBe(false)
    expect(isDimensionRuleExemptSource(null)).toBe(false)
    expect(isDimensionRuleExemptSource('not_a_source_type')).toBe(false)
  })

  it('exempts accrual dissolutions from rules, not only from registry validation', () => {
    expect(isDimensionRuleExemptSource('accrual')).toBe(true)
    expect(isDimensionValidationExemptSource('accrual')).toBe(true)
  })

  it('lets a caller claim no exemption through a generic voucher door beyond the documented label', () => {
    // The caller-authorable labels of the generic create doors (v1 POST and
    // batch-create, the dashboard route). A caller never picks a
    // validation-exempt label, and the only rule-exempt one per door is the
    // documented, truthful case: 'import' for replayed history over the API,
    // 'vat_settlement' for the reviewed momsredovisning in the dashboard.
    for (const doorTypes of [API_VOUCHER_SOURCE_TYPES, DASHBOARD_VOUCHER_SOURCE_TYPES]) {
      for (const sourceType of doorTypes) {
        expect(JournalEntrySourceTypeSchema.options, sourceType).toContain(sourceType)
        expect(isDimensionValidationExemptSource(sourceType), sourceType).toBe(false)
      }
    }
    expect(API_VOUCHER_SOURCE_TYPES.filter((t) => isDimensionRuleExemptSource(t))).toEqual(['import'])
    expect(DASHBOARD_VOUCHER_SOURCE_TYPES.filter((t) => isDimensionRuleExemptSource(t))).toEqual([
      'vat_settlement',
    ])
  })

  it('opens the v1 voucher doors to exactly the enforced source types plus import', () => {
    // Classified once in DIMENSION_RULE_POLICY, followed by the API: a new
    // enforced type becomes postable, a new exempt type is refused.
    const body = (sourceType: string) => ({
      fiscal_period_id: '550e8400-e29b-41d4-a716-446655440000',
      entry_date: '2026-05-12',
      description: 'Verifikat',
      source_type: sourceType,
      lines: [
        { account_number: '6570', debit_amount: 50, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 50 },
      ],
    })
    const accepted = JournalEntrySourceTypeSchema.options.filter(
      (sourceType) => CreateApiJournalEntrySchema.safeParse(body(sourceType)).success
    )
    expect([...accepted].sort()).toEqual([...ENFORCED, 'import'].sort())
    expect([...API_VOUCHER_SOURCE_TYPES].sort()).toEqual([...ENFORCED, 'import'].sort())
  })

  it('keeps the registry-validation exemption a narrow subset of the rule exemption', () => {
    expect([...DIMENSION_VALIDATION_EXEMPT_SOURCE_TYPES]).toEqual(['accrual'])
    for (const sourceType of DIMENSION_VALIDATION_EXEMPT_SOURCE_TYPES) {
      expect(DIMENSION_RULE_EXEMPT_SOURCE_TYPES.has(sourceType), sourceType).toBe(true)
    }
  })
})
