import { describe, expect, it } from 'vitest'
import { companyMismatchMessages } from '../company-mismatch-message'

/**
 * PH 193: a bookkeeper connected Fortnox while still in their own company in
 * Accounted; the login opened the client company and the refusal only said to
 * choose again at the provider, which could never help. The message names the
 * company the connection opened and both ways out.
 */
describe('companyMismatchMessages', () => {
  const facts = { expectedOrgNumber: '5560160680', actualOrgNumber: '5567037485', actualCompanyName: 'Klientbolaget AB' }

  it('names the opened company and both org numbers, and points to Lägg till företag', () => {
    const { sv, en } = companyMismatchMessages(facts)
    expect(sv).toContain('Anslutningen gäller Klientbolaget AB (org.nr 556703-7485)')
    expect(sv).toContain('inte företaget du importerar till (org.nr 556016-0680)')
    expect(sv).toContain('Ska Klientbolaget AB flyttas till Accounted? Välj då Lägg till företag')
    expect(sv).toContain('Annars: anslut igen och välj rätt företag.')
    expect(en).toContain('Klientbolaget AB (org. no. 556703-7485)')
    expect(en).toContain('Add company')
  })

  it('still names the org number when the provider reported no company name', () => {
    for (const actualCompanyName of [null, '  ']) {
      const { sv, en } = companyMismatchMessages({ ...facts, actualCompanyName })
      expect(sv).toContain('Anslutningen gäller ett annat företag (org.nr 556703-7485)')
      expect(sv).toContain('Ska det företaget flyttas till Accounted?')
      expect(en).toContain('another company (org. no. 556703-7485)')
    }
  })

  it('never uses an em or en dash', () => {
    const { sv, en } = companyMismatchMessages(facts)
    expect(`${sv} ${en}`).not.toMatch(/[–—]/)
  })
})
