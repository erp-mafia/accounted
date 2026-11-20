import { describe, it, expect } from 'vitest'
import {
  parseStoredRangeChoice,
  resolvePreset,
  restoreRangeChoice,
  serializeRangeChoice,
} from '../report-range-preset'

const FY_2026 = { periodStart: '2026-01-01', periodEnd: '2026-12-31' }
const context = { ...FY_2026, defaultPreset: 'ytd' as const, today: '2026-10-06' }
const YTD = { fromDate: '2026-01-01', toDate: '2026-10-06' }

describe('restoreRangeChoice', () => {
  it('restores a saved custom range with its dates, so a remount applies it instead of the whole year', () => {
    const raw = serializeRangeChoice({ preset: 'custom', fromDate: '2026-03-01', toDate: '2026-06-30' })

    expect(restoreRangeChoice(raw, context)).toEqual({
      preset: 'custom',
      value: { fromDate: '2026-03-01', toDate: '2026-06-30' },
    })
  })

  it('restores a saved preset by resolving it against the current period', () => {
    const raw = serializeRangeChoice({ preset: 'this_quarter' })

    expect(restoreRangeChoice(raw, context)).toEqual({
      preset: 'this_quarter',
      value: { fromDate: '2026-10-01', toDate: '2026-12-31' },
    })
    expect(restoreRangeChoice(serializeRangeChoice({ preset: 'full_year' }), context)).toEqual({
      preset: 'full_year',
      value: {},
    })
  })

  it('still reads a bare preset name stored by earlier builds', () => {
    expect(restoreRangeChoice('last_month', context)).toEqual({
      preset: 'last_month',
      value: { fromDate: '2026-09-01', toDate: '2026-09-30' },
    })
  })

  it('falls back to the default when a custom range belongs to another fiscal year', () => {
    const raw = serializeRangeChoice({ preset: 'custom', fromDate: '2025-03-01', toDate: '2025-06-30' })

    expect(restoreRangeChoice(raw, context)).toEqual({ preset: 'ytd', value: YTD })
  })

  it('falls back to the default when a custom range only partly fits the period', () => {
    const raw = serializeRangeChoice({ preset: 'custom', fromDate: '2025-12-01', toDate: '2026-02-28' })

    expect(restoreRangeChoice(raw, context)).toEqual({ preset: 'ytd', value: YTD })
  })

  it.each([
    ['nothing stored', null],
    ['an empty string', ''],
    ['the bare custom earlier builds wrote, which has no dates', 'custom'],
    ['an unknown preset', 'next_decade'],
    ['broken JSON', '{"preset":"custom","fromDate":'],
    ['JSON that is not an object', '42'],
    ['a custom range missing a bound', '{"preset":"custom","fromDate":"2026-03-01"}'],
    ['a custom range with a date that does not exist', '{"preset":"custom","fromDate":"2026-02-31","toDate":"2026-06-30"}'],
    ['a custom range with a non-ISO date', '{"preset":"custom","fromDate":"01/03/2026","toDate":"2026-06-30"}'],
    ['a custom range in reverse order', '{"preset":"custom","fromDate":"2026-06-30","toDate":"2026-03-01"}'],
    ['an object with an unknown preset', '{"preset":"forever"}'],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(restoreRangeChoice(raw, context)).toEqual({ preset: 'ytd', value: YTD })
  })

  it('falls back to the caller default, not YTD, where the caller asks for another', () => {
    expect(restoreRangeChoice('garbage', { ...context, defaultPreset: 'this_month' })).toEqual({
      preset: 'this_month',
      value: { fromDate: '2026-10-01', toDate: '2026-10-31' },
    })
  })
})

describe('serializeRangeChoice / parseStoredRangeChoice', () => {
  it('round-trips a preset and a custom range', () => {
    expect(parseStoredRangeChoice(serializeRangeChoice({ preset: 'ytd' }))).toEqual({ preset: 'ytd' })
    expect(
      parseStoredRangeChoice(serializeRangeChoice({ preset: 'custom', fromDate: '2026-03-01', toDate: '2026-06-30' })),
    ).toEqual({ preset: 'custom', fromDate: '2026-03-01', toDate: '2026-06-30' })
  })

  it('keeps only the fields it reads back', () => {
    const raw = serializeRangeChoice({ preset: 'ytd', fromDate: '2026-03-01' } as never)
    expect(JSON.parse(raw)).toEqual({ preset: 'ytd' })
  })
})

describe('resolvePreset', () => {
  it('clamps a preset that reaches outside the period to the period', () => {
    expect(resolvePreset('this_month', '2026-07-01', '2027-06-30', '2027-07-15')).toEqual({
      fromDate: '2027-06-30',
      toDate: '2027-06-30',
    })
  })
})
