import { describe, it, expect } from 'vitest'
import { planChartChanges } from '../chart-plan'
import type { AccountMapping } from '../types'

function mapping(
  partial: Partial<AccountMapping> & { sourceAccount: string; targetAccount: string }
): AccountMapping {
  return {
    sourceName: '',
    targetName: '',
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
    ...partial,
  }
}

describe('planChartChanges', () => {
  it('splits distinct target accounts into new and existing for this company', () => {
    const plan = planChartChanges(
      [
        mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: 'Företagskonto' }),
        mapping({ sourceAccount: '3010', targetAccount: '3010', sourceName: 'Konsultarvoden' }),
        mapping({ sourceAccount: '6110', targetAccount: '6110', targetName: 'Kontorsmateriel' }),
      ],
      new Set(['1930']),
    )

    expect(plan.toCreate).toBe(2)
    expect(plan.existing).toBe(1)
    expect(plan.sample).toEqual([
      { number: '3010', name: 'Konsultarvoden' },
      { number: '6110', name: 'Kontorsmateriel' },
    ])
  })

  it('names a new identity-mapped account after the file, not the BAS reference', () => {
    // Matches syncMappedAccounts with "Använd kontonamn från filen" on (the
    // default): the file's #KONTO name wins for sourceAccount === targetAccount.
    const plan = planChartChanges(
      [
        mapping({
          sourceAccount: '1930',
          targetAccount: '1930',
          sourceName: 'Företagskonto Swedbank',
          targetName: 'Företagskonto/checkkonto',
        }),
      ],
      new Set(),
    )

    expect(plan.sample).toEqual([{ number: '1930', name: 'Företagskonto Swedbank' }])
  })

  it('names a remapped account after its target', () => {
    const plan = planChartChanges(
      [
        mapping({
          sourceAccount: '1910',
          targetAccount: '1930',
          sourceName: 'Kassa',
          targetName: 'Företagskonto/checkkonto',
        }),
      ],
      new Set(),
    )

    expect(plan.sample).toEqual([{ number: '1930', name: 'Företagskonto/checkkonto' }])
  })

  it('counts two sources remapped onto one target once', () => {
    const plan = planChartChanges(
      [
        mapping({ sourceAccount: '1910', targetAccount: '1930' }),
        mapping({ sourceAccount: '1920', targetAccount: '1930' }),
      ],
      new Set(),
    )

    expect(plan.toCreate).toBe(1)
    expect(plan.existing).toBe(0)
  })

  it('leaves an unmapped source out of both counts', () => {
    // The import refuses while anything is unmapped; the account is neither
    // added nor present until the user creates or maps it.
    const plan = planChartChanges(
      [
        mapping({ sourceAccount: '9030', targetAccount: '', sourceName: 'Obokat resultat' }),
        mapping({ sourceAccount: '1930', targetAccount: '1930' }),
      ],
      new Set(['1930']),
    )

    expect(plan.toCreate).toBe(0)
    expect(plan.existing).toBe(1)
    expect(plan.sample).toEqual([])
  })

  it('caps the sample but not the count', () => {
    const mappings = Array.from({ length: 12 }, (_, i) =>
      mapping({ sourceAccount: `40${10 + i}`, targetAccount: `40${10 + i}` }),
    )

    const plan = planChartChanges(mappings, new Set())

    expect(plan.toCreate).toBe(12)
    expect(plan.sample).toHaveLength(8)
    expect(plan.sample[0].number).toBe('4010')
  })
})
