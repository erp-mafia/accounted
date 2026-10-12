import type { CollectionsAction, CollectionsCloseReason, CollectionsStage } from '@accounted/connect-contract'

/**
 * How a collection case's provider-neutral stage reads in the app: the chip
 * on the invoice list and the invoice header, the case card's kicker, the
 * "Hos inkasso" view and which stages are still the delivery of the invoice
 * rather than collection. Pure and client-safe: the list page, the card and
 * the server share it, so a stage cannot read one way in one place and
 * another way elsewhere. The SQL twin of isInCollectionStage is the
 * in_collection column of collection_open_invoice_ids.
 */

/**
 * The stage that is still the invoice's delivery, not collection: the
 * provider sent the invoice itself. A `registered` case is a claim handed
 * over for collection that the provider has not started yet; it reads as
 * collection ("Hos inkasso"), never as delivery.
 */
export const DELIVERY_STAGES: ReadonlySet<CollectionsStage> = new Set(['invoice_sent'])

/** Open stages before any letter of the case has gone out: the user can still start it. */
export const NOT_STARTED_STAGES: ReadonlySet<CollectionsStage> = new Set(['registered', 'invoice_sent'])

/** Closed stages: the case is over. */
export const CLOSED_STAGES: ReadonlySet<CollectionsStage> = new Set(['closed_paid', 'closed_other'])

/** "Hos inkasso": an open case past delivery, a registered claim included. */
export function isInCollectionStage(stage: CollectionsStage): boolean {
  return !DELIVERY_STAGES.has(stage) && !CLOSED_STAGES.has(stage)
}

/**
 * The chip a case puts on its invoice; null when the case shows none
 * (closed). `registered` is a claim the provider holds but has not started:
 * nothing has reached the customer yet, so it never reads as sent.
 */
export type CollectionChipKind = 'registered' | 'delivered' | 'reminder' | 'in_collection' | 'decision' | 'paused'

export function collectionChipKind(stage: CollectionsStage): CollectionChipKind | null {
  switch (stage) {
    case 'registered':
      return 'registered'
    case 'invoice_sent':
      return 'delivered'
    case 'reminder':
      return 'reminder'
    case 'collection':
    case 'enforcement':
    case 'payment_plan':
    case 'monitoring':
    case 'unknown':
      return 'in_collection'
    case 'awaiting_decision':
      return 'decision'
    case 'paused':
      return 'paused'
    case 'closed_paid':
    case 'closed_other':
      return null
  }
}

/** i18n key (collections namespace) of a chip. */
export const CHIP_LABEL_KEYS: Record<CollectionChipKind, string> = {
  registered: 'chip_registered',
  delivered: 'chip_delivered',
  reminder: 'chip_reminder',
  in_collection: 'chip_in_collection',
  decision: 'chip_decision',
  paused: 'chip_paused',
}

/** The badge variant a chip uses: decisions ask for the user, the rest inform. */
export const CHIP_VARIANTS: Record<CollectionChipKind, 'warning' | 'secondary' | 'outline'> = {
  registered: 'outline',
  delivered: 'outline',
  reminder: 'secondary',
  in_collection: 'secondary',
  decision: 'warning',
  paused: 'outline',
}

/** i18n key (collections namespace) of a stage label. `unknown` shows the provider's own label. */
export const STAGE_LABEL_KEYS: Record<CollectionsStage, string> = {
  registered: 'stage_registered',
  invoice_sent: 'stage_invoice_sent',
  reminder: 'stage_reminder',
  collection: 'stage_collection',
  awaiting_decision: 'stage_awaiting_decision',
  enforcement: 'stage_enforcement',
  payment_plan: 'stage_payment_plan',
  monitoring: 'stage_monitoring',
  paused: 'stage_paused',
  closed_paid: 'stage_closed_paid',
  closed_other: 'stage_closed_other',
  unknown: 'stage_unknown',
}

