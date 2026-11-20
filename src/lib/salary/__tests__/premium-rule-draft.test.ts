/**
 * The premium-rule editor's model: checks, request body and the live
 * example, which must be the engine's own figure (never a second copy of the
 * arithmetic).
 */
import { describe, expect, it } from 'vitest'
import {
  draftFromRule,
  emptyPremiumRuleDraft,
  parseDecimal,
  premiumRuleExample,
  premiumRuleRequestBody,
  validatePremiumRuleDraft,
  type PremiumRuleDraft,
} from '../premium-rule-draft'
import type { ShiftPremiumRule } from '@/types'

function draft(overrides: Partial<PremiumRuleDraft> = {}): PremiumRuleDraft {
  return { ...emptyPremiumRuleDraft('2026-05-01'), name: 'OB kväll', ...overrides }
}

describe('parseDecimal', () => {
  it('reads a decimal comma and refuses anything else', () => {
    expect(parseDecimal('27,59')).toBe(27.59)
    expect(parseDecimal(' 480 ')).toBe(480)
    expect(parseDecimal('1 000')).toBe(1000)
    expect(parseDecimal('27,599')).toBeNull()
    expect(parseDecimal('abc')).toBeNull()
    expect(parseDecimal('')).toBeNull()
  })
})

describe('validatePremiumRuleDraft', () => {
  it('names every missing or wrong field', () => {
    const errors = validatePremiumRuleDraft(
      draft({
        name: ' ',
        day_of_week: [],
        start_time: '25:00',
        valid_from: '',
        valid_to: '2020-01-01',
        applies_to_all_employees: false,
      }),
    )
    expect(errors).toEqual({
      name: 'name',
      day_of_week: 'days',
      start_time: 'time',
      amount: 'percent',
      valid_from: 'valid_from',
      applies_to_employee_ids: 'employees',
    })
    expect(validatePremiumRuleDraft(draft({ valid_to: '2026-04-30', amounts: { percent_of_hourly: '50', monthly_divisor: '', sek_per_hour: '' } }))).toEqual({
      valid_to: 'valid_to',
    })
  })

  it('checks the amount of the chosen form only', () => {
    const d = draft({ amount_form: 'monthly_divisor', amounts: { percent_of_hourly: 'x', monthly_divisor: '480', sek_per_hour: '' } })
    expect(validatePremiumRuleDraft(d)).toEqual({})
    expect(validatePremiumRuleDraft({ ...d, amounts: { ...d.amounts, monthly_divisor: '0' } })).toEqual({ amount: 'divisor' })
  })

  it('needs no weekday on a holiday rule', () => {
    expect(
      validatePremiumRuleDraft(
        draft({ item_type: 'ob_holiday', day_of_week: [], amounts: { percent_of_hourly: '100', monthly_divisor: '', sek_per_hour: '' } }),
      ),
    ).toEqual({})
  })
})

describe('premiumRuleRequestBody', () => {
  it('sends the chosen form and only its field', () => {
    const body = premiumRuleRequestBody(
      draft({ amount_form: 'sek_per_hour', amounts: { percent_of_hourly: '50', monthly_divisor: '480', sek_per_hour: '27,59' } }),
    )
    expect(body).toMatchObject({ amount_form: 'sek_per_hour', sek_per_hour: 27.59, valid_to: null, priority: 0 })
    expect(body).not.toHaveProperty('premium_percent')
    expect(body).not.toHaveProperty('monthly_divisor')
    expect(body).not.toHaveProperty('hourly_divisor')
  })

  it('sends every weekday for a holiday rule and maps the overlap choice', () => {
    const body = premiumRuleRequestBody(
      draft({
        item_type: 'ob_holiday',
        day_of_week: [6],
        overlap: 'first',
        amounts: { percent_of_hourly: '100', monthly_divisor: '', sek_per_hour: '' },
      }),
    )
    expect(body).toMatchObject({ day_of_week: [1, 2, 3, 4, 5, 6, 7], priority: 10, premium_percent: 100, hourly_divisor: null })
  })

  it('keeps a stored priority the editor left alone', () => {
    const rule = {
      id: 'r',
      company_id: 'c',
      name: 'OB natt',
      applies_to_all_employees: true,
      applies_to_employee_ids: [],
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '22:00:00',
      end_time: '06:00:00',
      amount_form: 'percent_of_hourly',
      premium_percent: 70,
      monthly_divisor: null,
      sek_per_hour: null,
      hourly_divisor: 166,
      valid_from: '2025-04-01',
      valid_to: null,
      item_type: 'ob_night',
      priority: 7,
      is_active: true,
      created_at: '',
      updated_at: '',
      created_by: null,
    } satisfies ShiftPremiumRule
    const body = premiumRuleRequestBody(draftFromRule(rule))
    expect(body).toMatchObject({ priority: 7, premium_percent: 70, hourly_divisor: 166, start_time: '22:00', end_time: '06:00' })
  })
})

describe('premiumRuleExample', () => {
  it('prices the Almega example through the engine: 3 h on 40 000 kr / 480 is 250 kr', () => {
    // almega_service.txt:504-505 (kvälls- och nattetid, månadslönen / 480).
    const example = premiumRuleExample(
      draft({
        start_time: '18:00',
        end_time: '06:00',
        amount_form: 'monthly_divisor',
        amounts: { percent_of_hourly: '', monthly_divisor: '480', sek_per_hour: '' },
      }),
      '2026-05-01',
    )
    expect(example).toEqual({ hours: 3, start: '18:00', end: '21:00', amount: 250, monthlySalary: 40000 })
  })

  it('needs no salary for a fixed amount, and starts at the rule validity', () => {
    // grona.txt:769-770: 27:59 kr/timme from 2026-04-01.
    const example = premiumRuleExample(
      draft({
        start_time: '20:00',
        end_time: '06:00',
        valid_from: '2026-04-01',
        amount_form: 'sek_per_hour',
        amounts: { percent_of_hourly: '', monthly_divisor: '', sek_per_hour: '27,59' },
      }),
      '2026-01-15',
    )
    expect(example).toEqual({ hours: 3, start: '20:00', end: '23:00', amount: 82.77, monthlySalary: null })
  })

  it('finds a holiday for a holiday rule and shortens to the window', () => {
    const example = premiumRuleExample(
      draft({
        item_type: 'ob_holiday',
        start_time: '10:00',
        end_time: '12:00',
        amounts: { percent_of_hourly: '100', monthly_divisor: '', sek_per_hour: '' },
      }),
      '2026-05-02',
    )
    // 40 000 / 173 = 231.21 kr per hour, 2 h at 100 %.
    expect(example).toEqual({ hours: 2, start: '10:00', end: '12:00', amount: 462.42, monthlySalary: 40000 })
  })

  it('is null for an incomplete draft or a rule that never applies', () => {
    expect(premiumRuleExample(draft(), '2026-05-01')).toBeNull()
    expect(
      premiumRuleExample(
        draft({
          valid_from: '2026-05-04',
          valid_to: '2026-05-04',
          day_of_week: [6],
          amounts: { percent_of_hourly: '50', monthly_divisor: '', sek_per_hour: '' },
        }),
        '2026-05-01',
      ),
    ).toBeNull()
  })
})
