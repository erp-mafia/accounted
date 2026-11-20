import { describe, expect, it } from 'vitest'
import { fileOrgNumber, KU31_NAMESPACE, luhnValid } from '../../capital/ku31-xml'
import { buildKu20Xml, KU20_BLANKETT_NUMBER, Ku20ValidationError, validateKu20File, type Ku20FileInput, type Ku20Recipient } from '../ku20-xml'

/** Append the Luhn check digit to nine digits. */
function withCheck(nine: string): string {
  for (let d = 0; d <= 9; d += 1) if (luhnValid(`${nine}${d}`)) return `${nine}${d}`
  throw new Error('no check digit')
}

const ORG = withCheck('556000000')
const PERSON_1 = `19${withCheck('800101123')}`
const PERSON_2 = `19${withCheck('750615234')}`
const SAMORDNING = `19${withCheck('900171456')}`

function recipient(over: Partial<Ku20Recipient> = {}): Ku20Recipient {
  return { specification_number: 1, identity: PERSON_1, first_name: 'Anna', last_name: 'Ek', street: null, postal_code: null, city: null, interest: 8_000, tax_withheld: 2_400, delagare: true, ...over }
}

function file(over: Partial<Ku20FileInput> = {}): Ku20FileInput {
  return {
    income_year: 2026,
    payer_org_number: ORG,
    payer_name: 'Exempel AB',
    contact: { name: 'Anna Ek', phone: '+46701234567', email: 'anna@exempel.se' },
    created_at: '2027-01-10T09:30:00',
    program_name: 'Accounted',
    recipients: [recipient()],
    ...over,
  }
}

function blocks(xml: string): string[] {
  return xml.split('<ku:KU20>').slice(1).map((b) => b.split('</ku:KU20>')[0]!)
}

describe('buildKu20Xml', () => {
  it('writes one blankett 2323 per recipient with fields 001, 061, 203, 503 and 570, in the KU31 envelope', () => {
    const xml = buildKu20Xml(file({ recipients: [recipient(), recipient({ specification_number: 2, identity: PERSON_2, first_name: 'Bo', last_name: 'Ek', tax_withheld: 0, delagare: false, interest: 1_200 })] }))
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')).toBe(true)
    expect(xml).toContain(`xmlns="${KU31_NAMESPACE}"`)
    expect(xml.match(new RegExp(`<ku:Blankett nummer="${KU20_BLANKETT_NUMBER}">`, 'g'))).toHaveLength(2)
    expect(KU20_BLANKETT_NUMBER).toBe('2323')
    const [first, second] = blocks(xml)
    expect(first).toContain('<ku:AvdragenSkatt faltkod="001">2400</ku:AvdragenSkatt>')
    expect(first).toContain('<ku:Delagare faltkod="061">1</ku:Delagare>')
    expect(first).toContain('<ku:Inkomstar faltkod="203">2026</ku:Inkomstar>')
    expect(first).toContain('<ku:RanteinkomstEjKonto faltkod="503">8000</ku:RanteinkomstEjKonto>')
    expect(first).toContain('<ku:Specifikationsnummer faltkod="570">1</ku:Specifikationsnummer>')
    expect(first).toContain(`<ku:Inkomsttagare faltkod="215">${PERSON_1}</ku:Inkomsttagare>`)
    expect(first).toContain(`<ku:UppgiftslamnarId faltkod="201">${fileOrgNumber(ORG)}</ku:UppgiftslamnarId>`)
    // No tax withheld and not a delägare: neither 001 nor 061 is written; 502 never is (control 071).
    expect(second).not.toContain('faltkod="001"')
    expect(second).not.toContain('faltkod="061"')
    expect(xml).not.toContain('faltkod="502"')
    expect(xml).not.toContain('faltkod="500"')
    expect(xml.trim().endsWith('</Skatteverket>')).toBe(true)
  })

  it('a samordningsnummer carries name and address (controls 142-146)', () => {
    const issues = validateKu20File(file({ recipients: [recipient({ identity: SAMORDNING })] }))
    expect(issues.map((i) => i.code)).toEqual(['KU20_ADDRESS_REQUIRED'])
    const xml = buildKu20Xml(file({ recipients: [recipient({ identity: SAMORDNING, street: 'Storgatan 1', postal_code: '11122', city: 'Stockholm' })] }))
    expect(xml).toContain('<ku:Gatuadress faltkod="218">Storgatan 1</ku:Gatuadress>')
  })

  it('refuses a file with an invalid identity, tax above the interest, a duplicate specification number or no contact', () => {
    const issues = validateKu20File(
      file({
        contact: { name: '', phone: '', email: 'nope' },
        recipients: [recipient({ identity: '191212121213' }), recipient({ tax_withheld: 9_000 })],
      }),
    )
    expect(issues.map((i) => i.code).sort()).toEqual(
      ['KU20_CONTACT_EMAIL', 'KU20_CONTACT_NAME', 'KU20_CONTACT_PHONE', 'KU20_IDENTITY_INVALID', 'KU20_SPECIFICATION_DUPLICATE', 'KU20_TAX'].sort(),
    )
    expect(() => buildKu20Xml(file({ recipients: [] }))).toThrow(Ku20ValidationError)
  })
})
