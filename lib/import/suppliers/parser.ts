import type { SupplierType } from '@/types'
import { detectSupplierColumns } from './column-detector'
import { cellOrNull, parsePaymentTerms } from '../shared/column-utils'
import { classifySupplier } from '../shared/classify'
import { normalizeCountryCode } from '@/lib/vat/country-codes'
import { readBestSheet } from '../shared/workbook-reader'
import type {
  DetectedSupplierColumns,
  ParsedSupplierRow,
} from './types'

const VALID_SUPPLIER_TYPES: SupplierType[] = [
  'swedish_business',
  'eu_business',
  'non_eu_business',
]

const VALID_CURRENCIES = new Set(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'])

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeSupplierType(value: string | null): SupplierType | null {
  if (!value) return null
  const lower = value.toLowerCase().trim()
  if (lower === 'swedish_business' || lower === 'swedish' || lower === 'svensk' || lower === 'företag' || lower === 'foretag' || lower === 'business' || lower === 'ab' || lower === 'aktiebolag') {
    return 'swedish_business'
  }
  if (lower === 'eu_business' || lower === 'eu') {
    return 'eu_business'
  }
  if (lower === 'non_eu_business' || lower === 'non-eu' || lower === 'utomeu' || lower === 'utländsk' || lower === 'utlandsk') {
    return 'non_eu_business'
  }
  return VALID_SUPPLIER_TYPES.includes(lower as SupplierType)
    ? (lower as SupplierType)
    : null
}

/**
 * ISO 3166-1 alpha-2 (suppliers.country is a code). A name the register
 * cannot map is kept as typed so the preview can show it; the row is then
 * flagged invalid below and the execute route refuses it.
 */
function normalizeCountry(value: string | null): string {
  if (!value) return 'SE'
  return normalizeCountryCode(value) ?? value.trim()
}

function normalizeCurrency(value: string | null): string {
  if (!value) return 'SEK'
  const upper = value.trim().toUpperCase()
  return VALID_CURRENCIES.has(upper) ? upper : 'SEK'
}

function cleanGiroNumber(value: string | null): string | null {
  if (!value) return null
  const cleaned = value.replace(/[\s.]/g, '')
  return cleaned === '' ? null : cleaned
}

export function parseSuppliersFile(
  buffer: ArrayBuffer,
  filename: string,
  columnOverrides?: DetectedSupplierColumns,
): {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedSupplierColumns
  headers: string[]
  preview_rows: string[][]
  rows: ParsedSupplierRow[]
  warnings: string[]
} {
  const { sheetName, rawData } = readBestSheet(buffer, filename)

  if (rawData.length < 2) {
    const fallbackColumns: DetectedSupplierColumns = columnOverrides ?? {
      name_col: 0,
      org_number_col: null,
      supplier_type_col: null,
      email_col: null,
      phone_col: null,
      address_line1_col: null,
      address_line2_col: null,
      postal_code_col: null,
      city_col: null,
      country_col: null,
      vat_number_col: null,
      bankgiro_col: null,
      plusgiro_col: null,
      bank_account_col: null,
      iban_col: null,
      bic_col: null,
      payment_terms_col: null,
      default_currency_col: null,
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
  const columns = columnOverrides || detectSupplierColumns(headers)

  const rows: ParsedSupplierRow[] = []
  const warnings: string[] = []

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const name = cellOrNull(row[columns.name_col])
    if (!name) continue

    const get = (col: number | null) =>
      col !== null ? cellOrNull(row[col]) : null

    const orgNumber = get(columns.org_number_col)
    const email = get(columns.email_col)
    const phone = get(columns.phone_col)
    const addressLine1 = get(columns.address_line1_col)
    const addressLine2 = get(columns.address_line2_col)
    const postalCode = get(columns.postal_code_col)
    const city = get(columns.city_col)
    const countryRaw = get(columns.country_col)
    const country = normalizeCountry(countryRaw)
    const vatNumber = get(columns.vat_number_col)
    const bankgiro = cleanGiroNumber(get(columns.bankgiro_col))
    const plusgiro = cleanGiroNumber(get(columns.plusgiro_col))
    const bankAccount = get(columns.bank_account_col)
    const iban = get(columns.iban_col)?.replace(/\s/g, '').toUpperCase() ?? null
    const bic = get(columns.bic_col)?.replace(/\s/g, '').toUpperCase() ?? null
    const paymentTermsRaw = columns.payment_terms_col !== null
      ? row[columns.payment_terms_col]
      : null
    const currencyRaw = get(columns.default_currency_col)
    const notes = get(columns.notes_col)

    const explicitType = columns.supplier_type_col !== null
      ? normalizeSupplierType(cellOrNull(row[columns.supplier_type_col]))
      : null
    const supplierType: SupplierType =
      explicitType ?? classifySupplier({
        org_number: orgNumber,
        vat_number: vatNumber,
        country: countryRaw,
      })

    const validationErrors: string[] = []
    if (email && !EMAIL_RE.test(email)) {
      validationErrors.push('Ogiltig e-postadress')
    }
    if (countryRaw && !normalizeCountryCode(countryRaw)) {
      validationErrors.push(`Okänt land: ${countryRaw.trim()} (ange landskod, t.ex. SE eller DE)`)
    }
    if (orgNumber && !/^[\d\s\-]{6,20}$/.test(orgNumber)) {
      validationErrors.push('Ogiltigt org-/personnummer')
    }
    if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
      validationErrors.push('Ogiltigt IBAN')
    }

    rows.push({
      row_index: i + 2,
      name,
      supplier_type: supplierType,
      org_number: orgNumber,
      email,
      phone,
      address_line1: addressLine1,
      address_line2: addressLine2,
      postal_code: postalCode,
      city,
      country,
      vat_number: vatNumber,
      bankgiro,
      plusgiro,
      bank_account: bankAccount,
      iban,
      bic,
      default_payment_terms: parsePaymentTerms(paymentTermsRaw, 30),
      default_currency: normalizeCurrency(currencyRaw),
      notes,
      is_valid: validationErrors.length === 0,
      validation_errors: validationErrors,
    })
  }

  if (rows.length === 0) {
    warnings.push('Inga giltiga leverantörsrader hittades. Kontrollera att namnkolumnen är korrekt mappad.')
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
