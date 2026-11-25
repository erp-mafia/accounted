/**
 * KU31 (Kontrolluppgift om utdelning m.m. på delägarrätter) as the XML file
 * Skatteverket's e-service "Lämna kontrolluppgifter" takes (filöverföring).
 *
 * Built against Skatteverket's own schema for inkomstår 2026, version 12.0
 * (Kontrolluppgifter_12.0.xsd, Kontrolluppgifter_COMPONENT_12.0.xsd and
 * SKV_COMMON_12.0.xsd, schema dated 2026-06-25), the sample file "Income
 * statements reporting Swedish withholding tax on dividends (KU31) 2026",
 * and "Field names and synchronisation checks 2026" (controls 053, 055-063,
 * 085, 088, 142-146, 170, 214-216, 287, 291, 296, 297), all from
 * https://www.skatteverket.se/servicelankar/otherlanguages/englishengelska/moreonskatteverket/testserviceandtechnicalspecification.4.5b35a6251761e691420b362.html
 *
 * The file this module writes, for a company outside Euroclear paying its
 * own dividend to natural persons and estates (SFL 19:2-3):
 *
 *   Skatteverket (omrade="Kontrolluppgifter")
 *     Avsandare: Programnamn, Organisationsnummer, TekniskKontaktperson, Skapad
 *     Blankettgemensamt / Uppgiftslamnare: UppgiftslamnarePersOrgnr, Kontaktperson
 *     Blankett nummer="2322" (one per recipient):
 *       Arendeinformation: Arendeagare, Period
 *       Blankettinnehall / KU31:
 *         UppgiftslamnareKU31 (201 org number, 202 name)
 *         Delagare 061 (fåmansföretag) or DelagareEjFamansforetag 062
 *         Inkomstar 203, Specifikationsnummer 570, VPNamn 571 (no ISIN),
 *         UtbetaldUtdelning 574 (whole kronor, öre dropped)
 *         InkomsttagareKU31: Inkomsttagare 215, Fornamn 216, Efternamn 217,
 *         and for a samordningsnummer Gatuadress 218, Postnummer 219, Postort 220
 *
 * Identity numbers are 12 digits (personnummer or samordningsnummer with
 * century; an org number prefixed 16), as IdentitetsbeteckningForPersonTYPE
 * requires; the check digit is verified here because the schema does not.
 * No tax is withheld on a dividend from a company outside Euroclear (SFL
 * 10:18 p. 1), so fields 001-003 are never written.
 *
 * Pure: no I/O. validateKu31File lists every rule the input breaks before
 * anything is written; buildKu31Xml refuses an input with errors.
 */

import { isLegalPersonOrgNumber } from '@/lib/invariants/org-number'

export const KU31_SCHEMA_VERSION = '12.0'
export const KU31_BLANKETT_NUMBER = '2322'
export const KU31_NAMESPACE = 'http://xmls.skatteverket.se/se/skatteverket/ai/instans/infoForBeskattning/12.0'
export const KU31_COMPONENT_NAMESPACE = 'http://xmls.skatteverket.se/se/skatteverket/ai/komponent/infoForBeskattning/12.0'
export const KU31_COMMON_NAMESPACE = 'http://xmls.skatteverket.se/se/skatteverket/ai/gemensamt/infoForBeskattning/12.0'
export const KU31_SCHEMA_LOCATION =
  'http://xmls.skatteverket.se/se/skatteverket/ai/instans/infoForBeskattning/12.0 http://xmls.skatteverket.se/se/skatteverket/ai/kontrolluppgift/instans/Kontrolluppgifter_12.0.xsd'
/** The inkomstår schema 12.0 is for. */
export const KU31_INCOME_YEAR = 2026

export interface Ku31Contact {
  name: string
  phone: string
  email: string
}

export interface Ku31Recipient {
  specification_number: number
  /** 12 digits: personnummer or samordningsnummer with century. */
  identity: string
  first_name: string | null
  last_name: string | null
  street: string | null
  postal_code: string | null
  city: string | null
  /** Whole kronor (öre dropped). */
  amount: number
}

