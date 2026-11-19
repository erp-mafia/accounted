/**
 * Inbox items that read as one supplier invoice: the same supplier and the
 * same invoice number, and no invoice date that says otherwise.
 *
 * A paper invoice photographed a page at a time arrives as one item per page.
 * Each page is read with the invoice's supplier and number, but the total only
 * on the page that prints it, so the inbox showed two independent invoices:
 * one could be registered with half its content, or both booked (agent
 * feedback 2026-11-06). A supplier's copy or reminder of an invoice already in
 * the inbox is the same invoice too. It is registered or booked once; the
 * other items are its extra pages or copies, an underlag of that booking.
 *
 * Read-time only: nothing is merged, moved or deleted. Each item still open in
 * such a group names the others, and the one of them already registered or
 * booked when there is exactly one, so the list and the agent tools say so
 * before a second booking. An item handled already names nothing.
 *
 * The reading decides, never the declared kind: a photo uploaded as a receipt
 * that reads as a supplier invoice is one. An invoice and its receipt are one
 * purchase by the pair rule (./pairs.ts), not by this one: a receipt never
 * joins a group here. Credit notes never do either. A group whose read dates
 * disagree is left alone: a number a supplier reuses is no proof.
 *
 * Pure: no client, no I/O, no React.
 */
import type { InvoiceExtractionResult } from '@/types'
import { resolveInboxKind } from '@/lib/documents/inbox-kind'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { itemStage, type StageFields } from '@/lib/documents/inbox-item-state'
import { normaliseInvoiceNumber, normaliseSupplierName } from './pairs'

/** The item columns the rule reads: a wire row, or the table row a server door reads. */
export type SameInvoiceItem = StageFields & {
  id: string
  created_at?: string | null
  extracted_data?: unknown
}

/** What an open item's row says about the others read as the same invoice. */
export interface SameInvoice {
  /** The other items read as this invoice, oldest first. */
  item_ids: string[]
  /** The one of them registered as a supplier invoice or booked, when exactly one is. */
  handled_item_id: string | null
}

/** Supplier and invoice number as one key, or null when the item is no supplier invoice or lacks either. */
function invoiceKey(item: SameInvoiceItem): { key: string; date: string | null } | null {
  const data = (item.extracted_data ?? null) as InvoiceExtractionResult | null
  if (data?.documentKind !== 'supplier_invoice') return null
  if (resolveInboxKind({ kind_hint: null, extracted_data: data }) !== 'supplier_invoice') return null
  const supplier = normaliseSupplierName(data.supplier?.name)
  const number = normaliseInvoiceNumber(data.invoice?.invoiceNumber)
  if (!supplier || !number) return null
  const raw = typeof data.invoice?.invoiceDate === 'string' ? data.invoice.invoiceDate.slice(0, 10) : ''
  return { key: JSON.stringify([supplier, number]), date: ISO_DATE_RE.test(raw) ? raw : null }
}

/** Still waiting in the inbox: the items a person or an agent is about to act on. */
function open(item: SameInvoiceItem): boolean {
  if (item.routed_to_arkiv_at) return false
  return itemStage(item) !== 'booked'
}

/**
 * The same-invoice groups among `items`, by open item id. Items in no group,
 * and items handled already, are absent.
 */
export function sameInvoiceItems(items: readonly SameInvoiceItem[]): Map<string, SameInvoice> {
  const groups = new Map<string, Array<{ item: SameInvoiceItem; date: string | null }>>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id) || item.routed_to_arkiv_at) continue
    seen.add(item.id)
    const read = invoiceKey(item)
    if (!read) continue
    groups.set(read.key, [...(groups.get(read.key) ?? []), { item, date: read.date }])
  }

  const out = new Map<string, SameInvoice>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    if (new Set(group.flatMap((g) => (g.date ? [g.date] : []))).size > 1) continue
    const ordered = [...group].sort(
      (a, b) => String(a.item.created_at ?? '').localeCompare(String(b.item.created_at ?? '')) || a.item.id.localeCompare(b.item.id),
    )
    const handled = ordered.filter((g) => !open(g.item))
    for (const { item } of ordered) {
      if (!open(item)) continue
      out.set(item.id, {
        item_ids: ordered.filter((g) => g.item.id !== item.id).map((g) => g.item.id),
        handled_item_id: handled.length === 1 ? handled[0]!.item.id : null,
      })
    }
  }
  return out
}
