import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CollectionsConnection,
  CollectionsConnectionState,
  CollectionsConnectionSubStatus,
} from '@accounted/connect-contract'
import {
  NO_COLLECTION_OBLIGATIONS,
  type CollectionObligations,
  type CollectionsConnectionFacts,
} from './flags'
import type { CollectionsRoute } from './port'

/**
 * The company's collections connection as the ledger stores it
 * (collection_connections, migration 20261004051856) and the pure mapping
 * from the provider's answer to the row. Reads only; the writes live in
 * connection-service.ts.
 */

export type ConnectionHealth = 'ok' | 'degraded' | 'action_required'
export type LadderMode = 'off' | 'staged'
export type StartStep = 'reminder' | 'collection'

/** What a person is asked to do about a connection in trouble. */
export const HEALTH_ACTIONS = ['retry_later', 'contact_support'] as const
export type HealthAction = (typeof HEALTH_ACTIONS)[number]

export interface ProviderTerms {
  version: string
  url: string | null
  accepted: boolean
}

export interface CollectionConnectionRow {
  id: string
  company_id: string
  user_id: string | null
  capability: 'collections'
  route: CollectionsRoute
  provider_ref: string
  display_name: string
  connection_handle: string | null
  provider_status: string | null
  provider_terms: ProviderTerms | null
  state: CollectionsConnectionState
  sub_status: CollectionsConnectionSubStatus | null
  health: ConnectionHealth | null
  health_cause: string | null
  health_action: HealthAction | null
  last_success_at: string | null
  last_error_code: string | null
  last_error_at: string | null
  failures_in_row: number
  catalogue_terms_version: string
  dpa_version: string | null
  consented_by: string
  consented_at: string
  terms_version: string | null
  terms_accepted_by: string | null
  terms_accepted_at: string | null
  submitted_at: string | null
  activated_at: string | null
  ended_by: string | null
  ended_at: string | null
  minimum_amount: number
  default_start_step: StartStep
  reminder_fee_terms_since: string | null
  late_interest_percent: number | null
  late_interest_agreed_since: string | null
  distribution_enabled: boolean
  ladder_mode: LadderMode | null
  ladder_days_after_due: number
  ladder_enabled_by: string | null
  ladder_enabled_at: string | null
  clearing_account: string
  payout_account: string
  auto_book_collected_payments: boolean
  auto_book_settlements: boolean
  created_at: string
  updated_at: string
}

/** numeric columns arrive as numbers from PostgREST, as strings from some drivers: one shape here. */
export function normalizeConnectionRow(raw: Record<string, unknown>): CollectionConnectionRow {
  const row = raw as unknown as CollectionConnectionRow
  return {
    ...row,
    minimum_amount: Number(row.minimum_amount),
    late_interest_percent: row.late_interest_percent === null ? null : Number(row.late_interest_percent),
    ladder_days_after_due: Number(row.ladder_days_after_due),
    failures_in_row: Number(row.failures_in_row ?? 0),
  }
}

/** The company's live connection (any state but disconnected), or null. */
export async function loadLiveConnection(
  client: Pick<SupabaseClient, 'from'>,
  companyId: string,
): Promise<CollectionConnectionRow | null> {
  const { data, error } = await client
    .from('collection_connections')
    .select('*')
    .eq('company_id', companyId)
    .neq('state', 'disconnected')
    .maybeSingle()
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  return data ? normalizeConnectionRow(data as Record<string, unknown>) : null
}

