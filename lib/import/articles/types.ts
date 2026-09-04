import type { ArticleType } from '@/types'

/** Result of auto-detecting columns in an article register file. */
export interface DetectedArticleColumns {
  name_col: number
  article_number_col: number | null
  name_en_col: number | null
  type_col: number | null
  unit_col: number | null
  price_col: number | null
  currency_col: number | null
  vat_rate_col: number | null
  revenue_account_col: number | null
  cost_price_col: number | null
  ean_col: number | null
  housework_type_col: number | null
  notes_col: number | null
  /** 0-1 confidence score for the detection */
  confidence: number
}

/** A single parsed row from the article register file. */
export interface ParsedArticleRow {
  row_index: number
  name: string
  name_en: string | null
  article_number: string | null
  type: ArticleType
  unit: string
  /** Always stored EXCLUDING VAT. */
  price_excl_vat: number
  /** ISO 4217 price currency from the file's Valuta column; null = not in the
   *  file (imports as SEK). Validated against the currencies table at execute. */
  currency: string | null
  /** Integer percent, snapped to one of 0 | 6 | 12 | 25. */
  vat_rate: number
  /**
   * True when the VAT rate was inferred (snapped to the nearest statutory rate
   * or defaulted from an unparseable cell). Drives a "verify this" hint in the
   * edit step; cleared once the operator confirms the rate. Not persisted.
   */
  vat_rate_adjusted: boolean
  /** Optional BAS class 1-3 posting-account override (validated server-side). */
  revenue_account: string | null
  cost_price: number | null
  ean: string | null
  housework_type: string | null
  notes: string | null
  is_valid: boolean
  validation_errors: string[]
}

/** Article-row + dedup annotation produced by the parse route. */
export interface AnnotatedArticleRow extends ParsedArticleRow {
  duplicate_match: {
    article_id: string
    matched_by: 'article_number' | 'name'
    existing_name: string
  } | null
}

/** Full result from parsing an article register file. */
export interface ArticleImportParseResult {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedArticleColumns
  headers: string[]
  preview_rows: string[][]
  rows: AnnotatedArticleRow[]
  duplicate_count: number
  warnings: string[]
}

/** Result of executing the article import. */
export interface ArticleImportExecuteResult {
  success: boolean
  created: number
  updated: number
  skipped: number
  failed: number
  errors: { row_index: number; name: string; reason: string }[]
  /** Non-fatal notes (e.g. dropped revenue-account overrides). */
  warnings: string[]
}
