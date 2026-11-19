import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import type { EligibilityBlock } from './eligibility'
import { bankCheckState, handoverCanSend, handoverRequestBody, type OpenCaseBody, type StartStep } from './handover-dialog'
import type { CollectionReadinessView } from './invoice-collection'
import { isOverdueUnpaid } from './invoice-entry'
import { bannerCheckLine, bannerStep, type BannerCheckLine } from './overdue-banner'

/**
 * "Skicka till inkasso (N)" from the invoice list's Förfallna view, pure and
 * client-safe so the dialog and its tests share it: which rows can be
 * ticked, how each invoice's checks read, which invoices go out from the
 * list and which need a person first (and why), the request each one
 * sends, and how the run reads afterwards. Each send is the existing
 * per-invoice handover (POST /api/invoices/[id]/collection), which runs
 * every check again at commit. Nothing here attests anything: an invoice
 * that needs an attestation (a stale bank, a delivery the books cannot
 * show, an imported invoice, a customer's answer) is listed but held, and
 * the person sends it from the invoice, where the dialog asks.
 */

export interface BulkListInvoice {
  id: string
  status: string
  due_date: string | null
  remaining_amount?: number | null
  document_type?: string | null
  credited_invoice_id?: string | null
  total?: number | null
}

/**
 * A row the Förfallna view lets the person tick for "Skicka till inkasso":
 * a customer invoice still owed past its due date with no open case.
 */
export function bulkSendable(invoice: BulkListInvoice, context: { today: string; openCaseIds: ReadonlySet<string> }): boolean {
  if ((invoice.document_type ?? 'invoice') !== 'invoice' || isCreditNoteDocument(invoice)) return false
  if (context.openCaseIds.has(invoice.id)) return false
  return isOverdueUnpaid(invoice, context.today)
}

/** Why an invoice in the dialog is listed but not sent from the list. */
export type BulkHoldReason =
  | { key: 'bulk_hold_blocked'; block: EligibilityBlock }
  | { key: 'bulk_hold_candidates'; count: number }
  | { key: 'bulk_hold_bank' }
  | { key: 'bulk_hold_delivery' }
  | { key: 'bulk_hold_imported' }
  | { key: 'bulk_hold_response' }
  | { key: 'bulk_hold_unavailable' }

export type BulkRow =
  | { state: 'loading' }
  | { state: 'sendable'; step: StartStep; check: BannerCheckLine; remaining: number }
  | { state: 'held'; step: StartStep | null; check: BannerCheckLine | null; remaining: number | null; reason: BulkHoldReason }

/** Answers for an invoice sent from the list: the step the company configured (or the facts call for), no dismissals, no attestations. */
function listAnswers(readiness: CollectionReadinessView) {
  return {
    startStep: bannerStep(null, readiness),
    dismissed: [] as string[],
    bankAttested: false,
    deliveryAttested: false,
    responseAttested: false,
  }
}

/** Why the handover dialog would not let this invoice go without a person; null when it may go from the list. */
export function bulkHoldReason(readiness: CollectionReadinessView): BulkHoldReason | null {
  if (!readiness.eligible) return readiness.blocks[0] ? { key: 'bulk_hold_blocked', block: readiness.blocks[0] } : { key: 'bulk_hold_unavailable' }
  const bank = bankCheckState(readiness.bankCheck, [])
  if (bank.outcome === 'candidates') return { key: 'bulk_hold_candidates', count: bank.blocking.length }
  if (bank.needsAttest) return { key: 'bulk_hold_bank' }
  if (readiness.deliveryAttestation === 'not_delivered') return { key: 'bulk_hold_delivery' }
  if (readiness.deliveryAttestation === 'imported') return { key: 'bulk_hold_imported' }
  if (readiness.responseAttestation) return { key: 'bulk_hold_response' }
  if (!handoverCanSend(readiness, listAnswers(readiness))) return { key: 'bulk_hold_unavailable' }
  return null
}

/**
 * One invoice's row: `undefined` while its checks load, `null` when they
 * could not be read (or the invoice cannot be handed over any more).
 */
export function bulkRow(readiness: CollectionReadinessView | null | undefined): BulkRow {
  if (readiness === undefined) return { state: 'loading' }
  if (readiness === null) return { state: 'held', step: null, check: null, remaining: null, reason: { key: 'bulk_hold_unavailable' } }
  const step = bannerStep(null, readiness)
  const check = bannerCheckLine(readiness)
  const reason = bulkHoldReason(readiness)
  return reason
    ? { state: 'held', step, check, remaining: readiness.claim.remaining, reason }
    : { state: 'sendable', step, check, remaining: readiness.claim.remaining }
}

/** The handover request for an invoice sent from the list: the same body the dialog sends, with nothing attested. */
export function bulkRequestBody(readiness: CollectionReadinessView): OpenCaseBody {
  return handoverRequestBody(readiness, listAnswers(readiness))
}

/** What happened to one invoice when the person sent the list. */
export type BulkOutcome =
  | { state: 'sending' }
  | { state: 'sent'; registered: boolean }
  | { state: 'failed'; message: string }

/** The invoices to send: sendable rows the person left ticked, in the list's order. */
export function bulkToSend(ids: readonly string[], rows: Readonly<Record<string, BulkRow>>, unticked: readonly string[]): string[] {
  return ids.filter((id) => rows[id]?.state === 'sendable' && !unticked.includes(id))
}

/**
 * The dialog's title counts what the button sends: the ticked invoices
 * that may go out once every check is read. While checks load, or when none
 * can go, it names no number, so the title never promises an invoice the
 * button holds back.
 */
export function bulkTitle(
  ids: readonly string[],
  rows: Readonly<Record<string, BulkRow>>,
  unticked: readonly string[],
): { key: 'bulk_title'; count: number } | { key: 'bulk_title_plain' } {
  if (ids.some((id) => (rows[id]?.state ?? 'loading') === 'loading')) return { key: 'bulk_title_plain' }
  const count = bulkToSend(ids, rows, unticked).length
  return count > 0 ? { key: 'bulk_title', count } : { key: 'bulk_title_plain' }
}

/** How the run reads afterwards: sent (registered or still registering) and failed. */
export function bulkSummary(outcomes: Readonly<Record<string, BulkOutcome>>): { sent: number; failed: number; running: boolean } {
  let sent = 0
  let failed = 0
  let running = false
  for (const outcome of Object.values(outcomes)) {
    if (outcome.state === 'sent') sent += 1
    else if (outcome.state === 'failed') failed += 1
    else running = true
  }
  return { sent, failed, running }
}

/**
 * Run the sends one at a time (each handover may wait on the provider), so
 * the person watches each invoice's answer arrive. `send` never throws; it
 * answers the outcome.
 */
export async function runBulkSends(
  ids: readonly string[],
  send: (id: string) => Promise<Exclude<BulkOutcome, { state: 'sending' }>>,
  onOutcome: (id: string, outcome: BulkOutcome) => void,
): Promise<void> {
  for (const id of ids) {
    onOutcome(id, { state: 'sending' })
    onOutcome(id, await send(id))
  }
}