/** Open cases, unbooked collected payments and unbooked settlements, from the same function the database guard reads. */
export async function loadCollectionObligations(
  client: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
): Promise<CollectionObligations> {
  const { data, error } = await client.rpc('collection_obligation_counts', { p_company_id: companyId })
  if (error) throw new Error(`collection_obligation_counts failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as
    | { open_cases: number; unbooked_collected_payments: number; unbooked_settlements: number }
    | null
    | undefined
  if (!row) return NO_COLLECTION_OBLIGATIONS
  return {
    openCases: Number(row.open_cases ?? 0),
    unbookedCollectedPayments: Number(row.unbooked_collected_payments ?? 0),
    unbookedSettlements: Number(row.unbooked_settlements ?? 0),
  }
}

/** What flags.ts gates on. */
export function connectionFacts(row: CollectionConnectionRow): CollectionsConnectionFacts {
  return {
    route: row.route,
    state: row.state,
    subStatus: row.sub_status,
    health: row.health,
    distributionEnabled: row.distribution_enabled,
    ladderMode: row.ladder_mode,
    displayName: row.display_name,
  }
}

/** The connection as the settings page shows it: everything but the provider's handle. */
export interface CollectionConnectionView {
  id: string
  route: CollectionsRoute
  displayName: string
  state: CollectionsConnectionState
  subStatus: CollectionsConnectionSubStatus | null
  health: ConnectionHealth | null
  healthCause: string | null
  healthAction: HealthAction | null
  providerTerms: ProviderTerms | null
  catalogueTermsVersion: string
  termsVersion: string | null
  consentedAt: string
  submittedAt: string | null
  activatedAt: string | null
  /** Onboarding reached the provider: there is a handle to act on. */
  onboarded: boolean
  settings: {
    minimumAmount: number
    defaultStartStep: StartStep
    reminderFeeTermsSince: string | null
    lateInterestPercent: number | null
    lateInterestAgreedSince: string | null
    distributionEnabled: boolean
    ladderMode: LadderMode | null
    ladderDaysAfterDue: number
    clearingAccount: string
    payoutAccount: string
  }
}

export function connectionView(row: CollectionConnectionRow): CollectionConnectionView {
  return {
    id: row.id,
    route: row.route,
    displayName: row.display_name,
    state: row.state,
    subStatus: row.sub_status,
    health: row.health,
    healthCause: row.health_cause,
    healthAction: row.health_action,
    providerTerms: row.provider_terms,
    catalogueTermsVersion: row.catalogue_terms_version,
    termsVersion: row.terms_version,
    consentedAt: row.consented_at,
    submittedAt: row.submitted_at,
    activatedAt: row.activated_at,
    onboarded: row.connection_handle !== null,
    settings: {
      minimumAmount: row.minimum_amount,
      defaultStartStep: row.default_start_step,
      reminderFeeTermsSince: row.reminder_fee_terms_since,
      lateInterestPercent: row.late_interest_percent,
      lateInterestAgreedSince: row.late_interest_agreed_since,
      distributionEnabled: row.distribution_enabled,
      ladderMode: row.ladder_mode,
      ladderDaysAfterDue: row.ladder_days_after_due,
      clearingAccount: row.clearing_account,
      payoutAccount: row.payout_account,
    },
  }
}

/** The columns a provider answer may change on the row. */
export interface SnapshotPatch {
  state: CollectionsConnectionState
  sub_status: CollectionsConnectionSubStatus | null
  provider_status: string | null
  provider_terms: ProviderTerms | null
  connection_handle: string | null
  activated_at: string | null
  health: ConnectionHealth
  health_cause: string | null
  health_action: HealthAction | null
  last_success_at: string
  failures_in_row: number
}

/**
 * The row after a successful provider answer. Two rules the provider cannot
 * override:
 *
 * - The ledger alone ends a connection (cancel, disconnect), because ending
 *   is refused while work is open. A provider that reports the connection
 *   gone keeps the row live and asks a person to look (action_required).
 * - A handle once stored is kept: a later answer without one (a read made
 *   before onboarding finished) never erases it.
 */
export function snapshotPatch(row: CollectionConnectionRow, snapshot: CollectionsConnection, now: Date): SnapshotPatch {
  const ended = snapshot.state === 'disconnected'
  const state: CollectionsConnectionState = ended ? row.state : snapshot.state
  const subStatus = state === 'active' || state === 'disconnected' ? null : ended ? row.sub_status : snapshot.subStatus
  const at = now.toISOString()
  return {
    state,
    sub_status: subStatus,
    provider_status: snapshot.providerStatus,
    provider_terms: snapshot.terms ? { version: snapshot.terms.version, url: snapshot.terms.url, accepted: snapshot.terms.accepted } : row.provider_terms,
    connection_handle: row.connection_handle ?? snapshot.connectionHandle,
    activated_at: row.activated_at ?? (state === 'active' ? at : null),
    health: ended ? 'action_required' : 'ok',
    health_cause: ended ? 'PROVIDER_DISCONNECTED' : null,
    health_action: ended ? 'contact_support' : null,
    last_success_at: at,
    failures_in_row: 0,
  }
}

/** Errors that say "try again" rather than "something is wrong with this connection". */
const TRANSIENT_CODES = new Set(['CONNECTOR_UNREACHABLE', 'CONNECTOR_RATE_LIMITED', 'CONNECTOR_IDEMPOTENCY_IN_FLIGHT', 'CONNECTOR_UPSTREAM_DISABLED'])

/** The run record after a failed provider call. */
export function failurePatch(
  row: Pick<CollectionConnectionRow, 'failures_in_row'>,
  error: { code: string; retryable: boolean },
  now: Date,
): Pick<SnapshotPatch, 'health' | 'health_cause' | 'health_action' | 'failures_in_row'> & { last_error_code: string; last_error_at: string } {
  const transient = error.retryable || TRANSIENT_CODES.has(error.code)
  return {
    health: transient ? 'degraded' : 'action_required',
    health_cause: error.code,
    health_action: transient ? 'retry_later' : 'contact_support',
    failures_in_row: row.failures_in_row + 1,
    last_error_code: error.code,
    last_error_at: now.toISOString(),
  }
}
