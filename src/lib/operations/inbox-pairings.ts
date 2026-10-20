/**
 * The pairings the Inkorg shows (lib/inkorg/pairs.ts holds the rules), for
 * the doors that show or count inbox items: the list (GET /items, which has
 * every item) and the Att göra count (which has the open ones and reads
 * their deliveries here).
 *
 *   - an invoice and its receipt, both still in the inbox, or the invoice
 *     registered and unpaid: one row, the receipt its companion;
 *   - an open half whose other half is booked already (booked in the
 *     Underlag workspace before pairs existed, or by a door that did not
 *     take it along): the companion of that booking, with the verifikat it
 *     is on, its voucher label and whether its period is locked. Never a
 *     purchase of its own: it is only ever added to that verifikat.
 *
 * Read only; every query filters by company_id. Throws on a failed read:
 * the callers answer without pairs then.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  mayBeBookedHalf,
  mayPair,
  pairInboxItems,
  pairWithBookedHalves,
  purchaseFacts,
  type BookedCompanion,
  type InboxPairing,
  type PairableItem,
} from '@/lib/inkorg/pairs'
import { readArrivalIds, readArrivalOutputs, readDeliveriesOf, readRegisteredStates, type PairableRow } from '@/lib/inkorg/pairs-read'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { lockedJournalEntryIds } from '@/lib/transactions/inbox-underlag'

/** An item as the pairing reads it, with the list's booked-row enrichment when there is one. */
export type ListedItem = PairableItem & { document_id?: string | null }

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function deliveryKeysOf(item: PairableItem): string[] {
  const keys: string[] = []
  const mail = text(item.resend_email_id)
  if (mail) keys.push(`email:${mail}`)
  const message = text((item.channel_context as { mail_message_id?: unknown } | null)?.mail_message_id)
  if (message) keys.push(`message:${message}`)
  return keys
}

/** The verifikat a booked half is on: its own, its matched row's, or its supplier invoice's payment. */
function entryOfBookedHalf(item: ListedItem & { matched_transaction_journal_entry_id?: string | null }, paymentEntry: ReadonlyMap<string, string>): string | null {
  return item.created_journal_entry_id ?? item.matched_transaction_journal_entry_id ?? paymentEntry.get(item.id) ?? null
}

/** Voucher labels and period locks of the verifikat booked halves are on. */
async function readEntries(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: readonly string[],
): Promise<{ voucher: Map<string, string>; locked: Set<string> }> {
  const voucher = new Map<string, string>()
  const ids = [...new Set(entryIds)]
  if (ids.length === 0) return { voucher, locked: new Set() }
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .in('id', ids.slice(i, i + 100))
    if (error) throw new Error(`inbox pairing: verifikat read failed: ${error.message}`)
    for (const row of (data ?? []) as Array<{ id: string; voucher_series: string | null; voucher_number: number | null }>) {
      const label = formatVoucher(row)
      if (label !== '-') voucher.set(row.id, label)
    }
  }
  return { voucher, locked: await lockedJournalEntryIds(supabase, companyId, ids) }
}

/**
 * Every pairing among `items`, by item id. `items` is the whole list (the
 * list door), or only open items when `readDeliveries` is set: then the rest
 * of their deliveries is read here.
 */
export async function readInboxPairings(
  supabase: SupabaseClient,
  companyId: string,
  items: readonly ListedItem[],
  options: { readDeliveries?: boolean } = {},
): Promise<Map<string, InboxPairing>> {
  const out = new Map<string, InboxPairing>()
  const open = items.filter((item) => mayPair(item))
  if (open.length === 0) return out

  // The arrivals behind the open items, and every item those arrivals produced.
  const ownArrivals = await readArrivalIds(supabase, companyId, open.map((item) => item.id))
  const arrivalOutputs = await readArrivalOutputs(supabase, companyId, [...ownArrivals.values()].flat())
  const arrivalIds = new Map<string, string[]>([...arrivalOutputs, ...ownArrivals])

  // The rest of their deliveries: the list has them already; the count reads them.
  const universe: ListedItem[] = options.readDeliveries
    ? await readDeliveriesOf(supabase, companyId, open as PairableRow[], arrivalOutputs)
    : [...items]

  // Only items that share a delivery with an open one can pair at all.
  const openKeys = new Set(open.flatMap(deliveryKeysOf))
  const related = universe.filter(
    (item) => arrivalOutputs.has(item.id) || ownArrivals.has(item.id) || deliveryKeysOf(item).some((key) => openKeys.has(key)),
  )

  // An open receipt is the only half a registered invoice can be paired with.
  const openReceipt = related.some((item) => mayPair(item) && purchaseFacts(item)?.kind === 'receipt')
  const states = openReceipt
    ? await readRegisteredStates(supabase, companyId, related)
    : { awaitingPayment: new Set<string>(), paid: new Set<string>(), paymentEntry: new Map<string, string>() }

  const pairable = related.filter((item) => mayPair(item, states.awaitingPayment))
  const pairs = pairInboxItems(pairable, { arrivalIds, awaitingPayment: states.awaitingPayment })
  for (const [id, pairing] of pairs) out.set(id, pairing)

  const bookedHalves = related.filter((item) => mayBeBookedHalf(item, states.paid))
  if (bookedHalves.length === 0) return out
  const companions = pairWithBookedHalves([...pairable, ...bookedHalves], {
    arrivalIds,
    paired: new Set(pairs.keys()),
    paidSupplierInvoices: states.paid,
  })
  if (companions.size === 0) return out

  const byId = new Map(related.map((item) => [item.id, item]))
  const entryOf = new Map<string, string | null>()
  for (const companion of companions.values()) {
    const booked = byId.get(companion.booked_item_id)
    entryOf.set(companion.booked_item_id, booked ? entryOfBookedHalf(booked, states.paymentEntry) : null)
  }
  const entries = await readEntries(supabase, companyId, [...entryOf.values()].filter((id): id is string => !!id))
  for (const [id, companion] of companions) {
    const journalEntryId = entryOf.get(companion.booked_item_id) ?? null
    const enriched: BookedCompanion = {
      ...companion,
      journal_entry_id: journalEntryId,
      voucher: journalEntryId ? (entries.voucher.get(journalEntryId) ?? null) : null,
      locked: journalEntryId ? entries.locked.has(journalEntryId) : false,
    }
    out.set(id, enriched)
  }
  return out
}
