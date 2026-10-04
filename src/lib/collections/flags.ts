import {
  COLLECTIONS_START_ACTIONS,
  COLLECTIONS_START_OPERATIONS,
  DELIVERY_START_OPERATIONS,
  type CollectionsAction,
  type CollectionsConnectionState,
  type CollectionsConnectionSubStatus,
  type CollectionsOperation,
  type DeliveryOperation,
} from '@accounted/connect-contract'
import { COLLECTIONS_DISABLED, COLLECTIONS_NOT_ACTIVE } from './errors'
import type { CollectionsRoute } from './port'

/**
 * The ONE place that decides whether collections work may run. Routes,
 * operations, the pending-operation commit path and crons all ask here.
 *
 * Two kinds of path (build spec 1.8):
 *
 * - START paths begin new work: activation and its steps, handover (manual and
 *   batch), the `start` and `approve_step` case actions, delivery and its
 *   reachability lookup, the daily batch and its settings, and agent
 *   discovery of the start tools. Every gate must say yes: the installation
 *   kill switch (COLLECTIONS_ENABLED), the pilot list
 *   (COLLECTIONS_PILOT_COMPANIES), the ladder or delivery flag where it
 *   applies, the paid capability `collections`, and the company's own
 *   activation.
 *
 * - OBLIGATION paths are duties toward work already handed over, plus
 *   anything that stops work: payment and credit-note forwarding and
 *   reverts, case sync and refresh, pause, resume, withdraw, dispute,
 *   contest, already_paid, confirm_not_paid, legal-action decisions, the bank
 *   sweep's auto-pause, the daily reconcile, settlement import, booking of
 *   collected payments and settlements, the read-only case card, chips and
 *   the settlements view, cancelling an activation and disconnecting. No gate
 *   here ever refuses them: a kill switch, a pilot removal or a lapsed plan
 *   must never silence forwarding while the provider keeps dunning the
 *   customer. hasCollectionObligations() says whether a company has any, so
 *   a UI with every start gate closed still shows what is open.
 */

// ---------------------------------------------------------------------------
// Installation flags (environment)
// ---------------------------------------------------------------------------

export interface CollectionsEnv {
  /** COLLECTIONS_ENABLED: the installation kill switch for start work. Unset = off. */
  enabled: boolean
  /** COLLECTIONS_PILOT_COMPANIES: comma-separated company ids, or `*` for every company. Unset = nobody. */
  pilot: '*' | ReadonlySet<string>
  /** COLLECTIONS_LADDER_ENABLED: the daily batch and its settings. Unset = off. */
  ladderEnabled: boolean
  /** COLLECTIONS_DELIVERY_ENABLED: delivery channels in the invoice editor. Unset = off. */
  deliveryEnabled: boolean
  /** COLLECTIONS_FAKE_ADAPTER=1 outside production: new connection rows use the fake adapter. */
  fakeAdapterRequested: boolean
}

function flagOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

export function readCollectionsEnv(env: Record<string, string | undefined> = process.env): CollectionsEnv {
  const rawPilot = env.COLLECTIONS_PILOT_COMPANIES?.trim() ?? ''
  const pilot: CollectionsEnv['pilot'] =
    rawPilot === '*'
      ? '*'
      : new Set(
          rawPilot
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        )
  return {
    enabled: flagOn(env.COLLECTIONS_ENABLED),
    pilot,
    ladderEnabled: flagOn(env.COLLECTIONS_LADDER_ENABLED),
    deliveryEnabled: flagOn(env.COLLECTIONS_DELIVERY_ENABLED),
    fakeAdapterRequested: env.COLLECTIONS_FAKE_ADAPTER?.trim() === '1' && env.NODE_ENV !== 'production',
  }
}

export function isPilotCompany(env: CollectionsEnv, companyId: string): boolean {
  return env.pilot === '*' || env.pilot.has(companyId)
}

