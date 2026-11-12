import { describe, expect, it } from 'vitest'
import { runBudget, UNLIMITED_RUN } from '../run-budget'

describe('runBudget', () => {
  it('lets work start until the budget is spent, counted from the start of the run', () => {
    let now = 1_000
    const budget = runBudget(1_000, 180_000, () => now)

    expect(budget.deadline).toBe(181_000)
    expect(budget.allows()).toBe(true)
    now = 181_000
    expect(budget.allows()).toBe(true)
    now = 181_001
    expect(budget.allows()).toBe(false)
  })

  it('refuses work that needs longer than what is left', () => {
    let now = 0
    const budget = runBudget(0, 100_000, () => now)

    now = 60_000
    expect(budget.allows(30_000)).toBe(true)
    expect(budget.allows(40_000)).toBe(true)
    expect(budget.allows(40_001)).toBe(false)
  })

  it('counts time spent before the handler began: a late start has less left', () => {
    const budget = runBudget(0, 100_000, () => 150_000)

    expect(budget.allows()).toBe(false)
  })

  it('has an unlimited form for callers that are not a scheduled run', () => {
    expect(UNLIMITED_RUN.allows()).toBe(true)
    expect(UNLIMITED_RUN.allows(Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})
