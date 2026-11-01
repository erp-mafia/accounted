/**
 * An invoice and its receipt from the same arrival are one purchase.
 *
 * A supplier's mail often carries both: the invoice and the receipt that
 * says it was paid (Stripe sends "Your receipt from X" with Invoice-....pdf
 * and Receipt-....pdf). Each attachment becomes an inbox item of its own, so
 * the Inkorg asked "Hur betalas fakturan?" about an invoice whose payment
 * proof sat in the next row. Read here, they are one purchase: the invoice
 * is the underlag, the receipt its proof of payment.
 *
 * A pair needs all of:
 *   - one arrival: the two items share a delivery key (the arrival that
 *     produced both, lib/intake/arrivals.ts arrival_outputs; for items filed
 *     before arrivals existed, the inbound mail's id, resend_email_id, or the
 *     hunted message's id);
 *   - one invoice and one receipt, both still in the inbox (read, not
 *     booked, not registered, not routed to Arkiv). One exception: an
 *     invoice registered as a supplier invoice that is not paid yet
 *     (PairOptions.awaitingPayment) is still the purchase its receipt
 *     belongs to, since the payment the receipt proves is not in the books:
 *     the receipt stays its companion until that payment is booked and the
 *     receipt follows onto it (lib/operations/inbox-companion.ts);
 *   - the same amount: both totals read, equal to the öre, in one currency;
 *   - the same document: the invoice number, when both carry one (two
 *     different numbers are two purchases), else the same supplier and the
 *     same date;
 *   - no other reading in the arrival that agrees as well: a receipt that
 *     fits two invoices, or an invoice that fits two receipts, pairs with
 *     neither. A proposal about which is which would be a guess;
 *   - not matched to two different bank rows.
 *
 * Read-time only: nothing is merged and both items stay. The list shows the
 * invoice's row with the receipt as its second document, and the receipt's
 * own row is hidden as the invoice's companion.
 *
 * Pure: no client, no I/O, no React.
 */
import type { InvoiceExtractionResult } from '@/types'
import { resolveInboxKind } from '@/lib/documents/inbox-kind'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { itemStage, type StageFields } from '@/lib/documents/inbox-item-state'

/** What made the two one purchase. */
export type PairBasis = 'invoice_number' | 'supplier_amount_date'

/** An invoice and its receipt, both still in the inbox (or the invoice registered and unpaid). */
export type PurchasePair =
  | { role: 'invoice'; receipt_item_id: string; basis: PairBasis }
  | { role: 'receipt'; invoice_item_id: string; basis: PairBasis }

/**
 * An open half whose other half is booked already (pairWithBookedHalves):
 * it belongs on that booking as one more underlag, never a booking of its
 * own. The list adds where that booking is (its verifikat, the voucher label
 * and whether its period is locked).
 */
export interface BookedCompanion {
  role: 'booked_companion'
  /** The booked half: the invoice or the receipt this one came with. */
  booked_item_id: string
  booked_kind: 'invoice' | 'receipt'
  basis: PairBasis
  /** The verifikat the booked half is on, when the list could read it. */
  journal_entry_id?: string | null
  /** Its voucher label (A12), when read. */
  voucher?: string | null
  /** Its period is closed or locked: no document can be added there. */
  locked?: boolean
}

/** The pair as a list row carries it (GET /items `pairing`). */
export type InboxPairing = PurchasePair | BookedCompanion

/** The item columns the pairing reads: a wire row, or the table row a server door reads. */
export type PairableItem = StageFields & {
  id: string
  source?: string | null
  resend_email_id?: string | null
  channel_context?: unknown
  kind_hint?: string | null
  extracted_data?: unknown
  routed_to_arkiv_at?: string | null
}

