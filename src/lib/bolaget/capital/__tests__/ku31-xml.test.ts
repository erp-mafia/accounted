import { describe, expect, it } from 'vitest'
import {
  buildKu31Xml,
  fileOrgNumber,
  KU31_BLANKETT_NUMBER,
  KU31_COMPONENT_NAMESPACE,
  KU31_NAMESPACE,
  Ku31ValidationError,
  luhnValid,
  personIdentityKind,
  validateKu31File,
  validateKuCommon,
  type Ku31FileInput,
  type Ku31Recipient,
} from '../ku31-xml'

/** Append the Luhn check digit to nine digits. */
function withCheck(nine: string): string {
  for (let d = 0; d <= 9; d += 1) if (luhnValid(`${nine}${d}`)) return `${nine}${d}`
  throw new Error('no check digit')
}

const ORG = withCheck('556000000') // a legal person (third digit 6)
const PERSON_1 = `19${withCheck('800101123')}`
const PERSON_2 = `19${withCheck('750615234')}`
const PERSON_3 = `20${withCheck('010203345')}`
const SAMORDNING = `19${withCheck('900171456')}` // day 11 + 60

function recipient(over: Partial<Ku31Recipient> = {}): Ku31Recipient {
  return {
    specification_number: 1,
    identity: PERSON_1,
    first_name: 'Anna',
    last_name: 'Ek',
    street: null,
    postal_code: null,
    city: null,
    amount: 50_000,
    ...over,
  }
}

function file(over: Partial<Ku31FileInput> = {}): Ku31FileInput {
  return {
    income_year: 2026,
    payer_org_number: ORG,
    payer_name: 'Exempel AB',
    share_name: 'Aktier i Exempel AB',
    famansforetag: true,
    contact: { name: 'Anna Ek', phone: '+46701234567', email: 'anna@exempel.se' },
    created_at: '2027-01-10T09:30:00',
    program_name: 'Accounted',
    recipients: [recipient()],
    ...over,
  }
}

