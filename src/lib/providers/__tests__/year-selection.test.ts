import { describe, expect, it } from 'vitest'
import { defaultFiscalYearSelection, fiscalYearSelectionProblem, needsSeveralRuns, toggleFiscalYear } from '../year-selection'

// The onboarding shape that stalled: six years ticked (the run's limit) and
// an older one clicked.
const SIX = [2021, 2022, 2023, 2024, 2025, 2026]

describe('toggleFiscalYear', () => {
  it('ticks a seventh year when six are ticked: the click is never ignored', () => {
    expect(toggleFiscalYear(SIX, 2020)).toEqual([2020, ...SIX])
  })

  it('unticks a ticked year', () => {
    expect(toggleFiscalYear(SIX, 2023)).toEqual([2021, 2022, 2024, 2025, 2026])
  })

  it('keeps the selection oldest first and leaves the input alone', () => {
    const selected = [2026, 2024]
    expect(toggleFiscalYear(selected, 2025)).toEqual([2024, 2025, 2026])
    expect(selected).toEqual([2026, 2024])
  })
})

describe('fiscalYearSelectionProblem', () => {
  it('names a selection over the limit, so the screen can say why it cannot go on', () => {
    expect(fiscalYearSelectionProblem(toggleFiscalYear(SIX, 2020), 6)).toBe('too_many')
  })

  it('accepts a selection at the limit', () => {
    expect(fiscalYearSelectionProblem(SIX, 6)).toBeNull()
  })

  it('names an empty selection', () => {
    expect(fiscalYearSelectionProblem([], 6)).toBe('none')
  })

  it('has no upper limit when the source sets none', () => {
    expect(fiscalYearSelectionProblem([2019, ...SIX], null)).toBeNull()
    expect(fiscalYearSelectionProblem([2019, ...SIX], undefined)).toBeNull()
  })
})

/** A source with `count` years ending in 2025, the newest three in the preview's default window. */
function source(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const year = 2025 - count + 1 + i
    return { year, inDefaultSelection: year >= 2023 }
  })
}

describe('defaultFiscalYearSelection (crm#1686)', () => {
  it('keeps the newest three when the history fits in one run', () => {
    expect(defaultFiscalYearSelection(source(6), 6)).toEqual([2023, 2024, 2025])
    expect(defaultFiscalYearSelection(source(2), 6)).toEqual([2024, 2025])
    expect(defaultFiscalYearSelection(source(9), null)).toEqual([2023, 2024, 2025])
  })

  it('starts a longer history from the oldest years, at most one run of them', () => {
    // 15 years, the shape that got opening-balance reviews when the newest came first.
    expect(defaultFiscalYearSelection(source(15), 6)).toEqual([2011, 2012, 2013, 2014, 2015, 2016])
  })

  it('continues from the oldest year the books do not hold yet', () => {
    const imported = [2011, 2012, 2013, 2014, 2015, 2016]
    expect(defaultFiscalYearSelection(source(15), 6, imported)).toEqual([2017, 2018, 2019, 2020, 2021, 2022])
    expect(defaultFiscalYearSelection(source(15), 6, [...imported, 2017, 2018, 2019, 2020, 2021, 2022])).toEqual([2023, 2024, 2025])
  })

  it('falls back to the newest three once every year is imported', () => {
    const all = source(8).map((y) => y.year)
    expect(defaultFiscalYearSelection(source(8), 6, all)).toEqual([2023, 2024, 2025])
  })

  it('ignores imports in a source that fits in one run', () => {
    expect(defaultFiscalYearSelection(source(5), 6, [2023, 2024, 2025])).toEqual([2023, 2024, 2025])
  })
})

describe('needsSeveralRuns', () => {
  it('is true only past the limit, counting each start year once', () => {
    expect(needsSeveralRuns(source(7), 6)).toBe(true)
    expect(needsSeveralRuns(source(6), 6)).toBe(false)
    expect(needsSeveralRuns([...source(6), { year: 2025, inDefaultSelection: true }], 6)).toBe(false)
    expect(needsSeveralRuns(source(20), null)).toBe(false)
    expect(needsSeveralRuns(source(20), undefined)).toBe(false)
  })
})
