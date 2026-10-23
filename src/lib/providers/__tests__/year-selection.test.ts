import { describe, expect, it } from 'vitest'
import { fiscalYearSelectionProblem, toggleFiscalYear } from '../year-selection'

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
