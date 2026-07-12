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
  type AccountDimensionRule,
} from '../dimension-rules'
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
    ).toThrow('Konto 4010 kräver Projekt — välj ett värde innan bokföring.')
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
