import { describe, expect, it } from 'vitest'
import { generateKU10Xml } from '@/lib/salary/ku/ku10-generator'

function companyFixture(orgNumber: string) {
  return {
    orgNumber,
    companyName: 'Testbolaget AB',
    year: 2026,
    contactName: 'Test Testsson',
    contactPhone: '0700000000',
    contactEmail: 'test@example.com',
  }
}

/**
 * Skatteverket KU schema 12.0 defines OrganisationsnummerTYPE as a 12-digit
 * value with prefix `16`. UppgiftslamnarId is the exact FK201 element name.
 * The XSD intentionally does not validate the identity's check digit.
 * Source: https://www.skatteverket.se/foretag/skatterochavdrag/kontrolluppgifter/testtjanstochtekniskbeskrivning.4.233f91f71260075abe8800073614.html
 */
describe('generateKU10Xml: Skatteverket KU 12.0 identity contract', () => {
  it.each(['5560125790', '556012-5790', '556012 5790', '165560125790'])(
    'emits %s as a 12-digit organisation identity',
    (orgNumber) => {
      const xml = generateKU10Xml(companyFixture(orgNumber), [])

      expect(xml).toContain('<Organisationsnummer>165560125790</Organisationsnummer>')
      expect(xml).toContain('<UppgiftslamnarId>165560125790</UppgiftslamnarId>')
    }
  )

  it('uses the schema element name instead of the misspelled legacy tag', () => {
    const xml = generateKU10Xml(companyFixture('5560125790'), [])

    expect(xml).not.toContain('UppgijftslamnareId')
    expect(xml).not.toContain('UppgiftslamnareId')
    expect(xml).toContain('UppgiftslamnarId')
  })

  it.each([
    ['', 'missing'],
    ['55601', 'too short'],
    ['5560125790x', 'contains a stray character'],
    ['195560125790', 'has a non-organisation century prefix'],
    ['1100125790', 'has an invalid organisation-number group digit'],
  ])('rejects %s when it is %s', (orgNumber) => {
    expect(() => generateKU10Xml(companyFixture(orgNumber), [])).toThrow(
      /organisationsnumret måste innehålla 10 siffror eller 12 siffror med prefixet 16/
    )
  })

  it('does not add check-digit validation that the KU schema does not perform', () => {
    const xml = generateKU10Xml(companyFixture('5560125791'), [])

    expect(xml).toContain('<Organisationsnummer>165560125791</Organisationsnummer>')
  })
})
