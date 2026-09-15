import { escapeXml } from '@/lib/xml/escape'
import { stripOrgNumberFormatting } from '@/lib/invariants/org-number'

/**
 * KU55: kontrolluppgift om överlåtelse av bostadsrätt.
 *
 * SFL (2011:1244) 22 kap. 2 §: a privatbostadsföretag (and an oäkta
 * bostadsföretag) reports every överlåtelse of a bostadsrätt to Skatteverket,
 * one kontrolluppgift per överlåtare, by 31 January of the year after the
 * income year (SFL 24 kap. 1 §). Fields and XML element names follow
 * Skatteverket's Kontrolluppgifter 12.0 schema (income year 2026), verified
 * against Kontrolluppgifter_COMPONENT_12.0.xsd and Skatteverket's example
 * file "KONTROLLUPPGIFT ÖVERLÅTELSE AV BOSTADSRÄTT (KU55) FÖR
 * BOSTADSRÄTTSFÖRENINGAR_2026.xml":
 *
 *   215 Inkomsttagare (personnummer, 12 digits) or 216-222 name/address/
 *       födelsetid when the personnummer is unknown
 *   201 UppgiftslamnarId, 202 NamnUppgiftslamnare, 203 Inkomstar,
 *   570 Specifikationsnummer (unique per uppgiftslämnare and year)
 *   630 BostRattBeteckning, 631 Overlatelsedatum (ÅÅÅÅMMDD),
 *   632 OverlatenAndel (percent, two decimals), 633 OverlatelseArvBodeln,
 *   634 Overlatelsepris, 635 InreRepFondOverlatelse, 636 Kapitaltillskott,
 *   638 OaktaBostadsftg, 639 Tillaggskopeskilling, 640 Forvarvsdatum,
 *   642 ForvarvArvBodeln, 643 Forvarvspris, 644 InreRepFondForvarv,
 *   645 AndelBRFFormogenhet1974, 646 GemensamIndividuell (G or I).
 *
 * Amounts are whole kronor (Belopp7TYPE/Belopp10TYPE are xs:long), dates
 * ÅÅÅÅMMDD, flags "1". A KU55 without an identity (no personnummer on the
 * member) is reported as incomplete: it is listed in JSON with a reason and
 * left out of the XML file, because Skatteverket rejects a kontrolluppgift
 * without an inkomsttagare.
 */

export interface KU55Company {
  orgNumber: string
  companyName: string
  incomeYear: number
  contactName: string
  contactPhone: string
  contactEmail: string
  programName: string
  /** ISO timestamp for <Skapad>; defaults to now. */
  createdAt?: string
}

export interface KU55Transfer {
  transferId: string
  specificationNumber: number
  apartmentNumber: string
  transferDate: string
  /** 0 < share <= 1 */
  share: number
  kind: 'sale' | 'gift' | 'arv' | 'bodelning' | 'other'
  price: number | null
  additionalPrice: number | null
  forvarvDate: string | null
  forvarvGenomArvGavaBodelning: boolean
  forvarvPrice: number | null
  kapitaltillskott: number | null
  inreFondVidOverlatelse: number | null
  inreFondVidForvarv: number | null
  andelFormogenhet1974: number | null
  gemensamIndividuell: 'G' | 'I'
  /** True when the association was oäkta at the start of the income year. */
  oaktaBostadsforetag: boolean
  seller: {
    memberId: string
    name: string
    /** Decrypted 10- or 12-digit personnummer, or null when unknown. */
    personalNumber: string | null
    postalAddress: string | null
  }
}

export interface KU55Item {
  transfer_id: string
  specification_number: number
  seller_member_id: string
  complete: boolean
  problems: string[]
  fields: Record<string, string | number>
}

const KU_ORG_NUMBER_PATTERN = /^16\d{2}[2-9]\d{7}$/

/** Skatteverket's 12-digit organisationsnummer with the 16 prefix. */
export function normalizeKu55OrgNumber(raw: string): string {
  const cleaned = stripOrgNumberFormatting(raw)
  const normalized = /^\d{10}$/.test(cleaned) ? `16${cleaned}` : cleaned
  if (!KU_ORG_NUMBER_PATTERN.test(normalized)) {
    throw new Error(
      'KU55 kan inte genereras: organisationsnumret måste innehålla 10 siffror eller 12 siffror med prefixet 16.',
    )
  }
  return normalized
}

/**
 * Twelve-digit personnummer. A ten-digit number gets its century from the
 * income year: a person cannot sell a bostadsrätt before being born, so a
 * two-digit year above the income year's last two digits belongs to the
 * previous century.
 */
