import { describe, it, expect } from 'vitest'
import { mapEntityType } from '../entity-type-map'

describe('mapEntityType', () => {
  it('maps the exact AB codes and labels to aktiebolag', () => {
    expect(mapEntityType('AB')).toBe('aktiebolag')
    expect(mapEntityType('ab')).toBe('aktiebolag')
    expect(mapEntityType('Aktiebolag')).toBe('aktiebolag')
    expect(mapEntityType('Publikt aktiebolag')).toBe('aktiebolag') // same K2/K3 regime
    expect(mapEntityType('  Aktiebolag  ')).toBe('aktiebolag') // whitespace tolerant
  })

  it('maps the exact EF codes and labels to enskild_firma', () => {
    expect(mapEntityType('EF')).toBe('enskild_firma')
    expect(mapEntityType('ef')).toBe('enskild_firma')
    expect(mapEntityType('Enskild firma')).toBe('enskild_firma')
    expect(mapEntityType('Enskild näringsidkare')).toBe('enskild_firma')
  })

  it('returns null for unsupported entity types', () => {
    expect(mapEntityType('HB')).toBeNull()
    expect(mapEntityType('Handelsbolag')).toBeNull()
    expect(mapEntityType('KB')).toBeNull()
    expect(mapEntityType('Kommanditbolag')).toBeNull()
    expect(mapEntityType('Stiftelse')).toBeNull()
    expect(mapEntityType('Ekonomisk förening')).toBeNull()
    expect(mapEntityType('Bostadsrättsförening')).toBeNull()
  })

  it('does not false-match strings that merely contain "enskild" or "aktiebolag"', () => {
    // Regression guard: a loose substring match would misclassify these and
    // provision them with K1/kontantmetoden defaults (ML/BFL risk).
    expect(mapEntityType('Enskild stiftelse')).toBeNull()
    expect(mapEntityType('Enskild näringsverksamhet utan firma')).toBeNull()
    // Bank- and försäkringsaktiebolag follow FFFS, not K2/K3: not a safe
    // one-click provision.
    expect(mapEntityType('Försäkringsaktiebolag')).toBeNull()
    expect(mapEntityType('Bankaktiebolag')).toBeNull()
  })

  it('returns null for empty or nullish input', () => {
    expect(mapEntityType('')).toBeNull()
    expect(mapEntityType(null)).toBeNull()
    expect(mapEntityType(undefined)).toBeNull()
  })
})
