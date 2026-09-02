import type { CustomerType } from '@/types'

/** Result of auto-detecting columns in a customer register file. */
export interface DetectedCustomerColumns {
  name_col: number
  org_number_col: number | null
  customer_type_col: number | null
  email_col: number | null
  phone_col: number | null
  address_line1_col: number | null
  address_line2_col: number | null
  postal_code_col: number | null
  city_col: number | null
  country_col: number | null
  vat_number_col: number | null
  payment_terms_col: number | null
  notes_col: number | null
  /** 0-1 confidence score for the detection */
  confidence: number
}

/** A single parsed row from the customer register file. */
export interface ParsedCustomerRow {
  row_index: number
  name: string
  customer_type: CustomerType
  org_number: string | null
  email: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string
  vat_number: string | null
  default_payment_terms: number
  notes: string | null
  is_valid: boolean
  validation_errors: string[]
}

/** Customer-row + dedup annotation produced by the API route. */
export interface AnnotatedCustomerRow extends ParsedCustomerRow {
  duplicate_match: {
    customer_id: string
    matched_by: 'org_number' | 'email'
    existing_name: string
  } | null
}

/** Full result from parsing a customer register file. */
export interface CustomerImportParseResult {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedCustomerColumns
  headers: string[]
  preview_rows: string[][]
  rows: AnnotatedCustomerRow[]
  duplicate_count: number
  warnings: string[]
}

/** Result of executing the customer import. */
export interface CustomerImportExecuteResult {
  success: boolean
  created: number
  updated: number
  skipped: number
  failed: number
  errors: { row_index: number; name: string; reason: string }[]
}
