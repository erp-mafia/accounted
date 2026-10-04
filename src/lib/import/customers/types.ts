import type { CustomerType } from '@/types'
import type { ImportNotice } from '@/lib/import/notices'
import type { RegisterMatchKey } from '@/lib/import/shared/register-match'

/** Result of auto-detecting columns in a customer register file. */
export interface DetectedCustomerColumns {
  name_col: number
  customer_number_col: number | null
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
  customer_number: string | null
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
    matched_by: RegisterMatchKey
    existing_name: string
  } | null
  /**
   * Same name as an existing customer and nothing else matched
   * (lib/import/shared/register-match.ts). Only a suggestion: the review step
   * asks the user, who sets `confirmed_duplicate_of`. Absent in a response
   * from before this field existed.
   */
  possible_duplicate?: {
    customer_id: string
    existing_name: string
  } | null
  /** Set in the review step when the user says the row is that customer. */
  confirmed_duplicate_of?: string | null
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
  /** Structured twins of `warnings` (lib/import/notices.ts). */
  notices?: ImportNotice[]
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
