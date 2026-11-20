import type { BankCheckView, CollectionReadinessView } from './invoice-collection'

/**
 * The "Skicka till inkasso" dialog's decisions (build spec 3.4), pure and
 * client-safe so the dialog and its tests share them: how the bank check
 * reads once the person has marked rows as something else, which
 * attestations the facts call for, whether the handover may be sent, and
 * the request it sends. The server runs every check again at commit; this
 * only keeps the button honest.
 */

export type StartStep = 'reminder' | 'collection'

/** POST /api/invoices/[id]/collection. */
export interface OpenCaseBody {
  start_step: StartStep | null
  expected_remaining: number
  bank_attested?: boolean
  delivery_attested?: boolean
  imported_attested?: boolean
  response_attested?: boolean
  dismissed_transaction_ids?: string[]
}

/** What the bank check says in the dialog: the server's outcome with the person's dismissals applied. */
export type BankDisplayOutcome = 'pass' | 'candidates' | 'stale' | 'no_bank'

export interface BankCheckState {
  outcome: BankDisplayOutcome
  /** Unbooked rows that may be the payment and that nobody has marked as something else. */
  blocking: BankCheckView['candidates']
  /** The bank is not fresh (or not connected): a person attests that the invoice is not paid. */
  needsAttest: boolean
  /** The payee account the stale sentence names: the first one that is not fresh. */
  staleAccount: { name: string; syncedAt: string | null } | null
}

export function bankCheckState(bank: BankCheckView, dismissed: readonly string[]): BankCheckState {
  const blocking = bank.candidates.filter((c) => !c.dismissed && !dismissed.includes(c.transactionId))
  const outcome: BankDisplayOutcome = blocking.length > 0 ? 'candidates' : bank.freshness === 'fresh' ? 'pass' : bank.freshness
  const stale = bank.accounts.find((a) => !a.fresh) ?? bank.accounts[0] ?? null
  return {
    outcome,
    blocking,
    needsAttest: outcome === 'stale' || outcome === 'no_bank',
    staleAccount: stale ? { name: stale.name ?? stale.ledgerAccount, syncedAt: stale.syncedAt } : null,
  }
}

/** Toggle a bank row between "may be the payment" and "not a payment of this invoice". */
export function toggleDismissed(dismissed: readonly string[], transactionId: string): string[] {
  return dismissed.includes(transactionId) ? dismissed.filter((id) => id !== transactionId) : [...dismissed, transactionId]
}

/**
 * The start steps the person chooses between. A claim the provider already
 * delivered and watches starts with a reminder (the dialog's confirm says
 * so), so it offers no choice.
 */
export function offeredStartSteps(readiness: Pick<CollectionReadinessView, 'watching' | 'startSteps'>): StartStep[] {
  return readiness.watching ? [] : readiness.startSteps
}

/** The step the dialog opens on: the company's default when the provider offers it, else the first offered. */
export function initialStartStep(readiness: Pick<CollectionReadinessView, 'startSteps' | 'defaultStartStep'>): StartStep {
  return readiness.startSteps.includes(readiness.defaultStartStep) ? readiness.defaultStartStep : (readiness.startSteps[0] ?? 'reminder')
}

/** The i18n keys (collections namespace) of the dialog's title and confirm. */
export interface HandoverWording {
  title: 'send_title' | 'send_title_start'
  confirm: 'send_confirm' | 'send_confirm_start'
}

/**
 * The dialog's title and confirm follow the step that goes out first: a
 * reminder reads as a reminder, an inkassokrav as debt collection. A watched
 * claim always starts with a reminder. Until the facts load, the general
 * wording stands.
 */
export function handoverWording(
  readiness: Pick<CollectionReadinessView, 'watching'> | null,
  startStep: StartStep,
): HandoverWording {
  if (!readiness) return { title: 'send_title', confirm: 'send_confirm' }
  const firstStep: StartStep = readiness.watching ? 'reminder' : startStep
  return firstStep === 'reminder'
    ? { title: 'send_title_start', confirm: 'send_confirm_start' }
    : { title: 'send_title', confirm: 'send_confirm' }
}

export interface HandoverAnswers {
  startStep: StartStep
  dismissed: readonly string[]
  bankAttested: boolean
  /** The delivery or the import attestation, whichever the invoice calls for. */
  deliveryAttested: boolean
  responseAttested: boolean
}

/** Whether the dialog's confirm is enabled: eligible, no unexplained bank row, and every attestation the facts call for. */
export function handoverCanSend(readiness: CollectionReadinessView, answers: HandoverAnswers): boolean {
  if (!readiness.eligible) return false
  const bank = bankCheckState(readiness.bankCheck, answers.dismissed)
  if (bank.outcome === 'candidates') return false
  if (bank.needsAttest && !answers.bankAttested) return false
  if (readiness.deliveryAttestation && !answers.deliveryAttested) return false
  if (readiness.responseAttestation && !answers.responseAttested) return false
  return offeredStartSteps(readiness).length === 0 || offeredStartSteps(readiness).includes(answers.startStep)
}

/**
 * The handover request. Each attestation is sent only when the facts call
 * for it, so a stray checkbox can never stand in for one that was not asked;
 * the amount the person saw goes along, and the server refuses when the
 * customer paid meanwhile.
 */
export function handoverRequestBody(readiness: CollectionReadinessView, answers: HandoverAnswers): OpenCaseBody {
  const bank = bankCheckState(readiness.bankCheck, answers.dismissed)
  const dismissed = answers.dismissed.filter((id) => readiness.bankCheck.candidates.some((c) => c.transactionId === id))
  return {
    start_step: readiness.watching ? 'reminder' : answers.startStep,
    expected_remaining: readiness.claim.remaining,
    ...(bank.needsAttest ? { bank_attested: answers.bankAttested } : {}),
    ...(readiness.deliveryAttestation === 'not_delivered' ? { delivery_attested: answers.deliveryAttested } : {}),
    ...(readiness.deliveryAttestation === 'imported' ? { imported_attested: answers.deliveryAttested } : {}),
    ...(readiness.responseAttestation ? { response_attested: answers.responseAttested } : {}),
    ...(dismissed.length > 0 ? { dismissed_transaction_ids: dismissed } : {}),
  }
}

/**
 * Refusals after which the dialog reads the invoice again: the facts it
 * showed are out of date (a payment arrived, a new bank row, a check that
 * now needs an attestation), and the person decides on the new ones.
 */
const RELOAD_CODES: ReadonlySet<string> = new Set([
  'COLLECTION_REMAINING_CHANGED',
  'COLLECTION_BANK_CANDIDATES',
  'COLLECTION_BANK_STALE',
  'COLLECTION_ATTESTATION_REQUIRED',
  'COLLECTION_NOT_ELIGIBLE',
])

export function handoverReloadsAfter(code: string | null): boolean {
  return code !== null && RELOAD_CODES.has(code)
}
