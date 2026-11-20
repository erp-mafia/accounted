/**
 * KU20 (Kontrolluppgift om ränteinkomst) for interest the company paid on a
 * loan from a natural person: the same Kontrolluppgifter file as KU31
 * (schema 12.0, inkomstår 2026; the envelope from lib/bolaget/capital/ku31-xml.ts),
 * one blankett 2323 per recipient.
 *
 * From Skatteverket's schema and field list (Kontrolluppgifter_COMPONENT_12.0.xsd,
 * KU20TYPE; "Field names and synchronisation checks 2026"):
 *
 *   KU20: AvdragenSkatt 001 (tax withheld), Delagare 061 (the recipient is a
 *   delägare in a fåmansföretag or a närstående), Inkomstar 203,
 *   RanteinkomstEjKonto 503 (interest not from a bank account: an owner
 *   loan), Specifikationsnummer 570, InkomsttagareKU20 (215, 216/217, and
 *   218-220 for a samordningsnummer), UppgiftslamnareKU20 (201, 202).
 *
 * Amounts are whole kronor with the öre dropped (SFF 2011:1261 22:1).
 * Control 070 (FK500 must exist without 205, 001, 503 and 504) holds because
 * 503 is always written; control 071 (502 never with 503) because 502 is
 * never written. Pure: no I/O.
 */
import {
  el,
  fileOrgNumber,
  KU31_INCOME_YEAR,
  kuFileOpening,
  personIdentityKind,
  validateKuCommon,
  type Ku31Contact,
  type Ku31Issue,
} from '../capital/ku31-xml'

export const KU20_BLANKETT_NUMBER = '2323'
/** The inkomstår schema 12.0 is for (the same file as KU31). */
export const KU20_INCOME_YEAR = KU31_INCOME_YEAR

export interface Ku20Recipient {
  specification_number: number
  /** 12 digits: personnummer or samordningsnummer with century. */
  identity: string
  first_name: string | null
  last_name: string | null
  street: string | null
  postal_code: string | null
  city: string | null
  /** Field 503, whole kronor. */
  interest: number
  /** Field 001, whole kronor (0 is not written). */
  tax_withheld: number
  /** Field 061. */
  delagare: boolean
}

export interface Ku20FileInput {
  income_year: number
  payer_org_number: string
  payer_name: string
  contact: Ku31Contact
  /** Local time, YYYY-MM-DDTHH:MM:SS. */
  created_at: string
  program_name: string
  recipients: Ku20Recipient[]
}

