import type { ArticleType } from '@/types'
import type { ImportNotice } from '@/lib/import/notices'

/**
 * Keys per POST /api/import/articles/match, by count and by size; the
 * browser sends a larger file in as many batches as it needs. A key is about
 * 30 bytes of JSON plus its number and name, and its answer about 105 bytes
 * plus the matched article's name. Counting rows alone let a re-import of a
 * price list with long names (every row matched) answer past the hosted
 * 4.5 MB limit; with the request held to 2 MB the answer stays near
 * 72 bytes per key plus the request, about 3.4 MB at the row cap.
 */
export const ARTICLE_MATCH_MAX_ROWS = 20_000
export const ARTICLE_MATCH_MAX_BYTES = 2 * 1024 * 1024

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
  /** Structured twins of `warnings` (lib/import/notices.ts). */
  notices?: ImportNotice[]
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
  /** Structured twins of `warnings` (lib/import/notices.ts). */
  notices?: ImportNotice[]
}