/** i18n key (collections namespace) of a close reason. */
export const CLOSE_REASON_KEYS: Record<CollectionsCloseReason, string> = {
  paid: 'close_paid',
  withdrawn: 'close_withdrawn',
  credited: 'close_credited',
  insolvent: 'close_insolvent',
  bankrupt: 'close_bankrupt',
  deceased: 'close_deceased',
  moved_abroad: 'close_moved_abroad',
  error: 'close_error',
  other: 'close_other',
}

/** The card's kicker: Utskick while the provider only delivered the invoice, Inkasso after. */
export function caseKickerKey(stage: CollectionsStage): 'card_kicker_delivery' | 'card_kicker_collection' {
  return DELIVERY_STAGES.has(stage) ? 'card_kicker_delivery' : 'card_kicker_collection'
}

/**
 * Actions that begin new work (the contract's start actions): they pass the
 * start gates and re-run the bank check. Every other action serves the open
 * case and runs whatever the start gates say.
 */
export const START_CASE_ACTIONS: ReadonlySet<CollectionsAction> = new Set(['start', 'approve_step'])

/**
 * Actions an agent may stage but only a person may approve in the web UI:
 * each one escalates against the customer or overrides what the customer
 * said (risk-tiers.ts requiresWebApproval reads this list).
 */
export const WEB_ONLY_CASE_ACTIONS: ReadonlySet<CollectionsAction> = new Set([
  'start',
  'approve_step',
  'confirm_not_paid',
  'contest_dispute',
  'approve_legal_action',
])

/** The shortest written reason an action that needs one accepts. */
export const MIN_ACTION_MESSAGE = 10

/** The latest date a pause may run to: the provider's next step is postponed at most this far. */
export const MAX_PAUSE_DAYS = 365

function addIsoDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * The dates a pause may run to (YYYY-MM-DD, inclusive): from tomorrow to
 * MAX_PAUSE_DAYS ahead of `today` (the Stockholm date). The pause dialog
 * offers this window and the service refuses anything outside it.
 */
export function pauseUntilWindow(today: string): { earliest: string; latest: string } {
  return { earliest: addIsoDays(today, 1), latest: addIsoDays(today, MAX_PAUSE_DAYS) }
}

/** Actions that need a written reason from the person taking them (at least ten characters). */
export const MESSAGE_REQUIRED_ACTIONS: ReadonlySet<CollectionsAction> = new Set(['dispute', 'confirm_not_paid'])

/** Actions after which the provider may keep pursuing the customer: the bank is checked first. */
export const BANK_CHECKED_ACTIONS: ReadonlySet<CollectionsAction> = new Set(['start', 'approve_step', 'confirm_not_paid'])

/**
 * Actions the ledger never sends to the provider. `already_paid` answers the
 * customer's "I have paid": when it is true, the payment is booked on the
 * invoice (the payment dialog) and reported to the provider, which closes
 * the case once the whole amount is paid; when it is not, confirm_not_paid
 * contests the customer's word. Telling the provider "paid" without a
 * payment would leave the books and the provider's case apart.
 */
export const LEDGER_ONLY_CASE_ACTIONS: ReadonlySet<CollectionsAction> = new Set(['already_paid'])

/** Whether withdrawing a case may cost a fee, and until when it is free. */
export interface WithdrawFeeInfo {
  /** The provider may charge for a withdrawal now: the free days have passed, or the provider does not say. */
  mayApply: boolean
  /** The catalogue's free days after the handover; null = unknown. */
  freeDays: number | null
  /** When the free window ends (ISO timestamp); null when unknown. */
  freeUntil: string | null
}

/**
 * The withdrawal fee rule: a withdrawal within the provider's free days
 * after the handover costs nothing; after them, or when the provider states
 * none (`withdrawFreeDays` null), the withdraw dialog shows the fee line and
 * the person confirms it before the case is withdrawn. Pure and client-safe.
 */
export function withdrawFeeInfo(openedAt: string, freeDays: number | null, now: Date): WithdrawFeeInfo {
  const opened = Date.parse(openedAt)
  if (freeDays === null || !Number.isFinite(opened)) return { mayApply: true, freeDays, freeUntil: null }
  const until = new Date(opened + freeDays * 86_400_000)
  return { mayApply: now.getTime() > until.getTime(), freeDays, freeUntil: until.toISOString() }
}
