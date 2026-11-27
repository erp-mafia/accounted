import type { SpendExpense, SpendExpenseKind } from '@accounted/connect-contract'
import type { SpendReason } from './evaluate'

export type SpendConnectionStatus = 'connecting' | 'active' | 'disconnected'
export type SpendConnectionHealth = 'ok' | 'degraded' | 'action_required'
export type SpendItemStatus = 'ready' | 'review' | 'rejected' | 'no_entry' | 'booked'
export type SpendConnectMode = 'oauth' | 'api_key'

/** A spend_connections row as members read it (the handle and the OAuth state hash are withheld from them). */
export interface SpendConnectionRow {
  id: string
  company_id: string
  provider: string
  provider_name: string
  route: 'connect'
  mode: SpendConnectMode
  provider_company_ref: string | null
  provider_company_name: string | null
  provider_org_number: string | null
  status: SpendConnectionStatus
  health: SpendConnectionHealth
  health_code: string | null
  next_run_at: string
  lease_until: string
  last_success_at: string | null
  last_error_code: string | null
  last_error_at: string | null
  failures_in_row: number
  master_data_sha256: string | null
  master_data_sent_at: string | null
  settings: Record<string, unknown>
  created_by: string | null
  created_at: string
  ended_by: string | null
  ended_at: string | null
  updated_at: string
}

/** The server-side row, with what only the server presents. Never leaves the server. */
export interface SpendConnectionServerRow extends SpendConnectionRow {
  connection_handle: string | null
  pending_state_sha256: string | null
  pending_expires_at: string | null
  pending_return_origin: string | null
}

/** The columns members may read, in one place so every select names the same set. */
export const SPEND_CONNECTION_COLUMNS =
  'id, company_id, provider, provider_name, route, mode, provider_company_ref, provider_company_name, provider_org_number, status, health, health_code, next_run_at, lease_until, last_success_at, last_error_code, last_error_at, failures_in_row, master_data_sha256, master_data_sent_at, settings, created_by, created_at, ended_by, ended_at, updated_at'

export const SPEND_CONNECTION_SERVER_COLUMNS = `${SPEND_CONNECTION_COLUMNS}, connection_handle, pending_state_sha256, pending_expires_at, pending_return_origin`

/** The model stored in spend_items.expense: Connect's expense without the provider's raw answer. */
export type SpendExpenseModel = Omit<SpendExpense, 'raw'>

/** A spend_items row without the model and the archived answer (lists). */
export interface SpendItemSummaryRow {
  id: string
  company_id: string
  connection_id: string
  provider: string
  external_id: string
  batch_ref: string | null
  kind: SpendExpenseKind
  expense_date: string
  currency: string
  amount: number
  merchant_name: string | null
  person_name: string | null
  status: SpendItemStatus
  reasons: SpendReason[]
  raw_sha256: string
  document_ids: string[]
  received_at: string
  receive_count: number
  ack_outcome: 'received' | 'rejected' | null
  acknowledged_at: string | null
  changed_after_booking: boolean
  latest_raw_sha256: string | null
  latest_received_at: string | null
  journal_entry_id: string | null
  booked_at: string | null
  booked_by: string | null
  created_at: string
  updated_at: string
}

export const SPEND_ITEM_SUMMARY_COLUMNS =
  'id, company_id, connection_id, provider, external_id, batch_ref, kind, expense_date, currency, amount, merchant_name, person_name, status, reasons, raw_sha256, document_ids, received_at, receive_count, ack_outcome, acknowledged_at, changed_after_booking, latest_raw_sha256, latest_received_at, journal_entry_id, booked_at, booked_by, created_at, updated_at'

/**
 * A detail read: the summary plus the model. Never the provider's raw answer;
 * that stays in the table for the archive export.
 */
export interface SpendItemRow extends SpendItemSummaryRow {
  expense: SpendExpenseModel
}

/** numeric columns arrive as strings from PostgREST. */
export function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export function normalizeItemSummary<T extends SpendItemSummaryRow>(row: T): T {
  return {
    ...row,
    amount: toNumber(row.amount),
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    document_ids: Array.isArray(row.document_ids) ? row.document_ids : [],
  }
}
