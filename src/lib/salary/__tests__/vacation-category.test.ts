/**
 * lib/salary/vacation-category.ts: line validation, the as-of default and
 * the category split the ledger recomputes from booked runs.
 */
import { describe, expect, it } from 'vitest'
import {
  dayBefore,
  effectiveVacationAsOfDate,
  remainingSavedDays,
  splitVacationTaken,
  sumDays,
  validateVacationCategoryLine,
  VACATION_CATEGORY_VALIDATION_MESSAGE,
  VACATION_SAVED_YEAR_VALIDATION_MESSAGE,
} from '@/lib/salary/vacation-category'

describe('validateVacationCategoryLine', () => {
  it('accepts a line without a category (paid by default) on any type', () => {
    expect(validateVacationCategoryLine({ item_type: 'bonus' })).toBeNull()
    expect(validateVacationCategoryLine({ item_type: 'vacation', vacation_category: null })).toBeNull()
  })

  it('accepts every category on a vacation line', () => {
    for (const category of ['paid', 'extra_paid', 'saved', 'unpaid', 'advance']) {
      expect(validateVacationCategoryLine({ item_type: 'vacation', vacation_category: category })).toBeNull()
    }
  })

  it('refuses a category on a non-vacation line and an unknown category', () => {
    expect(validateVacationCategoryLine({ item_type: 'bonus', vacation_category: 'paid' })).toBe(
      VACATION_CATEGORY_VALIDATION_MESSAGE,
    )
    expect(validateVacationCategoryLine({ item_type: 'vacation', vacation_category: 'sparad' })).toBe(
      VACATION_CATEGORY_VALIDATION_MESSAGE,
    )
  })

  it('ties the saved year to category saved and a four-digit year', () => {
    expect(
      validateVacationCategoryLine({ item_type: 'vacation', vacation_category: 'saved', vacation_saved_year: '2025' }),
    ).toBeNull()
    expect(
      validateVacationCategoryLine({ item_type: 'vacation', vacation_category: 'paid', vacation_saved_year: '2025' }),
    ).toBe(VACATION_SAVED_YEAR_VALIDATION_MESSAGE)
    expect(validateVacationCategoryLine({ item_type: 'vacation', vacation_saved_year: '2025' })).toBe(
      VACATION_SAVED_YEAR_VALIDATION_MESSAGE,
    )
    expect(
      validateVacationCategoryLine({ item_type: 'vacation', vacation_category: 'saved', vacation_saved_year: '25' }),
    ).toBe(VACATION_SAVED_YEAR_VALIDATION_MESSAGE)
  })
})

describe('effectiveVacationAsOfDate', () => {
  it('defaults to the day before cutover, across a month and a year boundary', () => {
    expect(dayBefore('2026-09-01')).toBe('2026-08-31')
    expect(dayBefore('2026-01-01')).toBe('2025-12-31')
    expect(effectiveVacationAsOfDate({ cutover_date: '2026-09-01' })).toBe('2026-08-31')
    expect(effectiveVacationAsOfDate({ cutover_date: '2026-09-01', vacation_as_of_date: null })).toBe('2026-08-31')
  })

  it('honours an explicit as-of date', () => {
    expect(effectiveVacationAsOfDate({ cutover_date: '2026-09-01', vacation_as_of_date: '2026-07-31' })).toBe(
      '2026-07-31',
    )
  })
})