/** The direct children of the first <ku:KU31> block, in order. */
function ku31Children(xml: string, index = 0): string[] {
  const block = xml.split('<ku:KU31>')[index + 1]!.split('</ku:KU31>')[0]!
  const names: string[] = []
  let depth = 0
  for (const m of block.matchAll(/<(\/?)ku:([A-Za-z0-9]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m
    if (closing) {
      depth -= 1
      continue
    }
    if (depth === 0) names.push(name!)
    if (!selfClosing) depth += 1
  }
  return names
}

function field(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<ku:${name}(?: faltkod="(\\d+)")?>([^<]*)</ku:${name}>`, 'g'))].map((m) => `${m[1] ?? ''}=${m[2]}`)
}

describe('identity checks', () => {
  it('tells a personnummer from a samordningsnummer and refuses a wrong check digit', () => {
    expect(personIdentityKind(PERSON_1)).toBe('personnummer')
    expect(personIdentityKind(SAMORDNING)).toBe('samordningsnummer')
    const wrong = `${PERSON_1.slice(0, 11)}${(Number(PERSON_1[11]) + 1) % 10}`
    expect(personIdentityKind(wrong)).toBeNull()
    expect(personIdentityKind('198013011234')).toBeNull()
    expect(fileOrgNumber(ORG)).toBe(`16${ORG}`)
  })
})

describe('buildKu31Xml', () => {
  it('one owner: the root, sender, reporter and one KU31 per the schema, with every required field', () => {
    const xml = buildKu31Xml(file())
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')).toBe(true)
    expect(xml).toContain(`<Skatteverket xmlns="${KU31_NAMESPACE}"`)
    expect(xml).toContain(`xmlns:ku="${KU31_COMPONENT_NAMESPACE}"`)
    expect(xml).toContain('omrade="Kontrolluppgifter"')
    // Root sequence: Avsandare, Blankettgemensamt, Blankett+.
    const avsandare = xml.indexOf('<ku:Avsandare>')
    const gemensamt = xml.indexOf('<ku:Blankettgemensamt>')
    const blankett = xml.indexOf(`<ku:Blankett nummer="${KU31_BLANKETT_NUMBER}">`)
    expect(avsandare).toBeGreaterThan(0)
    expect(gemensamt).toBeGreaterThan(avsandare)
    expect(blankett).toBeGreaterThan(gemensamt)
    // Avsandare sequence: Programnamn, Organisationsnummer, TekniskKontaktperson, Skapad.
    const sender = xml.slice(avsandare, gemensamt)
    const order = ['<ku:Programnamn>', '<ku:Organisationsnummer>', '<ku:TekniskKontaktperson>', '<ku:Skapad>'].map((t) => sender.indexOf(t))
    expect(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!))).toBe(true)
    expect(field(xml, 'UppgiftslamnarePersOrgnr')).toEqual([`=16${ORG}`])
    // Blankett sequence: Arendeinformation then Blankettinnehall.
    const form = xml.slice(blankett)
    expect(form.indexOf('<ku:Arendeinformation>')).toBeLessThan(form.indexOf('<ku:Blankettinnehall>'))
    expect(field(xml, 'Arendeagare')).toEqual([`=16${ORG}`])
    expect(field(xml, 'Period')).toEqual(['=2026'])

    expect(ku31Children(xml)).toEqual([
      'UppgiftslamnareKU31',
      'Delagare',
      'Inkomstar',
      'Specifikationsnummer',
      'VPNamn',
      'UtbetaldUtdelning',
      'InkomsttagareKU31',
    ])
    expect(field(xml, 'UppgiftslamnarId')).toEqual([`201=16${ORG}`])
    expect(field(xml, 'NamnUppgiftslamnare')).toEqual(['202=Exempel AB'])
    expect(field(xml, 'Delagare')).toEqual(['061=1'])
    expect(field(xml, 'Inkomstar')).toEqual(['203=2026'])
    expect(field(xml, 'Specifikationsnummer')).toEqual(['570=1'])
    expect(field(xml, 'VPNamn')).toEqual(['571=Aktier i Exempel AB'])
    expect(field(xml, 'UtbetaldUtdelning')).toEqual(['574=50000'])
    expect(field(xml, 'Inkomsttagare')).toEqual([`215=${PERSON_1}`])
    expect(field(xml, 'Fornamn')).toEqual(['216=Anna'])
    expect(field(xml, 'Efternamn')).toEqual(['217=Ek'])
    // No tax is withheld on a dividend outside Euroclear: fields 001-003 never appear.
    expect(xml).not.toMatch(/faltkod="00[123]"/)
    // A personnummer needs no address (controls 059-061 and 144-146 apply to 222 and samordningsnummer only).
    expect(xml).not.toContain('faltkod="218"')
  })

  it('three owners: one Blankett each, sorted by specification number, 062 when not a fåmansföretag', () => {
    const xml = buildKu31Xml(
      file({
        famansforetag: false,
        recipients: [
          recipient({ specification_number: 3, identity: PERSON_3, first_name: 'Cia', last_name: 'Berg', amount: 10 }),
          recipient({ specification_number: 1, identity: PERSON_1, amount: 600 }),
          recipient({ specification_number: 2, identity: PERSON_2, first_name: null, last_name: null, amount: 390 }),
        ],
      }),
    )
    expect(xml.match(/<ku:Blankett nummer="2322">/g)).toHaveLength(3)
    expect(field(xml, 'Specifikationsnummer')).toEqual(['570=1', '570=2', '570=3'])
    expect(field(xml, 'Inkomsttagare')).toEqual([`215=${PERSON_1}`, `215=${PERSON_2}`, `215=${PERSON_3}`])
    expect(field(xml, 'UtbetaldUtdelning')).toEqual(['574=600', '574=390', '574=10'])
    expect(field(xml, 'DelagareEjFamansforetag')).toEqual(['062=1', '062=1', '062=1'])
    expect(xml).not.toContain('<ku:Delagare ')
    // The one without a full name carries none (216 and 217 are optional with a personnummer).
    expect(ku31Children(xml, 1)).toEqual(['UppgiftslamnareKU31', 'DelagareEjFamansforetag', 'Inkomstar', 'Specifikationsnummer', 'VPNamn', 'UtbetaldUtdelning', 'InkomsttagareKU31'])
    expect(field(xml, 'Fornamn')).toEqual(['216=Anna', '216=Cia'])
  })

  it('a samordningsnummer carries the name and the address (controls 142-146)', () => {
    const xml = buildKu31Xml(file({ recipients: [recipient({ identity: SAMORDNING, street: 'Storgatan 1', postal_code: '11122', city: 'Stockholm' })] }))
    expect(field(xml, 'Gatuadress')).toEqual(['218=Storgatan 1'])
    expect(field(xml, 'Postnummer')).toEqual(['219=11122'])
    expect(field(xml, 'Postort')).toEqual(['220=Stockholm'])
    expect(validateKu31File(file({ recipients: [recipient({ identity: SAMORDNING })] })).map((i) => i.code)).toEqual(['KU31_ADDRESS_REQUIRED'])
  })

  it('escapes text', () => {
    const xml = buildKu31Xml(file({ payer_name: 'Ek & Berg <AB>', share_name: 'Aktier i Ek & Berg' }))
    expect(xml).toContain('Ek &amp; Berg &lt;AB&gt;')
    expect(xml).not.toContain('Ek & Berg')
  })

  it('refuses an invalid file and names every broken rule', () => {
    const bad = file({
      payer_org_number: '1234567890',
      contact: { name: '', phone: '123456789012345678901', email: 'not-an-email' },
      recipients: [
        recipient({ specification_number: 0, identity: '191212121219', amount: 1.5 }),
        recipient({ specification_number: 0, last_name: null }),
      ],
    })
    const codes = validateKu31File(bad).map((i) => i.code)
    expect(codes).toEqual(
      expect.arrayContaining([
        'KU31_PAYER_ORG_NUMBER',
        'KU31_CONTACT_NAME',
        'KU31_CONTACT_PHONE',
        'KU31_CONTACT_EMAIL',
        'KU31_SPECIFICATION_NUMBER',
        'KU31_SPECIFICATION_DUPLICATE',
        'KU31_IDENTITY_INVALID',
        'KU31_AMOUNT',
        'KU31_NAME_INCOMPLETE',
      ]),
    )
    expect(() => buildKu31Xml(bad)).toThrow(Ku31ValidationError)
    expect(validateKu31File(file({ recipients: [] })).map((i) => i.code)).toEqual(['KU31_NO_RECIPIENTS'])
  })

  it('refuses an org number of a natural person as the payer (OrganisationsnummerTYPE needs 16 and a third digit 2-9)', () => {
    expect(validateKu31File(file({ payer_org_number: PERSON_1.slice(2) })).map((i) => i.code)).toContain('KU31_PAYER_ORG_NUMBER')
  })
})

describe('the contact email check (KU31 and KU20)', () => {
  /** Whether the check every Kontrolluppgifter file shares refuses this contact email. */
  function refuses(email: string, prefix: 'KU31' | 'KU20' = 'KU31'): boolean {
    const common = { ...file(), contact: { name: 'Anna Ek', phone: '+46701234567', email } }
    return validateKuCommon(common, prefix).some((i) => i.field === 'Kontaktperson.Epostadress')
  }

  it.each([
    'anna@exempel.se',
    'anna.ek@exempel.se',
    'förnamn.efternamn@företaget.se',
    'Åsa.Öberg@Ängelholm.se',
    "o'brien@example.co.uk",
    'anna+ku31@exempel.se',
    'anna_ek@exempel.se',
    'anna-ek@sub-domain.exempel.se',
    'a@b.c',
    '1234@567.89',
    'a.b.c.d@e.f.g.h',
  ])('accepts %s', (email) => {
    expect(refuses(email)).toBe(false)
  })

  it.each([
    'not-an-email',
    '',
    '@exempel.se',
    'anna@',
    'anna@exempel',
    '.anna@exempel.se',
    'anna@.exempel.se',
    'anna@exempel.se.',
    'anna@exempel..se',
    'anna ek@exempel.se',
    'anna@@exempel.se',
  ])('refuses %j', (email) => {
    expect(refuses(email)).toBe(true)
  })

  // Each character more in a refused address used to double the time the
  // check took. The bound is checked after every address, shortest first, so
  // a slow check fails on a short typo instead of never returning on the longest.
  it('answers at once for a typo with no top-level domain, up to the longest address the field takes', () => {
    const longest = `${'ekonomiavdelningen.'.repeat(12)}foretaget@foretaget`.padEnd(254, 's')
    expect(longest).toHaveLength(254)
    const started = performance.now()
    for (const email of ['ekonomi.foretaget@foretaget', 'ekonomiavdelning.foretaget@foretaget', 'ekonomiavdelningen.foretaget@foretaget', longest]) {
      for (const prefix of ['KU31', 'KU20'] as const) {
        expect(refuses(email, prefix)).toBe(true)
        expect(performance.now() - started).toBeLessThan(1000)
      }
    }
  })
})
