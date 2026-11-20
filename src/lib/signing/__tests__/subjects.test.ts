import { describe, it, expect } from 'vitest'
import { bankIdNameMatchesSlot, subjectStatement } from '../subjects'

describe('bankIdNameMatchesSlot', () => {
  it('matches the slot first name among the given names and the last word among the surnames', () => {
    expect(bankIdNameMatchesSlot('Anna Svensson', 'Anna Maria', 'Svensson')).toBe(true)
    expect(bankIdNameMatchesSlot('Maria Svensson', 'Anna Maria', 'Svensson')).toBe(true)
    expect(bankIdNameMatchesSlot('Anna Berg', 'Anna', 'Svensson Berg')).toBe(true)
    expect(bankIdNameMatchesSlot('anna-karin ÖSTLUND', 'Anna-Karin', 'Östlund')).toBe(true)
  })

  it('refuses another first name, another surname, or a single word', () => {
    expect(bankIdNameMatchesSlot('Kalle Svensson', 'Karl Gustav', 'Svensson')).toBe(false)
    expect(bankIdNameMatchesSlot('Anna Svensson', 'Anna', 'Berg')).toBe(false)
    expect(bankIdNameMatchesSlot('Svensson', 'Anna', 'Svensson')).toBe(false)
  })
})

describe('subjectStatement', () => {
  it('says what a board member signs, with the fiscal year and the role', () => {
    expect(subjectStatement({ contentHash: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-12-31' }, { role_label: 'Styrelseledamot' }, 'Solkatt AB'))
      .toBe('Jag skriver under årsredovisningen för Solkatt AB för räkenskapsåret 2026-01-01 till 2026-12-31 som styrelseledamot.')
  })

  it('leaves a plain request to the default statement', () => {
    expect(subjectStatement({}, { role_label: 'Hyresgäst' }, 'Solkatt AB')).toBeUndefined()
  })
})
