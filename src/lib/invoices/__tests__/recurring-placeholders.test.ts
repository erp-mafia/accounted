import { describe, expect, it } from 'vitest'
import {
  RECURRING_PLACEHOLDER_KEYS,
  advancePeriodStart,
  applyRecurringPlaceholders,
  buildRecurringPlaceholderValues,
  mentionsPeriodPlaceholder,
  periodEndInclusive,
  periodPlaceholderProblem,
} from '@/lib/invoices/recurring-placeholders'

describe('recurring placeholders', () => {
  it('resolves month and year from the run date, in the customer language', () => {
    const sv = buildRecurringPlaceholderValues({ runDate: '2026-12-15', periodStart: null, intervalMonths: 1, lang: 'sv' })
    expect(sv).toMatchObject({
      'månad': 'december',
      'nästa månad': 'januari',
      'föregående månad': 'november',
      'år': '2026',
    })
    const en = buildRecurringPlaceholderValues({ runDate: '2026-01-01', periodStart: null, intervalMonths: 1, lang: 'en' })
    expect(en).toMatchObject({ 'månad': 'January', 'nästa månad': 'February', 'föregående månad': 'December' })
  })

  it('substitutes the user example and leaves unknown keys and case alone', () => {
    const values = buildRecurringPlaceholderValues({ runDate: '2026-10-05', periodStart: null, intervalMonths: 1, lang: 'sv' })
    expect(applyRecurringPlaceholders('Fakturan avser {månad} och {nästa månad}.', values))
      .toBe('Fakturan avser oktober och november.')
    expect(applyRecurringPlaceholders('{Månad} {ÅR} { nästa månad } {okänd}', values))
      .toBe('oktober 2026 november {okänd}')
    expect(applyRecurringPlaceholders(null, values)).toBeNull()
    expect(applyRecurringPlaceholders(undefined, values)).toBeUndefined()
  })

  it('renders the period from period_start and the interval', () => {
    const values = buildRecurringPlaceholderValues({ runDate: '2026-10-01', periodStart: '2026-10-01', intervalMonths: 12, lang: 'sv' })
    expect(applyRecurringPlaceholders('Fakturaperioden avser {periodstart} - {periodslut} (nästa: {nästa periodstart})', values))
      .toBe('Fakturaperioden avser 2026-10-01 - 2027-09-30 (nästa: 2027-10-01)')
  })

  it('leaves the period keys untouched when the schedule has no period', () => {
    const values = buildRecurringPlaceholderValues({ runDate: '2026-10-01', periodStart: null, intervalMonths: 1, lang: 'sv' })
    expect(applyRecurringPlaceholders('{periodstart}', values)).toBe('{periodstart}')
  })

  it('advances the period on the month grid and clamps the day', () => {
    expect(advancePeriodStart('2026-10-01', 1)).toBe('2026-11-01')
    expect(advancePeriodStart('2026-10-01', 12)).toBe('2027-10-01')
    expect(advancePeriodStart('2026-01-31', 1)).toBe('2026-02-28')
    expect(advancePeriodStart('2026-11-30', 3)).toBe('2027-02-28')
    expect(periodEndInclusive('2026-02-01', 1)).toBe('2026-02-28')
    expect(periodEndInclusive('2026-01-15', 1)).toBe('2026-02-14')
  })

  it('detects period placeholders regardless of spacing and case', () => {
    expect(mentionsPeriodPlaceholder(['Period: {periodstart}'])).toBe(true)
    expect(mentionsPeriodPlaceholder(['{ Nästa   Periodstart }'])).toBe(true)
    expect(mentionsPeriodPlaceholder(['{månad} {år}', null, undefined])).toBe(false)
    expect(periodPlaceholderProblem({ notes: '{periodslut}', itemDescriptions: [], periodStart: null })).toMatch(/Periodstart/)
    expect(periodPlaceholderProblem({ notes: '{periodslut}', itemDescriptions: [], periodStart: '2026-01-01' })).toBeNull()
    expect(periodPlaceholderProblem({ notes: null, itemDescriptions: ['{periodstart}'], periodStart: '' })).not.toBeNull()
  })

  it('exposes every key the dialog legend prints', () => {
    const values = buildRecurringPlaceholderValues({ runDate: '2026-03-01', periodStart: '2026-03-01', intervalMonths: 1, lang: 'sv' })
    for (const key of RECURRING_PLACEHOLDER_KEYS) expect(values[key]).toBeDefined()
  })
})
