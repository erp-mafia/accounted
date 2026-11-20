/**
 * The onboarding books flow has no mapping page, so it completes the
 * server's mapping decision itself. Before #3312 it created every blank
 * target in the chart and mapped it onto itself, class 9 included, and the
 * job refused the 9xxx target one call later, on every retry.
 */
import { describe, expect, it } from 'vitest'
import { resolveOnboardingMappings } from '../mappings'
import type { AccountMapping } from '@/lib/import/types'

const mapping = (sourceAccount: string, targetAccount = '', extra: Partial<AccountMapping> = {}): AccountMapping => ({
  sourceAccount, sourceName: `Konto ${sourceAccount}`, targetAccount, targetName: targetAccount ? `Mål ${targetAccount}` : '',
  confidence: targetAccount ? 1 : 0, matchType: targetAccount ? 'exact' : 'manual', isOverride: false, ...extra,
})

describe('resolveOnboardingMappings', () => {
  it('keeps every target the server decided, 2999 for class 9 included', () => {
    const decided = [mapping('1930', '1930'), mapping('9999', '2999', { matchType: 'class', confidence: 0.5 })]
    expect(resolveOnboardingMappings(decided)).toEqual({ mappings: decided, create: [], unresolved: [] })
  })

  it('creates a blank 1000-8999 account under its own number, named from the file', () => {
    const result = resolveOnboardingMappings([mapping('4599')], [{ number: '4599', name: 'Justering inköp' }])
    expect(result.create).toEqual([{ number: '4599', name: 'Justering inköp' }])
    expect(result.mappings[0]).toMatchObject({ targetAccount: '4599', targetName: 'Konto 4599', matchType: 'exact', confidence: 1, isOverride: true })
    expect(result.unresolved).toEqual([])
  })

  it.each(['9100', '0099', '19301'])('never creates or self-maps %s, which no chart can hold', (number) => {
    const result = resolveOnboardingMappings([mapping('1930', '1930'), mapping(number)])
    expect(result.unresolved).toEqual([number])
    expect(result.create).toEqual([])
    expect(result.mappings.find((m) => m.sourceAccount === number)?.targetAccount).toBe('')
  })
})
