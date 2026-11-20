import type { BatchItem } from './batch'
import type { CollectionsStartState } from './flags'
import type { EligibilityBlock } from './eligibility'
import { bankCheckState, initialStartStep, type StartStep } from './handover-dialog'
import type { CollectionReadinessView } from './invoice-collection'
import { isOverdueUnpaid, showSendToCollection, type EntryCase, type EntryInvoice } from './invoice-entry'

/**
 * The overdue banner at the top of the invoice page (inkasso lives on the
 * invoice), pure and client-safe so the page and its tests share it: whether
 * it shows, what it offers (the send button, activation, or the upgrade
 * note), the label of its one button, and the bank check in one line. The
 * button opens the existing handover dialog, which runs every check again;
 * this only decides what the banner says.
 */

/** Whole days from `fromIso` to `toIso` (both YYYY-MM-DD); 0 when either is missing or `toIso` is not later. */
export function daysBetween(fromIso: string | null, toIso: string): number {
  if (!fromIso) return 0
  const from = Date.parse(`${fromIso}T00:00:00Z`)
  const to = Date.parse(`${toIso}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0
  return Math.round((to - from) / 86_400_000)
}

/** The i18n key (collections namespace) of the banner's send button, from the step that goes out first. */
export function sendLabelKey(step: StartStep): 'banner_send_reminder' | 'banner_send_collection' {
  return step === 'reminder' ? 'banner_send_reminder' : 'banner_send_collection'
}

interface BannerBase {
  dueDate: string
  overdueDays: number
}

export type OverdueBanner =
  | (BannerBase & { kind: 'upgrade' })
  | (BannerBase & { kind: 'activate'; canActivate: boolean })
  | (BannerBase & { kind: 'ready'; step: StartStep; labelKey: ReturnType<typeof sendLabelKey> })
  | (BannerBase & { kind: 'batch'; step: StartStep; labelKey: 'banner_in_batch_reminder' | 'banner_in_batch_collection' })

/**
 * The invoice's item in the company's pending daily run, if the run proposes
 * to send it (a new handover or reminders on a delivered claim); a next step
 * to approve belongs to an open case, which shows its card instead.
 */
export function batchItemFor(
  items: readonly Pick<BatchItem, 'kind' | 'invoice_id' | 'start_step'>[] | null | undefined,
  invoiceId: string,
): Pick<BatchItem, 'kind' | 'start_step'> | null {
  return items?.find((item) => item.invoice_id === invoiceId && (item.kind === 'open' || item.kind === 'start')) ?? null
}

/**
 * The step the banner's button names: the facts the dialog will open on
 * once they are read (a claim the provider already delivered always starts
 * with a reminder), else the company's configured first step, else a
 * reminder (the activation default).
 */
export function bannerStep(
  defaultStartStep: StartStep | null,
  readiness: Pick<CollectionReadinessView, 'watching' | 'startSteps' | 'defaultStartStep'> | null | undefined,
): StartStep {
  if (readiness) return readiness.watching ? 'reminder' : initialStartStep(readiness)
  return defaultStartStep ?? 'reminder'
}

/**
 * Whether and how the banner shows: an owed invoice past its due date, while
 * collections is offered to the company (not hidden) and the invoice has no
 * open case to show instead. Nothing for a person who may not write.
 */
export function overdueBanner(input: {
  invoice: EntryInvoice
  start: CollectionsStartState
  openCase: EntryCase | null
  today: string
  canWrite: boolean
  canManage: boolean
  defaultStartStep: StartStep | null
  readiness?: Pick<CollectionReadinessView, 'watching' | 'startSteps' | 'defaultStartStep'> | null
  /** The invoice's item in today's pending run (batchItemFor): the banner points there instead of a send of its own. */
  batchItem?: Pick<BatchItem, 'kind' | 'start_step'> | null
}): OverdueBanner | null {
  const { invoice, start, openCase, today } = input
  if (!input.canWrite || start === 'hidden') return null
  if (!isOverdueUnpaid(invoice, today)) return null
  if (!showSendToCollection({ invoice, start, openCase, today })) return null
  const base: BannerBase = { dueDate: invoice.due_date ?? '', overdueDays: daysBetween(invoice.due_date, today) }
  if (start === 'upgrade') return { ...base, kind: 'upgrade' }
  if (start === 'activate') return { ...base, kind: 'activate', canActivate: input.canManage }
  if (input.batchItem) {
    // Proposed in today's run: one send, the run's, never a second one from here.
    const step: StartStep = input.batchItem.start_step === 'collection' ? 'collection' : 'reminder'
    return { ...base, kind: 'batch', step, labelKey: step === 'reminder' ? 'banner_in_batch_reminder' : 'banner_in_batch_collection' }
  }
  const step = bannerStep(input.defaultStartStep, input.readiness)
  return { ...base, kind: 'ready', step, labelKey: sendLabelKey(step) }
}

/**
 * The bank check in one line under the banner's amount. `undefined` while
 * the check loads, `null` when it could not be read (the dialog and the
 * commit check anyway). A requirement the invoice fails reads first: it is
 * what the dialog will ask about.
 */
export type BannerCheckLine =
  | { key: 'banner_bank_checking' }
  | { key: 'banner_bank_unavailable' }
  | { key: 'banner_bank_clear'; date: string | null }
  | { key: 'banner_bank_candidates'; count: number }
  | { key: 'banner_bank_stale'; date: string | null }
  | { key: 'banner_bank_no_bank' }
  | { key: 'banner_blocked'; block: EligibilityBlock }

export function bannerCheckLine(readiness: Pick<CollectionReadinessView, 'eligible' | 'blocks' | 'bankCheck'> | null | undefined): BannerCheckLine {
  if (readiness === undefined) return { key: 'banner_bank_checking' }
  if (readiness === null) return { key: 'banner_bank_unavailable' }
  if (!readiness.eligible && readiness.blocks.length > 0) return { key: 'banner_blocked', block: readiness.blocks[0]! }
  const bank = bankCheckState(readiness.bankCheck, [])
  switch (bank.outcome) {
    case 'pass':
      return { key: 'banner_bank_clear', date: readiness.bankCheck.lastSyncedAt }
    case 'candidates':
      return { key: 'banner_bank_candidates', count: bank.blocking.length }
    case 'stale':
      return { key: 'banner_bank_stale', date: bank.staleAccount?.syncedAt ?? null }
    case 'no_bank':
      return { key: 'banner_bank_no_bank' }
  }
}

/** Whether the check line asks the person to look before sending (an attention tone, not an error). */
export function bannerCheckNeedsLook(line: BannerCheckLine): boolean {
  return line.key === 'banner_bank_candidates' || line.key === 'banner_bank_stale' || line.key === 'banner_bank_no_bank' || line.key === 'banner_blocked'
}

/** What the customer still owes: the checked claim once read, else the invoice's own remaining amount. */
export function bannerUnpaid(
  invoice: Pick<EntryInvoice, 'remaining_amount'> & { total?: number | null },
  readiness: Pick<CollectionReadinessView, 'claim'> | null | undefined,
): number | null {
  if (readiness) return readiness.claim.remaining
  if (typeof invoice.remaining_amount === 'number') return invoice.remaining_amount
  return typeof invoice.total === 'number' ? invoice.total : null
}
