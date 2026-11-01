/**
 * The new Inkorg page's view of the inbox items GET
 * /api/extensions/ext/invoice-inbox/items answers: where each item stands,
 * which views it belongs to, the doors in use and the order a queue runs in.
 *
 * Pure: no client, no I/O, no React. The page reads the extension only over
 * HTTP, so these types describe the wire rows, not the table.
 */
import type { InboxChannelContext, InvoiceExtractionResult } from '@/types'
import { INTAKE_SOURCE_IDS, intakeSourceForInboxItem, type IntakeSourceId } from '@/lib/intake/sources'
import { isInboxItemUnbooked, itemStage } from '@/lib/documents/inbox-item-state'
import { resolveInboxKind, type InboxDocumentKind } from '@/lib/documents/inbox-kind'
import type { BankMatch } from '@/lib/documents/inbox-bank-match'
import { readableName } from './names'
import type { InboxPairing } from './pairs'

/**
 * Whether the item's own underlag reached the verifikat that books its
 * matched transaction (#1548). The list route derives it; null when there is
 * nothing to derive.
 */
export type UnderlagStatus = 'anchored' | 'unlinked' | 'unlinked_locked' | 'anchored_elsewhere' | 'unknown'

/**
 * Where an empty reading stands when the AI provider could not take the
 * call (its document is stamped failed:provider_unavailable): the inbox sweep
 * reads it again within a quarter of an hour (scheduled) or within two hours
 * (scheduled_later, after one retry), or no automatic reading is coming
 * (exhausted: the attempts are used up, or the item is older than the retry
 * window). The list route derives it; null for any other reading.
 */
export type ReadingRetry = 'scheduled' | 'scheduled_later' | 'exhausted'

/** One row of GET /items, as far as the page reads it. */
export interface InkorgItem {
  id: string
  status: 'received' | 'processing' | 'error'
  source: string
  created_at: string
  channel_context?: InboxChannelContext | null
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
  kind_hint?: string | null
  routed_to_arkiv_at?: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  matched_transaction_journal_entry_id?: string | null
  underlag_status?: UnderlagStatus | null
  /** The verifikat that holds its document and still books it (withDocumentHold). */
  document_journal_entry_id?: string | null
  email_from: string | null
  email_subject: string | null
  error_message: string | null
  /** The vendor's own icon from our logos bucket (lib/vendor-logos), when one is stored. */
  logo_url?: string | null
  /** The bank row it looks already paid by (match on arrival), checked when the list was read; null for none. */
  bank_match?: BankMatch | null
  /**
   * The invoice or receipt it arrived with as one purchase (./pairs.ts),
   * computed when the list was read; null for none.
   */
  pairing?: InboxPairing | null
  /** The provider retry of an empty reading, derived when the list was read; null for none. */
  reading_retry?: ReadingRetry | null
  /**
   * Whether the card number read off it (extracted_data.payment.cardLast4) is
   * one of the company's own cards (lib/documents/bank-match/known-cards.ts),
   * derived when the list was read; null when none was read. A reading can
   * misread a digit (crm#1534): only true shows it as the card that paid.
   */
  payment_card_known?: boolean | null
}

/** Arkiv took it: classified as something not booked from the inbox. It left the queue for its own page. */
function routedAway(item: InkorgItem): boolean {
  return !!item.routed_to_arkiv_at
}

/**
 * The receipt that came with an invoice as one purchase: it rides on the
 * invoice's row as its second document and has no row of its own.
 */
export function isCompanionReceipt(item: Pick<InkorgItem, 'pairing'>): boolean {
  return item.pairing?.role === 'receipt'
}

/**
 * An open half whose other half is booked already (./pairs.ts
 * pairWithBookedHalves): the same purchase, so no decision about paying or
 * booking waits; it only asks to be added to that booking as one more
 * underlag.
 */
export function isBookedCompanion(item: Pick<InkorgItem, 'pairing'>): boolean {
  return item.pairing?.role === 'booked_companion'
}

/** The receipt an invoice's row carries, when the list has it. */
export function companionOf(item: InkorgItem, items: readonly InkorgItem[]): InkorgItem | null {
  if (item.pairing?.role !== 'invoice') return null
  const receiptId = item.pairing.receipt_item_id
  return items.find((other) => other.id === receiptId) ?? null
}

/**
 * Waiting for a person's decision: the Behöver dig view. A reading in flight
 * waits for nobody, and neither does a half of a purchase already booked
 * (it is listed in its door, with the booking it belongs on).
 */
export function needsYou(item: InkorgItem): boolean {
  if (routedAway(item) || isCompanionReceipt(item) || isBookedCompanion(item)) return false
  const stage = itemStage(item)
  return stage === 'needs_action' || stage === 'linked' || stage === 'error'
}

/**
 * Still in the inbox: came in and is not handled yet. Booked items live in
 * Dokument and on their verifikat; a companion receipt is in the inbox on
 * its invoice's row.
 */
export function stillInInbox(item: InkorgItem): boolean {
  return isInboxItemUnbooked(item) && !isCompanionReceipt(item)
}

/** The door the item came through, by the one vocabulary (lib/intake/sources.ts). */
export function doorOf(item: InkorgItem): IntakeSourceId {
  return (
    intakeSourceForInboxItem({
      source: item.source,
      channel_context: (item.channel_context ?? null) as { intake_source?: unknown; channel?: unknown } | null,
    }) ?? 'upload'
  )
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * What the content area shows: Behöver dig (the decisions waiting), Saknar
 * underlag (purchases with no document, from its own endpoint), Saknar
 * underlag for one supplier's portal (a row under Portaler: `portal` is the
 * supplier as the portal directory names it) or one door.
 */