function textOk(value: string | null | undefined, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

export function validateKu20File(input: Ku20FileInput): Ku31Issue[] {
  const issues = validateKuCommon(input, 'KU20')
  const push = (code: string, field: string, message_sv: string, specification_number: number) => issues.push({ code, field, message_sv, specification_number })
  if (input.recipients.length === 0) {
    issues.push({ code: 'KU20_NO_RECIPIENTS', field: 'Blankett', message_sv: 'Det finns ingen ränta till fysiska personer att lämna kontrolluppgift för.' })
  }
  const specs = new Set<number>()
  for (const r of input.recipients) {
    const spec = r.specification_number
    if (!Number.isInteger(spec) || spec < 1 || spec > 9_999_999_999) push('KU20_SPECIFICATION_NUMBER', '570', 'Specifikationsnumret är ogiltigt.', spec)
    if (specs.has(spec)) push('KU20_SPECIFICATION_DUPLICATE', '570', 'Två kontrolluppgifter har samma specifikationsnummer.', spec)
    specs.add(spec)
    const kind = personIdentityKind(r.identity)
    if (!kind) push('KU20_IDENTITY_INVALID', '215', 'Personnumret är ogiltigt.', spec)
    if (r.identity === fileOrgNumber(input.payer_org_number)) push('KU20_IDENTITY_IS_PAYER', '215', 'Mottagaren kan inte vara bolaget självt.', spec)
    if (!Number.isInteger(r.interest) || r.interest < 0 || r.interest > 9_999_999_999) push('KU20_INTEREST', '503', 'Räntebeloppet är ogiltigt.', spec)
    if (!Number.isInteger(r.tax_withheld) || r.tax_withheld < 0 || r.tax_withheld > r.interest) push('KU20_TAX', '001', 'Den avdragna skatten är ogiltig.', spec)
    const hasFirst = textOk(r.first_name, 50)
    const hasLast = textOk(r.last_name, 50)
    if (hasFirst !== hasLast) push('KU20_NAME_INCOMPLETE', '216', 'Ange både förnamn och efternamn.', spec)
    if (kind === 'samordningsnummer') {
      if (!hasFirst || !hasLast) push('KU20_NAME_REQUIRED', '216', 'En mottagare med samordningsnummer behöver för- och efternamn.', spec)
      if (!textOk(r.street, 50) || !textOk(r.postal_code, 9) || !textOk(r.city, 50)) {
        push('KU20_ADDRESS_REQUIRED', '218', 'En mottagare med samordningsnummer behöver gatuadress, postnummer och postort.', spec)
      }
    }
  }
  return issues
}

export class Ku20ValidationError extends Error {
  constructor(readonly issues: Ku31Issue[]) {
    super(`KU20 file invalid: ${issues.map((i) => i.code).join(', ')}`)
    this.name = 'Ku20ValidationError'
  }
}

/** The KU20 XML file. Throws Ku20ValidationError when validateKu20File finds anything. */
export function buildKu20Xml(input: Ku20FileInput): string {
  const issues = validateKu20File(input)
  if (issues.length > 0) throw new Ku20ValidationError(issues)
  const payer = fileOrgNumber(input.payer_org_number)
  const year = String(input.income_year)
  const out = kuFileOpening(input)
  for (const r of [...input.recipients].sort((a, b) => a.specification_number - b.specification_number)) {
    const kind = personIdentityKind(r.identity)
    const recipient = [el('Inkomsttagare', r.identity, '215')]
    if (r.first_name && r.last_name) recipient.push(el('Fornamn', r.first_name.trim(), '216'), el('Efternamn', r.last_name.trim(), '217'))
    if (kind === 'samordningsnummer') {
      recipient.push(el('Gatuadress', r.street!.trim(), '218'), el('Postnummer', r.postal_code!.trim(), '219'), el('Postort', r.city!.trim(), '220'))
    }
    const fields: string[] = []
    if (r.tax_withheld > 0) fields.push(el('AvdragenSkatt', r.tax_withheld, '001'))
    if (r.delagare) fields.push(el('Delagare', 1, '061'))
    fields.push(el('Inkomstar', year, '203'), el('RanteinkomstEjKonto', r.interest, '503'), el('Specifikationsnummer', r.specification_number, '570'))
    out.push(
      `  <ku:Blankett nummer="${KU20_BLANKETT_NUMBER}">`,
      '    <ku:Arendeinformation>',
      `      ${el('Arendeagare', payer)}`,
      `      ${el('Period', year)}`,
      '    </ku:Arendeinformation>',
      '    <ku:Blankettinnehall>',
      '      <ku:KU20>',
      ...fields.map((f) => `        ${f}`),
      '        <ku:InkomsttagareKU20>',
      ...recipient.map((line) => `          ${line}`),
      '        </ku:InkomsttagareKU20>',
      '        <ku:UppgiftslamnareKU20>',
      `          ${el('UppgiftslamnarId', payer, '201')}`,
      `          ${el('NamnUppgiftslamnare', input.payer_name, '202')}`,
      '        </ku:UppgiftslamnareKU20>',
      '      </ku:KU20>',
      '    </ku:Blankettinnehall>',
      '  </ku:Blankett>',
    )
  }
  out.push('</Skatteverket>', '')
  return out.join('\n')
}
