import { describe, expect, it } from 'vitest'
import { creditorNameMatches, normalizeCreditorName } from '../creditor-name-match'

describe('creditorNameMatches', () => {
  it('ignores case, the fall of spaces and a trailing full stop', () => {
    expect(creditorNameMatches('Derome Bygg AB', 'DEROME BYGG AB')).toBe(true)
    expect(creditorNameMatches('Derome  Bygg AB ', ' derome bygg ab')).toBe(true)
    expect(creditorNameMatches('Derome Bygg AB.', 'Derome Bygg AB')).toBe(true)
    expect(creditorNameMatches('Åkeri & Söner AB', 'åkeri & söner ab')).toBe(true)
  })

  it('treats anything else as a different name: the person should look at it', () => {
    expect(creditorNameMatches('Derome AB', 'Derome Bygg AB')).toBe(false)
    expect(creditorNameMatches('Telia Sverige AB', 'Telia Company AB')).toBe(false)
    expect(creditorNameMatches('Derome Bygg Aktiebolag', 'Derome Bygg AB')).toBe(false)
  })

  it('never matches an empty registered name', () => {
    expect(creditorNameMatches('', '')).toBe(false)
    expect(creditorNameMatches('   ', 'Derome Bygg AB')).toBe(false)
  })

  it('normalizes to one lowercase form', () => {
    expect(normalizeCreditorName('  DEROME   Bygg AB. ')).toBe('derome bygg ab')
  })
})