/** The kill switch and the pilot list: may this company start new work at all? */
export function isCollectionsEnabledFor(env: CollectionsEnv, companyId: string): boolean {
  return env.enabled && isPilotCompany(env, companyId)
}

// ---------------------------------------------------------------------------
// Company facts
// ---------------------------------------------------------------------------

/** The company's connection row, as far as gating and rendering need it (collection_connections). */
export interface CollectionsConnectionFacts {
  route: CollectionsRoute
  state: CollectionsConnectionState
  subStatus: CollectionsConnectionSubStatus | null
  health: 'ok' | 'degraded' | 'action_required' | null
  distributionEnabled: boolean
  /** null until the admin has chosen. */
  ladderMode: 'off' | 'staged' | null
  /** The provider's name as the catalogue gave it at activation (the fallback when the catalogue is down). */
  displayName: string
}

/** Work the company owes or is owed at the provider, whatever the start gates say. */
export interface CollectionObligations {
  openCases: number
  unbookedCollectedPayments: number
  unbookedSettlements: number
}

export const NO_COLLECTION_OBLIGATIONS: CollectionObligations = Object.freeze({
  openCases: 0,
  unbookedCollectedPayments: 0,
  unbookedSettlements: 0,
})

export function hasCollectionObligations(obligations: CollectionObligations): boolean {
  return obligations.openCases > 0 || obligations.unbookedCollectedPayments > 0 || obligations.unbookedSettlements > 0
}

export interface CollectionsGateFacts {
  companyId: string
  /** The paid capability `collections` (hasCapability). */
  capability: boolean
  connection: CollectionsConnectionFacts | null
  obligations: CollectionObligations
}

// ---------------------------------------------------------------------------
// Paths and decisions
// ---------------------------------------------------------------------------

export const COLLECTIONS_START_PATHS = [
  /** Consent, onboarding, provider terms and signature. */
  'activation',
  /** Hand an invoice over (manual). */
  'handover',
  /** Start reminders on a delivered invoice (caseAction `start`). */
  'case_start',
  /** Approve a waiting reminder or collection notice (caseAction `approve_step`). */
  'case_approve_step',
  /** The daily candidate batch, staged for approval. */
  'daily_batch',
  /** The ladder settings (batch on/off, days after due). */
  'ladder_settings',
  /** Send an invoice by post, digital mailbox or e-invoice. */
  'delivery_send',
  /** Look up whether a debtor is reachable by a delivery method. */
  'delivery_methods',
  /** MCP and v1 discovery of the start tools. */
  'tool_discovery',
] as const
export type CollectionsStartPath = (typeof COLLECTIONS_START_PATHS)[number]

export const COLLECTIONS_OBLIGATION_PATHS = [
  'payment_forwarding',
  'payment_revert',
  'credit_note_forwarding',
  'case_sync',
  'case_refresh',
  'case_pause',
  'case_resume',
  'case_withdraw',
  'case_dispute',
  'case_contest_dispute',
  'case_already_paid',
  'case_confirm_not_paid',
  'case_legal_action_decision',
  'bank_sweep_pause',
  'case_reconcile',
  'settlement_import',
  'settlement_booking',
  'collected_payment_booking',
  'case_card',
  'settlements_view',
  'activation_cancel',
  'disconnect',
] as const
export type CollectionsObligationPath = (typeof COLLECTIONS_OBLIGATION_PATHS)[number]

export type CollectionsPath = CollectionsStartPath | CollectionsObligationPath

export function isCollectionsStartPath(path: CollectionsPath): path is CollectionsStartPath {
  return (COLLECTIONS_START_PATHS as readonly string[]).includes(path)
}

export type CollectionsGateDecision =
  | { allowed: true }
  | {
      allowed: false
      /** COLLECTIONS_DISABLED (503), CAPABILITY_REQUIRED (403: answer with capabilityBlockedResponse) or COLLECTIONS_NOT_ACTIVE (409). */
      code: typeof COLLECTIONS_DISABLED | 'CAPABILITY_REQUIRED' | typeof COLLECTIONS_NOT_ACTIVE
      status: 503 | 403 | 409
    }