export interface Ku31FileInput {
  income_year: number
  /** The paying company's org number, 10 digits. */
  payer_org_number: string
  payer_name: string
  /** The name of the share (field 571), e.g. "Aktier i Exempel AB". */
  share_name: string
  /** Field 061 (true) or 062 (false) for every recipient. */
  famansforetag: boolean
  contact: Ku31Contact
  /** Local time, YYYY-MM-DDTHH:MM:SS. */
  created_at: string
  program_name: string
  recipients: Ku31Recipient[]
}

export interface Ku31Issue {
  code: string
  field: string
  message_sv: string
  specification_number?: number
}

/** Luhn check over the last ten digits (personnummer, samordningsnummer and org numbers alike). */
export function luhnValid(tenDigits: string): boolean {
  if (!/^\d{10}$/.test(tenDigits)) return false
  let sum = 0
  for (let i = 0; i < 10; i += 1) {
    let d = Number(tenDigits[i])
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 'personnummer', 'samordningsnummer' or null for a 12-digit identity that is neither (or fails its check digit). */
export function personIdentityKind(identity: string): 'personnummer' | 'samordningsnummer' | null {
  if (!/^(18|19|20)\d{10}$/.test(identity)) return null
  if (!luhnValid(identity.slice(2))) return null
  const year = Number(identity.slice(0, 4))
  const month = Number(identity.slice(4, 6))
  const day = Number(identity.slice(6, 8))
  if (validDate(year, month, day)) return 'personnummer'
  if (day > 60 && validDate(year, month, day - 60)) return 'samordningsnummer'
  return null
}

/** The org number in the form the file takes: 16 and ten digits (OrganisationsnummerTYPE). */
export function fileOrgNumber(orgNumber10: string): string {
  return `16${orgNumber10}`
}

const EMAIL = /^[\wåäöÅÄÖ]+([-+.'_\wåäöÅÄÖ]+)*@[\wåäöÅÄÖ]+([-.][\wåäöÅÄÖ]+)*\.[\wåäöÅÄÖ]+([-.][\wåäöÅÄÖ]+)*$/

function textOk(value: string | null | undefined, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

/** What every Kontrolluppgifter file (KU31, KU20) carries besides its blanketter. */
export interface KuFileCommon {
  income_year: number
  /** The paying company's org number, 10 digits. */
  payer_org_number: string
  payer_name: string
  contact: Ku31Contact
  program_name: string
}

/**
 * The checks every Kontrolluppgifter file shares: inkomstår, the
 * uppgiftslämnare's org number and name, the contact person and the
 * program. Codes carry the form's prefix (KU31_..., KU20_...).
 */
export function validateKuCommon(input: KuFileCommon, prefix: 'KU31' | 'KU20'): Ku31Issue[] {
  const issues: Ku31Issue[] = []
  const push = (code: string, field: string, message_sv: string) => issues.push({ code: `${prefix}_${code}`, field, message_sv })
  if (!Number.isInteger(input.income_year) || input.income_year < 2000 || input.income_year > 2099) {
    push('INCOME_YEAR', '203', 'Inkomståret är ogiltigt.')
  }
  if (!/^\d{10}$/.test(input.payer_org_number) || !luhnValid(input.payer_org_number) || !isLegalPersonOrgNumber(input.payer_org_number)) {
    // OrganisationsnummerTYPE: 16 followed by a third digit 2-9 (a legal person), and the check digit.
    push('PAYER_ORG_NUMBER', '201', 'Bolagets organisationsnummer saknas eller är ogiltigt. Kontrollera det under Inställningar → Företaget → Företagsuppgifter.')
  }
  if (!textOk(input.payer_name, 50)) push('PAYER_NAME', '202', 'Bolagets namn saknas.')
  if (!textOk(input.contact.name, 50)) push('CONTACT_NAME', 'Kontaktperson.Namn', 'Ange kontaktpersonens namn (högst 50 tecken).')
  if (!textOk(input.contact.phone, 20)) push('CONTACT_PHONE', 'Kontaktperson.Telefon', 'Ange kontaktpersonens telefonnummer (högst 20 tecken).')
  if (!(typeof input.contact.email === 'string' && input.contact.email.length <= 254 && EMAIL.test(input.contact.email))) {
    push('CONTACT_EMAIL', 'Kontaktperson.Epostadress', 'Ange en giltig e-postadress till kontaktpersonen.')
  }
  if (!textOk(input.program_name, 50)) push('PROGRAM', 'Programnamn', 'Programnamn saknas.')
  return issues
}

export function validateKu31File(input: Ku31FileInput): Ku31Issue[] {
  const issues: Ku31Issue[] = []
  const push = (code: string, field: string, message_sv: string, specification_number?: number) =>
    issues.push({ code, field, message_sv, ...(specification_number !== undefined ? { specification_number } : {}) })

  const common = validateKuCommon(input, 'KU31')
  issues.push(...common.filter((i) => i.field === '203' || i.field === '201' || i.field === '202'))
  if (!textOk(input.share_name, 50)) push('KU31_SHARE_NAME', '571', 'Aktiens namn saknas.')
  issues.push(...common.filter((i) => !(i.field === '203' || i.field === '201' || i.field === '202')))
  if (input.recipients.length === 0) push('KU31_NO_RECIPIENTS', 'Blankett', 'Det finns ingen utdelning att lämna kontrolluppgift för.')

  const specs = new Set<number>()
  for (const r of input.recipients) {
    const spec = r.specification_number
    if (!Number.isInteger(spec) || spec < 1 || spec > 9_999_999_999) push('KU31_SPECIFICATION_NUMBER', '570', 'Specifikationsnumret är ogiltigt.', spec)
    if (specs.has(spec)) push('KU31_SPECIFICATION_DUPLICATE', '570', 'Två kontrolluppgifter har samma specifikationsnummer.', spec)
    specs.add(spec)
    const kind = personIdentityKind(r.identity)
    if (!kind) push('KU31_IDENTITY_INVALID', '215', 'Personnumret är ogiltigt.', spec)
    if (r.identity === fileOrgNumber(input.payer_org_number)) push('KU31_IDENTITY_IS_PAYER', '215', 'Mottagaren kan inte vara bolaget självt.', spec)
    if (!Number.isInteger(r.amount) || r.amount < 0 || r.amount > 9_999_999_999) push('KU31_AMOUNT', '574', 'Utdelningsbeloppet är ogiltigt.', spec)
    const hasFirst = textOk(r.first_name, 50)
    const hasLast = textOk(r.last_name, 50)
    if (hasFirst !== hasLast) push('KU31_NAME_INCOMPLETE', '216', 'Ange både förnamn och efternamn.', spec)
    if (kind === 'samordningsnummer') {
      // Controls 142-146: a samordningsnummer needs the name and the address.
      if (!hasFirst || !hasLast) push('KU31_NAME_REQUIRED', '216', 'En mottagare med samordningsnummer behöver för- och efternamn.', spec)
      if (!textOk(r.street, 50) || !textOk(r.postal_code, 9) || !textOk(r.city, 50)) {
        push('KU31_ADDRESS_REQUIRED', '218', 'En mottagare med samordningsnummer behöver gatuadress, postnummer och postort.', spec)
      }
    }
  }
  return issues
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** One component element, with its field code when it has one. */
export function el(name: string, value: string | number, faltkod?: string): string {
  const attr = faltkod ? ` faltkod="${faltkod}"` : ''
  return `<ku:${name}${attr}>${escapeXml(String(value))}</ku:${name}>`
}

/**
 * The opening of a Kontrolluppgifter file (schema 12.0) up to the first
 * blankett: the root, the Avsandare and the Blankettgemensamt with the
 * uppgiftslämnare and the contact person. The caller adds its blanketter
 * and closes with '</Skatteverket>'.
 */
export function kuFileOpening(input: Pick<KuFileCommon, 'payer_org_number' | 'contact' | 'program_name'> & { created_at: string }): string[] {
  const payer = fileOrgNumber(input.payer_org_number)
  const contact = (tag: 'Kontaktperson' | 'TekniskKontaktperson') =>
    [`    <ku:${tag}>`, `      ${el('Namn', input.contact.name)}`, `      ${el('Telefon', input.contact.phone)}`, `      ${el('Epostadress', input.contact.email)}`, `    </ku:${tag}>`]
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    `<Skatteverket xmlns="${KU31_NAMESPACE}" xmlns:gm="${KU31_COMMON_NAMESPACE}" xmlns:ku="${KU31_COMPONENT_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" omrade="Kontrolluppgifter" xsi:schemaLocation="${KU31_SCHEMA_LOCATION}">`,
    '  <ku:Avsandare>',
    `    ${el('Programnamn', input.program_name)}`,
    `    ${el('Organisationsnummer', payer)}`,
    ...contact('TekniskKontaktperson'),
    `    ${el('Skapad', input.created_at)}`,
    '  </ku:Avsandare>',
    '  <ku:Blankettgemensamt>',
    '    <ku:Uppgiftslamnare>',
    `      ${el('UppgiftslamnarePersOrgnr', payer)}`,
    ...contact('Kontaktperson').map((line) => `  ${line}`),
    '    </ku:Uppgiftslamnare>',
    '  </ku:Blankettgemensamt>',
  ]
}

export class Ku31ValidationError extends Error {
  constructor(readonly issues: Ku31Issue[]) {
    super(`KU31 file invalid: ${issues.map((i) => i.code).join(', ')}`)
    this.name = 'Ku31ValidationError'
  }
}

/** The KU31 XML file. Throws Ku31ValidationError when validateKu31File finds anything. */
export function buildKu31Xml(input: Ku31FileInput): string {
  const issues = validateKu31File(input)
  if (issues.length > 0) throw new Ku31ValidationError(issues)
  const payer = fileOrgNumber(input.payer_org_number)
  const year = String(input.income_year)
  const out: string[] = kuFileOpening(input)
  for (const r of [...input.recipients].sort((a, b) => a.specification_number - b.specification_number)) {
    const kind = personIdentityKind(r.identity)
    const recipient = [el('Inkomsttagare', r.identity, '215')]
    if (r.first_name && r.last_name) {
      recipient.push(el('Fornamn', r.first_name.trim(), '216'), el('Efternamn', r.last_name.trim(), '217'))
    }
    if (kind === 'samordningsnummer') {
      recipient.push(el('Gatuadress', r.street!.trim(), '218'), el('Postnummer', r.postal_code!.trim(), '219'), el('Postort', r.city!.trim(), '220'))
    }
    out.push(
      `  <ku:Blankett nummer="${KU31_BLANKETT_NUMBER}">`,
      '    <ku:Arendeinformation>',
      `      ${el('Arendeagare', payer)}`,
      `      ${el('Period', year)}`,
      '    </ku:Arendeinformation>',
      '    <ku:Blankettinnehall>',
      '      <ku:KU31>',
      '        <ku:UppgiftslamnareKU31>',
      `          ${el('UppgiftslamnarId', payer, '201')}`,
      `          ${el('NamnUppgiftslamnare', input.payer_name, '202')}`,
      '        </ku:UppgiftslamnareKU31>',
      `        ${input.famansforetag ? el('Delagare', 1, '061') : el('DelagareEjFamansforetag', 1, '062')}`,
      `        ${el('Inkomstar', year, '203')}`,
      `        ${el('Specifikationsnummer', r.specification_number, '570')}`,
      `        ${el('VPNamn', input.share_name, '571')}`,
      `        ${el('UtbetaldUtdelning', r.amount, '574')}`,
      '        <ku:InkomsttagareKU31>',
      ...recipient.map((line) => `          ${line}`),
      '        </ku:InkomsttagareKU31>',
      '      </ku:KU31>',
      '    </ku:Blankettinnehall>',
      '  </ku:Blankett>',
    )
  }
  out.push('</Skatteverket>', '')
  return out.join('\n')
}
