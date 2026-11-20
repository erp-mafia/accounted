import type { PosDay, PosTender, PosVatGroup } from '@accounted/connect-contract'
import type { PosReviewReason } from './evaluate'

export type PosConnectionStatus = 'connecting' | 'needs_setup' | 'active' | 'disconnected'
export type PosConnectionHealth = 'ok' | 'degraded' | 'action_required'
export type PosSalesDayStatus = 'ready' | 'needs_review' | 'empty' | 'booked'

/** A pos_connections row as members read it (connection_handle is withheld from them). */
export interface PosConnectionRow {
  id: string
  company_id: string
  provider: string
  provider_name: string
  route: 'connect'
  venue_ref: string
  venue_name: string
  status: PosConnectionStatus
  health: PosConnectionHealth
  health_code: string | null
  sync_from: string
  synced_through: string | null
  next_run_at: string
  lease_until: string
  last_success_at: string | null
  last_error_code: string | null
  last_error_at: string | null
  failures_in_row: number
  settings: Record<string, unknown>
  created_by: string | null
  created_at: string
  ended_by: string | null
  ended_at: string | null
  updated_at: string
}

/** The server-side row, with the handle Connect gave. Never leaves the server. */
export interface PosConnectionServerRow extends PosConnectionRow {
  connection_handle: string | null
}

/** A pos_sales_days row without the model and the archived answer (lists). */
export interface PosSalesDaySummaryRow {
  id: string
  company_id: string
  connection_id: string
  business_date: string
  currency: string
  status: PosSalesDayStatus
  review_reasons: PosReviewReason[]
  gross: number
  net: number
  vat: number
  tips: number
  receipt_count: number
  tenders: PosTender[]
  vat_groups: PosVatGroup[]
  raw_sha256: string
  fetched_at: string
  fetch_count: number
  changed_after_booking: boolean
  latest_raw_sha256: string | null
  latest_fetched_at: string | null
  journal_entry_id: string | null
  booked_at: string | null
  booked_by: string | null
  created_at: string
  updated_at: string
}

/**
 * A detail read: the summary plus the model. Never the provider's raw answer
 * (it can be megabytes); that stays in the table for the archive export.
 */
export interface PosSalesDayRow extends PosSalesDaySummaryRow {
  day: PosDay
}

/** numeric columns arrive as strings from PostgREST. */
export function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export function normalizeDaySummary<T extends PosSalesDaySummaryRow>(row: T): T {
  return {
    ...row,
    gross: toNumber(row.gross),
    net: toNumber(row.net),
    vat: toNumber(row.vat),
    tips: toNumber(row.tips),
    review_reasons: Array.isArray(row.review_reasons) ? row.review_reasons : [],
    tenders: Array.isArray(row.tenders) ? row.tenders : [],
    vat_groups: Array.isArray(row.vat_groups) ? row.vat_groups : [],
  }
}