/** What one document says about the purchase, normalised for comparison. */
export interface PurchaseFacts {
  kind: 'supplier_invoice' | 'receipt'
  invoiceNumber: string | null
  supplier: string | null
  total: number
  currency: string
  date: string | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** An invoice number as printed: case, spaces and a leading # do not make it another one. */
export function normaliseInvoiceNumber(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const cleaned = raw.toUpperCase().replace(/\s+/g, '').replace(/^#/, '')
  return cleaned === '' ? null : cleaned
}

/** A supplier name as read: case and punctuation do not make it another one. */
export function normaliseSupplierName(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return cleaned === '' ? null : cleaned
}

/**
 * Which of the two a document is. The reading of the document itself
 * first: a declared kind (kind_hint) comes from the mail's plus-address tag
 * and so says the same of every attachment, which is exactly what a mail
 * carrying an invoice and its receipt gets wrong for one of them. A credit
 * is neither.
 */
function pairKind(item: Pick<PairableItem, 'kind_hint' | 'extracted_data'>): PurchaseFacts['kind'] | null {
  const data = (item.extracted_data ?? null) as InvoiceExtractionResult | null
  const resolved = resolveInboxKind({ kind_hint: item.kind_hint ?? null, extracted_data: data })
  if (resolved === 'credit_note') return null
  const read = data?.documentKind
  if (read === 'supplier_invoice' || read === 'receipt') return read
  return resolved === 'supplier_invoice' || resolved === 'receipt' ? resolved : null
}

/** The purchase facts of an invoice or a receipt, or null for any other document or one without a total. */
export function purchaseFacts(item: Pick<PairableItem, 'kind_hint' | 'extracted_data'>): PurchaseFacts | null {
  const data = (item.extracted_data ?? null) as InvoiceExtractionResult | null
  const kind = pairKind(item)
  if (!kind) return null
  const total = data?.totals?.total
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  const date = text(data?.invoice?.invoiceDate)
  return {
    kind,
    invoiceNumber: normaliseInvoiceNumber(data?.invoice?.invoiceNumber),
    supplier: normaliseSupplierName(data?.supplier?.name),
    total,
    currency: (text(data?.invoice?.currency) ?? 'SEK').toUpperCase(),
    date: date && ISO_DATE_RE.test(date.slice(0, 10)) ? date.slice(0, 10) : null,
  }
}

/**
 * Whether an invoice and a receipt read as the same purchase, and on what:
 * the amount always (to the öre, one currency), then the invoice number when
 * both carry one, else the supplier and the date. Null when they do not.
 */
export function purchaseAgreement(invoice: PurchaseFacts, receipt: PurchaseFacts): PairBasis | null {
  if (invoice.kind !== 'supplier_invoice' || receipt.kind !== 'receipt') return null
  if (invoice.currency !== receipt.currency) return null
  if (Math.abs(invoice.total - receipt.total) >= 0.005) return null
  if (invoice.invoiceNumber && receipt.invoiceNumber) {
    return invoice.invoiceNumber === receipt.invoiceNumber ? 'invoice_number' : null
  }
  if (invoice.supplier && invoice.supplier === receipt.supplier && invoice.date && invoice.date === receipt.date) {
    return 'supplier_amount_date'
  }
  return null
}

/**
 * The keys that name the delivery an item came in: every arrival that
 * produced it, the inbound mail it was an attachment of, the hunted message
 * it was found in. Two items with a key in common came together.
 */
export function deliveryKeys(item: PairableItem, arrivalIds: readonly string[] = []): string[] {
  const keys = arrivalIds.map((id) => `arrival:${id}`)
  const mailId = text(item.resend_email_id)
  if (mailId) keys.push(`email:${mailId}`)
  const context = (item.channel_context ?? null) as { mail_message_id?: unknown } | null
  const messageId = text(context?.mail_message_id)
  if (messageId) keys.push(`message:${messageId}`)
  return keys
}

/** Still waiting in the inbox with its reading landed: the only items a pair is made of. */
function openForPairing(item: PairableItem): boolean {
  if (item.routed_to_arkiv_at) return false
  if (item.status !== 'received') return false
  const stage = itemStage(item)
  return stage === 'needs_action' || stage === 'linked'
}

const NONE: ReadonlySet<string> = new Set()

/**
 * An invoice registered as a supplier invoice that is still unpaid (the
 * caller read that, PairOptions.awaitingPayment): it pairs as an invoice,
 * never as a receipt, and only while nothing booked it on a verifikat.
 */
function awaitingPaymentInvoice(item: PairableItem, awaitingPayment: ReadonlySet<string>): boolean {
  return (
    awaitingPayment.has(item.id) &&
    !!item.created_supplier_invoice_id &&
    !item.created_journal_entry_id &&
    !item.routed_to_arkiv_at &&
    pairKind(item) === 'supplier_invoice'
  )
}

export interface PairOptions {
  /** The arrivals behind each item, by item id (arrival_outputs, kind inbox_item). */
  arrivalIds?: ReadonlyMap<string, readonly string[]>
  /**
   * Items to read as still open whatever they say now: the invoice whose
   * booking just landed, when its receipt is completed with it.
   */
  assumeOpen?: ReadonlySet<string>
  /**
   * Invoices registered as a supplier invoice that can still take a payment,
   * by item id (./pairs-read.ts readAwaitingPayment): each still pairs with
   * the receipt it came with. Once paid it is not here any more, and a
   * receipt that did not follow the payment stands on its own for a person.
   */
  awaitingPayment?: ReadonlySet<string>
}

/** Items grouped by delivery: two items sharing any key are in one group. */
function deliveryGroups(items: readonly PairableItem[], arrivalIds: ReadonlyMap<string, readonly string[]>): PairableItem[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    parent.set(id, root)
    return root
  }
  const ownerOfKey = new Map<string, string>()
  for (const item of items) {
    if (!parent.has(item.id)) parent.set(item.id, item.id)
    for (const key of deliveryKeys(item, arrivalIds.get(item.id) ?? [])) {
      const owner = ownerOfKey.get(key)
      if (owner === undefined) ownerOfKey.set(key, item.id)
      else parent.set(find(item.id), find(owner))
    }
  }
  const groups = new Map<string, PairableItem[]>()
  for (const item of items) {
    const root = find(item.id)
    groups.set(root, [...(groups.get(root) ?? []), item])
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

/**
 * The invoice and receipt pairs among `items`, by item id: each invoice
 * names its receipt and each receipt its invoice. Items in no pair are
 * absent.
 */
export function pairInboxItems(items: readonly PairableItem[], options: PairOptions = {}): Map<string, PurchasePair> {
  const out = new Map<string, PurchasePair>()
  const assumeOpen = options.assumeOpen ?? NONE
  const awaitingPayment = options.awaitingPayment ?? NONE
  const seen = new Set<string>()
  const unique = items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))

  for (const group of deliveryGroups(unique, options.arrivalIds ?? new Map())) {
    const open = group.filter(
      (item) => assumeOpen.has(item.id) || openForPairing(item) || awaitingPaymentInvoice(item, awaitingPayment),
    )
    const read = open.flatMap((item) => {
      const facts = purchaseFacts(item)
      return facts ? [{ item, facts }] : []
    })
    const invoices = read.filter((r) => r.facts.kind === 'supplier_invoice')
    const receipts = read.filter((r) => r.facts.kind === 'receipt')
    if (invoices.length === 0 || receipts.length === 0) continue

    const agreements: Array<{ invoice: PairableItem; receipt: PairableItem; basis: PairBasis }> = []
    for (const invoice of invoices) {
      for (const receipt of receipts) {
        const basis = purchaseAgreement(invoice.facts, receipt.facts)
        if (!basis) continue
        const a = invoice.item.matched_transaction_id ?? null
        const b = receipt.item.matched_transaction_id ?? null
        if (a && b && a !== b) continue
        agreements.push({ invoice: invoice.item, receipt: receipt.item, basis })
      }
    }
    for (const pair of agreements) {
      const sameInvoice = agreements.filter((a) => a.invoice.id === pair.invoice.id).length
      const sameReceipt = agreements.filter((a) => a.receipt.id === pair.receipt.id).length
      if (sameInvoice !== 1 || sameReceipt !== 1) continue
      out.set(pair.invoice.id, { role: 'invoice', receipt_item_id: pair.receipt.id, basis: pair.basis })
      out.set(pair.receipt.id, { role: 'receipt', invoice_item_id: pair.invoice.id, basis: pair.basis })
    }
  }
  return out
}

/**
 * The items a pairing has to look at: an invoice or a receipt still open,
 * or an invoice registered and still unpaid, the only ones a pair is made of.
 */
export function mayPair(item: PairableItem, awaitingPayment: ReadonlySet<string> = NONE): boolean {
  return (openForPairing(item) || awaitingPaymentInvoice(item, awaitingPayment)) && purchaseFacts(item) !== null
}

export interface BookedHalfOptions {
  /** The arrivals behind each item, by item id (arrival_outputs, kind inbox_item). */
  arrivalIds?: ReadonlyMap<string, readonly string[]>
  /** Items already in a pair of two open halves (pairInboxItems): never paired again here. */
  paired?: ReadonlySet<string>
  /** Invoices registered as a supplier invoice that is paid, by item id: booked halves. */
  paidSupplierInvoices?: ReadonlySet<string>
}

/**
 * Booked: on a verifikat (its own, or its matched bank row's with this
 * underlag on it), or registered as a supplier invoice that is paid. Not
 * routed to Arkiv.
 */
function bookedHalf(item: PairableItem, paidSupplierInvoices: ReadonlySet<string>): boolean {
  if (item.routed_to_arkiv_at) return false
  if (item.created_journal_entry_id) return true
  if (item.created_supplier_invoice_id) return paidSupplierInvoices.has(item.id)
  return itemStage(item) === 'booked'
}

/** The invoice and receipt of the two, and on what they agree; null when they do not. */
function agreementOf(a: { item: PairableItem; facts: PurchaseFacts }, b: { item: PairableItem; facts: PurchaseFacts }): PairBasis | null {
  if (a.facts.kind === b.facts.kind) return null
  const [invoice, receipt] = a.facts.kind === 'supplier_invoice' ? [a, b] : [b, a]
  const basis = purchaseAgreement(invoice.facts, receipt.facts)
  if (!basis) return null
  const x = a.item.matched_transaction_id ?? null
  const y = b.item.matched_transaction_id ?? null
  return x && y && x !== y ? null : basis
}

/**
 * An open half whose other half was booked already, by the same rule as a
 * pair of two open halves (one arrival, the amount to the öre in one
 * currency, the invoice number or else the supplier and the date): the
 * invoice still open while its receipt was booked, or the receipt still open
 * while its invoice was booked or registered and paid. It is the same
 * purchase, so it is never booked or paid again: it belongs on the other
 * half's verifikat as one more underlag.
 *
 * One to one, conservatively: the open half agrees with exactly one other
 * document of the arrival (open or booked), that one booked, and the booked
 * half agrees with exactly one document of the other kind, this one. Open
 * halves already in a pair of two open ones are left to that pair. By open
 * item id; the booked halves are absent.
 */
export function pairWithBookedHalves(items: readonly PairableItem[], options: BookedHalfOptions = {}): Map<string, BookedCompanion> {
  const out = new Map<string, BookedCompanion>()
  const paired = options.paired ?? NONE
  const paid = options.paidSupplierInvoices ?? NONE
  const seen = new Set<string>()
  const unique = items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
  const withFacts = (list: PairableItem[]) =>
    list.flatMap((item) => {
      const facts = purchaseFacts(item)
      return facts ? [{ item, facts }] : []
    })

  for (const group of deliveryGroups(unique, options.arrivalIds ?? new Map())) {
    const open = withFacts(group.filter((item) => openForPairing(item) && !paired.has(item.id)))
    const booked = withFacts(group.filter((item) => bookedHalf(item, paid)))
    if (open.length === 0 || booked.length === 0) continue
    const everyone = [...open, ...booked]
    const agreementsWith = (one: (typeof everyone)[number]) =>
      everyone.flatMap((other) => {
        if (other.item.id === one.item.id) return []
        const basis = agreementOf(one, other)
        return basis ? [{ other, basis }] : []
      })

    for (const half of open) {
      const agreements = agreementsWith(half)
      if (agreements.length !== 1) continue
      const [{ other, basis }] = agreements
      if (!booked.includes(other)) continue
      if (agreementsWith(other).length !== 1) continue
      // An open half matched to a bank row of its own waits on that row, not on the other half's booking.
      if (half.item.matched_transaction_id && half.item.matched_transaction_id !== (other.item.matched_transaction_id ?? null)) continue
      out.set(half.item.id, {
        role: 'booked_companion',
        booked_item_id: other.item.id,
        booked_kind: other.facts.kind === 'supplier_invoice' ? 'invoice' : 'receipt',
        basis,
      })
    }
  }
  return out
}

/** An open item whose other half is booked already (pairWithBookedHalves): it rides on that booking. */
export function mayBeBookedHalf(item: PairableItem, paidSupplierInvoices: ReadonlySet<string> = NONE): boolean {
  return bookedHalf(item, paidSupplierInvoices) && purchaseFacts(item) !== null
}