const ALLOWED: CollectionsGateDecision = { allowed: true }
const DISABLED: CollectionsGateDecision = { allowed: false, code: COLLECTIONS_DISABLED, status: 503 }
const CAPABILITY_REQUIRED: CollectionsGateDecision = { allowed: false, code: 'CAPABILITY_REQUIRED', status: 403 }
const NOT_ACTIVE: CollectionsGateDecision = { allowed: false, code: COLLECTIONS_NOT_ACTIVE, status: 409 }

const LADDER_PATHS: ReadonlySet<CollectionsStartPath> = new Set(['daily_batch', 'ladder_settings'])
const DELIVERY_PATHS: ReadonlySet<CollectionsStartPath> = new Set(['delivery_send', 'delivery_methods'])
/** Start paths that may run before the connection is active: activation itself and tool discovery. */
const BEFORE_ACTIVATION: ReadonlySet<CollectionsStartPath> = new Set(['activation', 'tool_discovery'])

/**
 * Whether a path may run now. Start paths check, in order: kill switch and
 * pilot list (503 COLLECTIONS_DISABLED), the ladder or delivery flag for
 * their paths (503), the paid capability (403, before any Connect call), and
 * the company's activation (409 COLLECTIONS_NOT_ACTIVE: an active connection,
 * plus the company's delivery opt-in for delivery and a staged ladder for
 * the daily batch). Obligation paths are always allowed.
 */
export function collectionsGate(path: CollectionsPath, facts: CollectionsGateFacts, env: CollectionsEnv): CollectionsGateDecision {
  if (!isCollectionsStartPath(path)) return ALLOWED

  if (!isCollectionsEnabledFor(env, facts.companyId)) return DISABLED
  if (LADDER_PATHS.has(path) && !env.ladderEnabled) return DISABLED
  if (DELIVERY_PATHS.has(path) && !env.deliveryEnabled) return DISABLED
  if (!facts.capability) return CAPABILITY_REQUIRED
  if (BEFORE_ACTIVATION.has(path)) return ALLOWED

  const connection = facts.connection
  if (!connection || connection.state !== 'active') return NOT_ACTIVE
  if (DELIVERY_PATHS.has(path) && !connection.distributionEnabled) return NOT_ACTIVE
  if (path === 'daily_batch' && connection.ladderMode !== 'staged') return NOT_ACTIVE
  return ALLOWED
}

/** Whether a contract operation begins new work (the start operations, and caseAction with a start action). */
export function isStartOperation(operation: CollectionsOperation, action?: CollectionsAction | null): boolean {
  if ((COLLECTIONS_START_OPERATIONS as readonly string[]).includes(operation)) return true
  return operation === 'caseAction' && !!action && (COLLECTIONS_START_ACTIONS as readonly string[]).includes(action)
}

/** Whether a delivery operation begins new work (send, and the methods lookup). */
export function isDeliveryStartOperation(operation: DeliveryOperation): boolean {
  return (DELIVERY_START_OPERATIONS as readonly string[]).includes(operation)
}

// ---------------------------------------------------------------------------
// What the UI renders (build spec 3.1)
// ---------------------------------------------------------------------------

/**
 * Where the start entry points stand for a company:
 *   hidden    start gates closed (kill switch, pilot): render nothing
 *   upgrade   enabled, but the company lacks the paid capability: UpgradeNote
 *   activate  capability, but no active connection: "Aktivera inkasso och utskick"
 *   ready     everything says yes
 */
export type CollectionsStartState = 'hidden' | 'upgrade' | 'activate' | 'ready'

export function collectionsStartState(facts: CollectionsGateFacts, env: CollectionsEnv): CollectionsStartState {
  if (!isCollectionsEnabledFor(env, facts.companyId)) return 'hidden'
  if (!facts.capability) return 'upgrade'
  if (facts.connection?.state !== 'active') return 'activate'
  return 'ready'
}