describe('splitVacationTaken', () => {
  const vacation = (quantity: number, category: string | null = null, savedYear: string | null = null) => ({
    item_type: 'vacation',
    quantity,
    vacation_category: category,
    vacation_saved_year: savedYear,
  })

  it('contributes exactly vacation_days_taken for runs without lines or categories', () => {
    const split = splitVacationTaken(
      [
        { vacation_days_taken: 3 },
        { vacation_days_taken: 2, line_items: null },
        { vacation_days_taken: 1.5, line_items: [vacation(1.5)] },
        { vacation_days_taken: 1, line_items: [vacation(1, 'paid')] },
      ],
      { '2025': 5 },
      '2025',
    )
    expect(split).toEqual({ paid: 7.5, unpaid: 0, advance: 0, savedByYear: {} })
  })

  it('keeps extra_paid in the paid pool', () => {
    const split = splitVacationTaken(
      [{ vacation_days_taken: 4, line_items: [vacation(3), vacation(1, 'extra_paid')] }],
      {},
      '2025',
    )
    expect(split.paid).toBe(4)
  })

  it('routes unpaid and advance days to their own pools', () => {
    const split = splitVacationTaken(
      [
        {
          vacation_days_taken: 6,
          line_items: [vacation(2), vacation(3, 'unpaid'), vacation(1, 'advance')],
        },
      ],
      {},
      '2025',
    )
    expect(split).toEqual({ paid: 2, unpaid: 3, advance: 1, savedByYear: {} })
  })

  it('consumes the named saved year', () => {
    const split = splitVacationTaken(
      [{ vacation_days_taken: 2, line_items: [vacation(2, 'saved', '2024')] }],
      { '2023': 1, '2024': 5 },
      '2025',
    )
    expect(split.paid).toBe(0)
    expect(split.savedByYear).toEqual({ '2024': 2 })
  })

  it('takes the oldest saved year first when no year is named, then the next', () => {
    const split = splitVacationTaken(
      [
        { vacation_days_taken: 2, line_items: [vacation(2, 'saved')] },
        { vacation_days_taken: 3, line_items: [vacation(3, 'saved')] },
      ],
      { '2025': 4, '2023': 1, '2024': 2 },
      '2025',
    )
    // 2023 (1) first, then 2024 (2), then 2025 (2 of 4).
    expect(split.savedByYear).toEqual({ '2023': 1, '2024': 2, '2025': 2 })
  })

  it('never drops consumption beyond the seed: it lands on the oldest year, or the fallback', () => {
    const overdrawn = splitVacationTaken(
      [{ vacation_days_taken: 3, line_items: [vacation(3, 'saved')] }],
      { '2024': 1 },
      '2025',
    )
    expect(overdrawn.savedByYear).toEqual({ '2024': 3 })

    const unseeded = splitVacationTaken(
      [{ vacation_days_taken: 1, line_items: [vacation(1, 'saved')] }],
      {},
      '2025',
    )
    expect(unseeded.savedByYear).toEqual({ '2025': 1 })
  })

  it('allocates unnamed saved days after the named years, whatever order the lines arrive in', () => {
    // Named 2023 x 3 leaves one 2023 day; the unnamed 2 then take that day
    // and one from 2024. Read in the other order the unnamed line would
    // have emptied 2023 first and the named line would overdraw it.
    const seed = { '2023': 4, '2024': 5 }
    const namedFirst = splitVacationTaken(
      [{ vacation_days_taken: 5, line_items: [vacation(3, 'saved', '2023'), vacation(2, 'saved')] }],
      seed,
      '2022',
    )
    const unnamedFirst = splitVacationTaken(
      [{ vacation_days_taken: 5, line_items: [vacation(2, 'saved'), vacation(3, 'saved', '2023')] }],
      seed,
      '2022',
    )
    expect(namedFirst.savedByYear).toEqual({ '2023': 4, '2024': 1 })
    expect(unnamedFirst).toEqual(namedFirst)
  })

  it('never lets a categorized total push the paid share below zero', () => {
    // vacation_days_taken stale relative to the lines: the paid share clamps.
    const split = splitVacationTaken(
      [{ vacation_days_taken: 1, line_items: [vacation(2, 'unpaid')] }],
      {},
      '2025',
    )
    expect(split.paid).toBe(0)
    expect(split.unpaid).toBe(2)
  })
})

describe('remainingSavedDays / sumDays', () => {
  it('returns the seed unchanged when nothing was consumed', () => {
    expect(remainingSavedDays({ '2024': 2, '2025': 5 }, {})).toEqual({ '2024': 2, '2025': 5 })
    expect(remainingSavedDays({ '2024': 2 }, null)).toEqual({ '2024': 2 })
    expect(remainingSavedDays(null, null)).toEqual({})
  })

  it('subtracts per year and surfaces an unseeded year as negative', () => {
    expect(remainingSavedDays({ '2024': 2, '2025': 5 }, { '2024': 2, '2025': 1.5 })).toEqual({
      '2024': 0,
      '2025': 3.5,
    })
    expect(remainingSavedDays({ '2025': 5 }, { '2023': 1 })).toEqual({ '2025': 5, '2023': -1 })
    expect(sumDays({ '2024': 0, '2025': 3.5 })).toBe(3.5)
  })
})