export function normalizePersonalNumber(raw: string, incomeYear: number): string | null {
  const digits = raw.replace(/[\s-]/g, '').replace('+', '')
  if (/^\d{12}$/.test(digits)) return digits
  if (/^\d{10}$/.test(digits)) {
    const yy = Number(digits.slice(0, 2))
    const century = yy > incomeYear % 100 ? 19 : 20
    // A '+' separator means the person is over 100 years old.
    const older = raw.includes('+') ? century - 1 : century
    return `${older}${digits}`
  }
  return null
}

const ymd = (iso: string): string => iso.slice(0, 10).replace(/-/g, '')
const kronor = (value: number): number => Math.round(value)

/** Build the field map of one KU55 (pure, no XML). */
export function buildKU55Item(transfer: KU55Transfer, incomeYear: number): KU55Item {
  const problems: string[] = []
  const fields: Record<string, string | number> = {}
  const pnr = transfer.seller.personalNumber
    ? normalizePersonalNumber(transfer.seller.personalNumber, incomeYear)
    : null
  if (pnr) {
    fields['215'] = pnr
  } else {
    problems.push(
      `Personnummer saknas för överlåtaren ${transfer.seller.name}: registrera det på medlemmen (PUT /api/brf/members/{id}/personal-number).`,
    )
  }
  fields['203'] = incomeYear
  fields['570'] = transfer.specificationNumber
  fields['630'] = transfer.apartmentNumber
  fields['631'] = ymd(transfer.transferDate)
  fields['632'] = (transfer.share * 100).toFixed(2)
  if (transfer.kind !== 'sale') fields['633'] = 1
  if (transfer.kind === 'sale') {
    if (transfer.price === null) {
      problems.push('Överlåtelsepris saknas för en försäljning (fältkod 634).')
    } else {
      fields['634'] = kronor(transfer.price)
    }
  }
  if (transfer.inreFondVidOverlatelse !== null) fields['635'] = kronor(transfer.inreFondVidOverlatelse)
  if (transfer.kapitaltillskott !== null) fields['636'] = kronor(transfer.kapitaltillskott)
  if (transfer.oaktaBostadsforetag) fields['638'] = 1
  if (transfer.additionalPrice !== null && transfer.additionalPrice > 0) {
    fields['639'] = kronor(transfer.additionalPrice)
  }
  if (transfer.forvarvDate) {
    fields['640'] = ymd(transfer.forvarvDate)
  } else {
    problems.push('Förvärvsdatum saknas (fältkod 640).')
  }
  if (transfer.forvarvGenomArvGavaBodelning) fields['642'] = 1
  if (transfer.forvarvPrice !== null) fields['643'] = kronor(transfer.forvarvPrice)
  if (transfer.inreFondVidForvarv !== null) fields['644'] = kronor(transfer.inreFondVidForvarv)
  if (transfer.andelFormogenhet1974 !== null) fields['645'] = kronor(transfer.andelFormogenhet1974)
  fields['646'] = transfer.gemensamIndividuell
  // Missing förvärvsdatum is a warning (Skatteverket accepts the KU and the
  // seller completes the deklaration); a missing identity or price blocks.
  const blocking = problems.filter((p) => !p.startsWith('Förvärvsdatum'))
  return {
    transfer_id: transfer.transferId,
    specification_number: transfer.specificationNumber,
    seller_member_id: transfer.seller.memberId,
    complete: blocking.length === 0,
    problems,
    fields,
  }
}

/**
 * The XML file for Skatteverket's filöverföring: only complete items.
 * Envelope per Kontrolluppgifter_12.0.xsd (Avsandare, Blankettgemensamt,
 * one Blankett per kontrolluppgift).
 */
