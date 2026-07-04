import { decryptPersonnummer } from '../personnummer'
import { getBranding } from '@/lib/branding/service'

/**
 * KU10 (Kontrolluppgift): Annual employee income statement.
 *
 * Per Skatteförfarandelagen 15 kap: Every employer must file KU10 for each
 * employee by January 31 of the following year. Reports total income, tax
 * withheld, and benefit values for the calendar year.
 *
 * The KU10 is filed electronically via Skatteverket's Filöverföring or API.
 * XML format follows Skatteverket Teknisk beskrivning for KU.
 *
 * Penalties: Late filing = 500 SEK per KU per commenced 5-day period
 * (max 5,000 SEK per KU or 500,000 SEK total per filing deadline).
 */

export interface KU10EmployeeData {
  personnummer: string        // Encrypted, will be decrypted
  specificationNumber: number // FK570
  totalGross: number          // Ruta 011: Total kontant bruttolön for year
  totalTax: number            // Ruta 001: Total avdragen skatt for year
  totalAvgifterBasis: number  // Ruta 020: Total avgiftsunderlag
  benefitCar?: number         // Ruta 012: Total bilförmån
  benefitHousing?: number     // Ruta 014: Total bostadsförmån
  benefitMeals?: number       // Ruta 015: Total kostförmån
  benefitOther?: number       // Ruta 019: Total övrigt
  sickDays?: number           // Total sjukdagar
  employmentStart?: string    // YYYY-MM-DD
  employmentEnd?: string      // YYYY-MM-DD (if terminated during year)
}

export interface KU10CompanyData {
  orgNumber: string
  companyName: string
  year: number
  contactName: string
  contactPhone: string
  contactEmail: string
}

/**
 * Generate KU10 XML for all employees for a calendar year.
 *
 * Per BFL 7 kap: The KU10 file is räkenskapsinformation, retained 7 years.
 */
export function generateKU10Xml(
  company: KU10CompanyData,
  employees: KU10EmployeeData[]
): string {
  const lines: string[] = []
  const orgNr = company.orgNumber.replace('-', '')

  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<Skatteverket xmlns="http://xmls.skatteverket.se/se/skatteverket/ai/instans/infoForBeskworksgivku/1.0"')
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')

  // Avsändare
  lines.push('  <Avsandare>')
  lines.push(`    <Programnamn>${escapeXml(getBranding().appName.toLowerCase())}</Programnamn>`)
  lines.push(`    <Organisationsnummer>${orgNr}</Organisationsnummer>`)
  lines.push('    <TekniskKontaktperson>')
  lines.push(`      <Namn>${escapeXml(company.contactName)}</Namn>`)
  lines.push(`      <Telefon>${escapeXml(company.contactPhone)}</Telefon>`)
  lines.push(`      <Epostadress>${escapeXml(company.contactEmail)}</Epostadress>`)
  lines.push('    </TekniskKontaktperson>')
  lines.push('  </Avsandare>')

  // Blankettgemensamt
  lines.push('  <Blankettgemensamt>')
  lines.push(`    <Uppgiftslamnare>`)
  lines.push(`      <UppgijftslamnareId>${orgNr}</UppgijftslamnareId>`)
  lines.push(`      <NamnUppgiftslamnare>${escapeXml(company.companyName)}</NamnUppgiftslamnare>`)
  lines.push(`    </Uppgiftslamnare>`)
  lines.push('  </Blankettgemensamt>')

  // Per-employee KU10
  for (const emp of employees) {
    let pnr: string
    try {
      pnr = decryptPersonnummer(emp.personnummer)
    } catch {
      pnr = '000000000000'
    }

    lines.push('  <Blankett>')
    lines.push('    <Arendeinformation>')
    lines.push(`      <Arendeagare>${orgNr}</Arendeagare>`)
    lines.push(`      <Period>${company.year}</Period>`)
    lines.push('    </Arendeinformation>')
    lines.push('    <Blankettinnehall>')
    lines.push('      <KU10>')

    // Employee identification
    lines.push(`        <Personnummer faltkod="215">${pnr}</Personnummer>`)
    lines.push(`        <Specifikationsnummer faltkod="570">${emp.specificationNumber}</Specifikationsnummer>`)

    // Income and tax
    if (emp.totalGross > 0) {
      lines.push(`        <KontantBruttoloen faltkod="011">${Math.round(emp.totalGross)}</KontantBruttoloen>`)
    }
    if (emp.totalTax > 0) {
      lines.push(`        <AvdragenSkatt faltkod="001">${Math.round(emp.totalTax)}</AvdragenSkatt>`)
    }

    // Benefits
    if (emp.benefitCar && emp.benefitCar > 0) {
      lines.push(`        <FormanBil faltkod="012">${Math.round(emp.benefitCar)}</FormanBil>`)
    }
    if (emp.benefitHousing && emp.benefitHousing > 0) {
      lines.push(`        <FormanBostad faltkod="014">${Math.round(emp.benefitHousing)}</FormanBostad>`)
    }
    if (emp.benefitMeals && emp.benefitMeals > 0) {
      lines.push(`        <FormanKost faltkod="015">${Math.round(emp.benefitMeals)}</FormanKost>`)
    }
    if (emp.benefitOther && emp.benefitOther > 0) {
      lines.push(`        <FormanOvrigt faltkod="019">${Math.round(emp.benefitOther)}</FormanOvrigt>`)
    }

    // Avgifter basis
    if (emp.totalAvgifterBasis > 0) {
      lines.push(`        <UnderlagArbAvg faltkod="020">${Math.round(emp.totalAvgifterBasis)}</UnderlagArbAvg>`)
    }

    // Employment period (if not full year)
    if (emp.employmentStart) {
      lines.push(`        <Anstallningsdatum faltkod="008">${emp.employmentStart.replace(/-/g, '')}</Anstallningsdatum>`)
    }
    if (emp.employmentEnd) {
      lines.push(`        <Avgangsdatum faltkod="009">${emp.employmentEnd.replace(/-/g, '')}</Avgangsdatum>`)
    }

    lines.push('      </KU10>')
    lines.push('    </Blankettinnehall>')
    lines.push('  </Blankett>')
  }

  lines.push('</Skatteverket>')
  return lines.join('\n')
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