export type InkorgView =
  | { kind: 'need' }
  | { kind: 'missing'; portal?: string }
  | { kind: 'door'; door: IntakeSourceId }

export const DEFAULT_VIEW: InkorgView = { kind: 'need' }

/** The longest supplier name a `?view=portal:` value may carry; the directory's are far shorter. */
const MAX_PORTAL_NAME = 80

/** A stable string for a view: the `?view=` value and a React key. */
export function viewKey(view: InkorgView): string {
  if (view.kind === 'door') return `door:${view.door}`
  if (view.kind === 'missing' && view.portal) return `portal:${view.portal}`
  return view.kind
}

/** The view a `?view=` value names; anything unknown is Behöver dig. */
export function parseViewKey(value: string | null | undefined): InkorgView {
  if (value === 'missing') return { kind: 'missing' }
  if (value?.startsWith('portal:')) {
    const portal = value.slice('portal:'.length).trim()
    if (portal && portal.length <= MAX_PORTAL_NAME) return { kind: 'missing', portal }
  }
  if (value?.startsWith('door:')) {
    const door = value.slice('door:'.length)
    if ((INTAKE_SOURCE_IDS as readonly string[]).includes(door)) return { kind: 'door', door: door as IntakeSourceId }
  }
  return DEFAULT_VIEW
}

/** Newest first, then by id: the order the list route answers in, so a refetch never reshuffles a queue. */
export function orderByArrival<T extends Pick<InkorgItem, 'id' | 'created_at'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * The items a view lists, in queue order. Saknar underlag lists purchases,
 * not items, so its queue is empty here.
 */
export function queueFor(items: readonly InkorgItem[], view: InkorgView): InkorgItem[] {
  if (view.kind === 'missing') return []
  const inView =
    view.kind === 'need'
      ? items.filter(needsYou)
      : items.filter((item) => stillInInbox(item) && doorOf(item) === view.door)
  return orderByArrival(inView)
}

/** How long an item Arkiv took out of the inbox is still named in the view it left: long enough to notice. */
export const ROUTED_AWAY_NOTICE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Items that came in and then left the inbox for Dokument within the notice
 * window: Arkiv read them as no underlag to book (a bank statement, an
 * agreement). Behöver dig names all of them, a door the ones it received.
 * Without this a mailed batch of statements showed for a minute and was gone
 * with no word on where (PH 225).
 */
export function recentlyRoutedAway(items: readonly InkorgItem[], view: InkorgView, now: number = Date.now()): InkorgItem[] {
  if (view.kind === 'missing') return []
  return items.filter((item) => {
    if (!item.routed_to_arkiv_at) return false
    const left = Date.parse(item.routed_to_arkiv_at)
    if (!Number.isFinite(left) || now - left > ROUTED_AWAY_NOTICE_MS) return false
    return view.kind === 'need' || doorOf(item) === view.door
  })
}

/** One row of the rail's Brevlådor: a door in use, and how many of its items are still in the inbox. */
export interface DoorRow {
  door: IntakeSourceId
  waiting: number
}

/**
 * The doors this company uses: every door any item came through, booked
 * ones included (a door in use stays listed when everything from it is
 * handled), in the vocabulary's order. Items Arkiv took are not the inbox's.
 */
export function doorsInUse(items: readonly InkorgItem[]): DoorRow[] {
  const waiting = new Map<IntakeSourceId, number>()
  for (const item of items) {
    if (routedAway(item)) continue
    const door = doorOf(item)
    waiting.set(door, (waiting.get(door) ?? 0) + (stillInInbox(item) ? 1 : 0))
  }
  return INTAKE_SOURCE_IDS.filter((door) => waiting.has(door)).map((door) => ({ door, waiting: waiting.get(door) ?? 0 }))
}

/** How many decisions wait: the count beside Behöver dig. */
export function needCount(items: readonly InkorgItem[]): number {
  return items.filter(needsYou).length
}

// ---------------------------------------------------------------------------
// What a row says
// ---------------------------------------------------------------------------

export interface ItemHeadline {
  /** The supplier as read, else the mail subject, else null (the row says "Okänt dokument"). */
  name: string | null
  kind: InboxDocumentKind | null
  amount: number | null
  currency: string
  /** The document's own date (invoice or receipt date), when read. */
  documentDate: string | null
}

/**
 * The amount to show: the read total; for a document without one (a
 * bankintyg, a letter), the one distinct amount read off it, when there is
 * exactly one. Two or more stay ambiguous and show no amount.
 */
function headlineAmount(data: InvoiceExtractionResult | null): number | null {
  const total = data?.totals?.total
  if (total != null && Number.isFinite(total)) return total
  const distinct = [
    ...new Set((data?.prominentAmounts ?? []).map((a) => a.amount).filter((a) => Number.isFinite(a) && a !== 0)),
  ]
  return distinct.length === 1 ? distinct[0] : null
}

export function itemHeadline(item: InkorgItem): ItemHeadline {
  const data = item.extracted_data
  const supplier = data?.supplier?.name?.trim() || null
  const subject = item.email_subject?.trim() || null
  return {
    // A supplier that prints its name in capitals is set as a person reads it (lib/inkorg/names).
    name: readableName(supplier ?? subject),
    kind: resolveInboxKind({ kind_hint: item.kind_hint ?? null, extracted_data: data }),
    amount: headlineAmount(data),
    currency: data?.invoice?.currency || 'SEK',
    documentDate: data?.invoice?.invoiceDate ?? null,
  }
}
