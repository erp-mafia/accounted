import type { CustomerType } from '@/types'
import { detectCustomerColumns } from './column-detector'
import { cellOrNull, parsePaymentTerms } from '../shared/column-utils'
import { classifyCustomer } from '../shared/classify'
import {
  COUNTRY_CONSISTENCY_MESSAGES,
  checkCountryConsistency,
  defaultCountryForParty,
  normalizeCountryCode,
} from '@/lib/vat/country-codes'
import { readBestSheet } from '../shared/workbook-reader'
import type {
  DetectedCustomerColumns,
  ParsedCustomerRow,
} from './types'

const VALID_CUSTOMER_TYPES: CustomerType[] = [
  'individual',
  'swedish_business',
  'eu_business',
  'non_eu_business',
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeCustomerType(value: string | null): CustomerType | null {
  if (!value) return null
  const lower = value.toLowerCase().trim()
  if (lower === 'individual' || lower === 'privat' || lower === 'privatperson' || lower === 'person') {
    return 'individual'
  }
  if (lower === 'swedish_business' || lower === 'swedish' || lower === 'företag' || lower === 'foretag' || lower === 'business' || lower === 'ab' || lower === 'aktiebolag') {
    return 'swedish_business'
  }
  if (lower === 'eu_business' || lower === 'eu') {
    return 'eu_business'
  }
  if (lower === 'non_eu_business' || lower === 'non-eu' || lower === 'utomeu' || lower === 'utländsk' || lower === 'utlandsk') {
    return 'non_eu_business'
  }
  return VALID_CUSTOMER_TYPES.includes(lower as CustomerType)
    ? (lower as CustomerType)
    : null
}

/**
 * Parse a customer-register file (Excel or CSV) and return structured rows.
 *
 * @param buffer - Raw file buffer
 * @param filename - Original filename
 * @param columnOverrides - Optional manual column mapping
 */
export function parseCustomersFile(
  buffer: ArrayBuffer,
  filename: string,
  columnOverrides?: DetectedCustomerColumns,
): {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedCustomerColumns
  headers: string[]
  preview_rows: string[][]
  rows: ParsedCustomerRow[]
  warnings: string[]
} {
  const { sheetName, rawData } = readBestSheet(buffer, filename)

  if (rawData.length < 2) {
    const fallbackColumns: DetectedCustomerColumns = columnOverrides ?? {
      name_col: 0,
      org_number_col: null,
      customer_type_col: null,
      email_col: null,
      phone_col: null,
      address_line1_col: null,
      address_line2_col: null,
      postal_code_col: null,
      city_col: null,
      country_col: null,
      vat_number_col: null,
      payment_terms_col: null,
      notes_col: null,
      confidence: 0,
    }
    return {
      filename,
      sheet_name: sheetName,
      total_rows: 0,
      detected_columns: fallbackColumns,
      headers: rawData[0]?.map((h) => String(h)) || [],
      preview_rows: [],
      rows: [],
      warnings: ['Filen innehåller för få rader.'],
    }
  }

  const headers = rawData[0].map((h) => String(h))
  const dataRows = rawData.slice(1)
  const columns = columnOverrides || detectCustomerColumns(headers)

  const rows: ParsedCustomerRow[] = []
  const warnings: string[] = []

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const name = cellOrNull(row[columns.name_col])
    if (!name) continue // skip empty rows silently

    const orgNumber = columns.org_number_col !== null
      ? cellOrNull(row[columns.org_number_col])
      : null
    const email = columns.email_col !== null
      ? cellOrNull(row[columns.email_col])
      : null
    const phone = columns.phone_col !== null
      ? cellOrNull(row[columns.phone_col])
      : null
    const addressLine1 = columns.address_line1_col !== null
      ? cellOrNull(row[columns.address_line1_col])
      : null
    const addressLine2 = columns.address_line2_col !== null
      ? cellOrNull(row[columns.address_line2_col])
      : null
    const postalCode = columns.postal_code_col !== null
      ? cellOrNull(row[columns.postal_code_col])
      : null
    const city = columns.city_col !== null
      ? cellOrNull(row[columns.city_col])
      : null
    const countryRaw = columns.country_col !== null
      ? cellOrNull(row[columns.country_col])
      : null
    const vatNumber = columns.vat_number_col !== null
      ? cellOrNull(row[columns.vat_number_col])
      : null
    const paymentTermsRaw = columns.payment_terms_col !== null
      ? row[columns.payment_terms_col]
      : null
    const notes = columns.notes_col !== null
      ? cellOrNull(row[columns.notes_col])
      : null

    const explicitType = columns.customer_type_col !== null
      ? normalizeCustomerType(cellOrNull(row[columns.customer_type_col]))
      : null
    const customerType: CustomerType =
      explicitType ?? classifyCustomer({
        org_number: orgNumber,
        vat_number: vatNumber,
        country: countryRaw,
      })

    // ISO 3166-1 alpha-2 (customers.country is a code). A name the register
    // cannot map is kept as typed so the preview can show it and the row is
    // flagged. A missing country follows the type: SE for Swedish types,
    // the VAT prefix for an EU business, nothing for a non-EU business.
    const derivedCountry = countryRaw ? null : defaultCountryForParty(customerType, vatNumber)
    const country = countryRaw
      ? (normalizeCountryCode(countryRaw) ?? countryRaw.trim())
      : (derivedCountry ?? 'SE')

    const validationErrors: string[] = []
    if (email && !EMAIL_RE.test(email)) {
      validationErrors.push('Ogiltig e-postadress')
    }
    if (countryRaw && !normalizeCountryCode(countryRaw)) {
      validationErrors.push(`Okänt land: ${countryRaw.trim()} (ange landskod, t.ex. SE eller DE)`)
    } else if (!countryRaw && !derivedCountry) {
      validationErrors.push('Land saknas (ange landskod, t.ex. NO eller US)')
    } else {
      const countryIssue = checkCountryConsistency({ partyType: customerType, country, vatNumber })
      if (countryIssue) validationErrors.push(COUNTRY_CONSISTENCY_MESSAGES[countryIssue].sv)
    }
    if (orgNumber && !/^[\d\s\-]{6,20}$/.test(orgNumber)) {
      validationErrors.push('Ogiltigt org-/personnummer')
    }

    rows.push({
      row_index: i + 2, // 1-based + header
      name,
      customer_type: customerType,
      org_number: orgNumber,
      email,
      phone,
      address_line1: addressLine1,
      address_line2: addressLine2,
      postal_code: postalCode,
      city,
      country,
      vat_number: vatNumber,
      default_payment_terms: parsePaymentTerms(paymentTermsRaw, 30),
      notes,
      is_valid: validationErrors.length === 0,
      validation_errors: validationErrors,
    })
  }

  if (rows.length === 0) {
    warnings.push('Inga giltiga kundrader hittades. Kontrollera att namnkolumnen är korrekt mappad.')
  }

  return {
    filename,
    sheet_name: sheetName,
    total_rows: rows.length,
    detected_columns: columns,
    headers,
    preview_rows: dataRows.slice(0, 5),
    rows,
    warnings,
  }
}
