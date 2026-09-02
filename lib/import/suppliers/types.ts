import type { SupplierType } from '@/types'

/** Result of auto-detecting columns in a supplier register file. */
export interface DetectedSupplierColumns {
  name_col: number
  org_number_col: number | null
  supplier_type_col: number | null
  email_col: number | null
  phone_col: number | null
  address_line1_col: number | null
  address_line2_col: number | null
  postal_code_col: number | null
  city_col: number | null
  country_col: number | null
  vat_number_col: number | null
  bankgiro_col: number | null
  plusgiro_col: number | null
  bank_account_col: number | null
  iban_col: number | null
  bic_col: number | null
  payment_terms_col: number | null
  default_currency_col: number | null
  notes_col: number | null
  /** 0-1 confidence score for the detection */
  confidence: number
}

/** A single parsed row from the supplier register file. */
export interface ParsedSupplierRow {
  row_index: number
  name: string
  supplier_type: SupplierType
  org_number: string | null
  email: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string
  vat_number: string | null
  bankgiro: string | null
  plusgiro: string | null
  bank_account: string | null
  iban: string | null
  bic: string | null
  default_payment_terms: number
  default_currency: string
  notes: string | null
  is_valid: boolean
  validation_errors: string[]
}

/** Supplier-row + dedup annotation produced by the API route. */
export interface AnnotatedSupplierRow extends ParsedSupplierRow {
  duplicate_match: {
    supplier_id: string
    matched_by: 'org_number' | 'email'
    existing_name: string
  } | null
}

/** Full result from parsing a supplier register file. */
export interface SupplierImportParseResult {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedSupplierColumns
  headers: string[]
  preview_rows: string[][]
  rows: AnnotatedSupplierRow[]
  duplicate_count: number
  warnings: string[]
}


/** Result of executing the supplier import. */
export interface SupplierImportExecuteResult {
  success: boolean
  created: number
  updated: number
  skipped: number
  failed: number
  errors: { row_index: number; name: string; reason: string }[]
}