export function generateKU55Xml(company: KU55Company, items: KU55Item[]): string {
  const orgNr = normalizeKu55OrgNumber(company.orgNumber)
  const created = (company.createdAt ?? new Date().toISOString()).slice(0, 19)
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')
  lines.push(
    '<Skatteverket xmlns="http://xmls.skatteverket.se/se/skatteverket/ai/instans/infoForBeskattning/12.0"',
  )
  lines.push('  xmlns:gm="http://xmls.skatteverket.se/se/skatteverket/ai/gemensamt/infoForBeskattning/12.0"')
  lines.push('  xmlns:ku="http://xmls.skatteverket.se/se/skatteverket/ai/komponent/infoForBeskattning/12.0"')
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" omrade="Kontrolluppgifter"')
  lines.push(
    '  xsi:schemaLocation="http://xmls.skatteverket.se/se/skatteverket/ai/instans/infoForBeskattning/12.0 http://xmls.skatteverket.se/se/skatteverket/ai/kontrolluppgift/instans/Kontrolluppgifter_12.0.xsd">',
  )
  lines.push('  <ku:Avsandare>')
  lines.push(`    <ku:Programnamn>${escapeXml(company.programName)}</ku:Programnamn>`)
  lines.push(`    <ku:Organisationsnummer>${orgNr}</ku:Organisationsnummer>`)
  lines.push('    <ku:TekniskKontaktperson>')
  lines.push(`      <ku:Namn>${escapeXml(company.contactName)}</ku:Namn>`)
  lines.push(`      <ku:Telefon>${escapeXml(company.contactPhone)}</ku:Telefon>`)
  lines.push(`      <ku:Epostadress>${escapeXml(company.contactEmail)}</ku:Epostadress>`)
  lines.push('    </ku:TekniskKontaktperson>')
  lines.push(`    <ku:Skapad>${created}</ku:Skapad>`)
  lines.push('  </ku:Avsandare>')
  lines.push('  <ku:Blankettgemensamt>')
  lines.push('    <ku:Uppgiftslamnare>')
  lines.push(`      <ku:UppgiftslamnarePersOrgnr>${orgNr}</ku:UppgiftslamnarePersOrgnr>`)
  lines.push('      <ku:Kontaktperson>')
  lines.push(`        <ku:Namn>${escapeXml(company.contactName)}</ku:Namn>`)
  lines.push(`        <ku:Telefon>${escapeXml(company.contactPhone)}</ku:Telefon>`)
  lines.push(`        <ku:Epostadress>${escapeXml(company.contactEmail)}</ku:Epostadress>`)
  lines.push('        <ku:Sakomrade>Skatteverket</ku:Sakomrade>')
  lines.push('      </ku:Kontaktperson>')
  lines.push('    </ku:Uppgiftslamnare>')
  lines.push('  </ku:Blankettgemensamt>')

  const el = (name: string, code: string, value: string | number | undefined): void => {
    if (value === undefined) return
    lines.push(`        <ku:${name} faltkod="${code}">${escapeXml(String(value))}</ku:${name}>`)
  }
  let blankett = 1
  for (const item of items) {
    if (!item.complete) continue
    const f = item.fields
    lines.push(`  <ku:Blankett nummer="${blankett++}">`)
    lines.push('    <ku:Arendeinformation>')
    lines.push(`      <ku:Arendeagare>${orgNr}</ku:Arendeagare>`)
    lines.push(`      <ku:Period>${company.incomeYear}</ku:Period>`)
    lines.push('    </ku:Arendeinformation>')
    lines.push('    <ku:Blankettinnehall>')
    lines.push('      <ku:KU55>')
    lines.push('        <ku:InkomsttagareKU55>')
    lines.push(`          <ku:Inkomsttagare faltkod="215">${escapeXml(String(f['215']))}</ku:Inkomsttagare>`)
    lines.push('        </ku:InkomsttagareKU55>')
    lines.push('        <ku:UppgiftslamnareKU55>')
    lines.push(`          <ku:UppgiftslamnarId faltkod="201">${orgNr}</ku:UppgiftslamnarId>`)
    lines.push(
      `          <ku:NamnUppgiftslamnare faltkod="202">${escapeXml(company.companyName)}</ku:NamnUppgiftslamnare>`,
    )
    lines.push('        </ku:UppgiftslamnareKU55>')
    el('Inkomstar', '203', f['203'])
    el('Specifikationsnummer', '570', f['570'])
    el('BostRattBeteckning', '630', f['630'])
    el('Overlatelsedatum', '631', f['631'])
    el('OverlatenAndel', '632', f['632'])
    el('OverlatelseArvBodeln', '633', f['633'])
    el('Overlatelsepris', '634', f['634'])
    el('InreRepFondOverlatelse', '635', f['635'])
    el('Kapitaltillskott', '636', f['636'])
    el('OaktaBostadsftg', '638', f['638'])
    el('Tillaggskopeskilling', '639', f['639'])
    el('Forvarvsdatum', '640', f['640'])
    el('ForvarvArvBodeln', '642', f['642'])
    el('Forvarvspris', '643', f['643'])
    el('InreRepFondForvarv', '644', f['644'])
    el('AndelBRFFormogenhet1974', '645', f['645'])
    el('GemensamIndividuell', '646', f['646'])
    lines.push('      </ku:KU55>')
    lines.push('    </ku:Blankettinnehall>')
    lines.push('  </ku:Blankett>')
  }
  lines.push('</Skatteverket>')
  return lines.join('\n')
}
