/**
 * One purchase is booked once: an inbox item whose other half (the invoice
 * or the receipt it came with, lib/inkorg/pairs.ts) is booked already is
 * never booked again as a purchase of its own.
 *
 * The read-side pairing shows such a half as that booking's companion, but
 * every door that turns an inbox item into a verifikat, an utlägg or a
 * supplier invoice used to take it as a new purchase: SofClo booked the same
 * Anthropic purchase twice as utlägg on 2026-10-15, once from the invoice PDF
 * and once from the receipt PDF of the same mail. Those doors ask here before
 * anything is written (book-direct, the staged voucher, the utlägg
 * registration, the conversion to a supplier invoice, the bulk booking) and
 * refuse with INBOX_ITEM_PAIR_ALREADY_BOOKED, naming the verifikat, so the
 * half is added to that booking instead (POST /api/inkorg/items/:id/companion).
 *
 * Refused too: a receipt whose invoice is registered as a supplier invoice,
 * paid or not. The registration (or its payment) books that purchase, and
 * the receipt follows onto the payment's verifikat.
 *
 * The same pairing rule as the list (lib/operations/inbox-pairings.ts), read
 * for one item. A pairing that cannot be read refuses nothing: the guard is
 * logged and the door goes on, as the list then shows the items alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { PairableRow } from '@/lib/inkorg/pairs-read'
import { readInboxPairings } from './inbox-pairings'

const log = createLogger('operations/inbox-pair-guard')

export const PAIR_ALREADY_BOOKED_CODE = 'INBOX_ITEM_PAIR_ALREADY_BOOKED'

/** The other half that already books this purchase. */
export type PairAlreadyBooked = {
  /** The booked half's inbox item. */
  sibling_item_id: string
  sibling_kind: 'invoice' | 'receipt'
  /** The verifikat it is on, when known; null for a supplier invoice registered without one. */
  journal_entry_id: string | null
  /** Its voucher label (A66), when read. */
  voucher: string | null
  /** The supplier invoice the invoice half was registered as, when it was. */
  supplier_invoice_id: string | null
}

/** The refusal as an operation failure: the code, what to show, and where the booking is. */
export interface PairAlreadyBookedFailure {
  ok: false
  code: typeof PAIR_ALREADY_BOOKED_CODE
  details: PairAlreadyBooked & { inbox_item_id: string }
  messageSv: string
  messageEn: string
}

/** The sentence naming the booking, in both languages. */
export function pairAlreadyBookedMessages(found: PairAlreadyBooked): { messageSv: string; messageEn: string } {
  if (found.supplier_invoice_id && !found.voucher) {
    return {
      messageSv:
        'Fakturan från samma köp är registrerad som leverantörsfaktura, så köpet är redan bokfört. Kvittot läggs på betalningens verifikat när betalningen bokförs.',
      messageEn:
        "The invoice from the same purchase is registered as a supplier invoice, so the purchase is booked already. The receipt goes onto the payment's voucher once the payment is booked.",
    }
  }
  const whereSv = found.voucher ? `på verifikat ${found.voucher}` : 'på ett verifikat'
  const whereEn = found.voucher ? `on voucher ${found.voucher}` : 'on a voucher'
  const bookedSv = found.sibling_kind === 'invoice' ? 'Fakturan från samma köp är redan bokförd' : 'Kvittot från samma köp är redan bokfört'
  return {
    messageSv: `${bookedSv} ${whereSv}. Lägg till det här underlaget där i stället, så bokförs köpet inte två gånger.`,
    messageEn: `The ${found.sibling_kind} from the same purchase is booked already ${whereEn}. Add this document there instead, so the purchase is not booked twice.`,
  }
}

async function readItem(supabase: SupabaseClient, companyId: string, inboxItemId: string): Promise<PairableRow | null> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, status, source, document_id, resend_email_id, channel_context, kind_hint, extracted_data, routed_to_arkiv_at, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as PairableRow | null) ?? null
}

/**
 * The other half that already books this item's purchase, or null when there
 * is none (or the pairing could not be read). Read only.
 */
export async function pairSiblingAlreadyBooked(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
): Promise<PairAlreadyBooked | null> {
  try {
    const item = await readItem(supabase, companyId, inboxItemId)
    if (!item) return null
    const pairing = (await readInboxPairings(supabase, companyId, [item], { readDeliveries: true })).get(item.id)
    if (pairing?.role === 'booked_companion') {
      return {
        sibling_item_id: pairing.booked_item_id,
        sibling_kind: pairing.booked_kind,
        journal_entry_id: pairing.journal_entry_id ?? null,
        voucher: pairing.voucher ?? null,
        supplier_invoice_id: null,
      }
    }
    if (pairing?.role === 'receipt') {
      // Its invoice still in the inbox is no booking; one registered as a supplier invoice is.
      const invoice = await readItem(supabase, companyId, pairing.invoice_item_id)
      if (invoice?.created_supplier_invoice_id) {
        return {
          sibling_item_id: invoice.id,
          sibling_kind: 'invoice',
          journal_entry_id: null,
          voucher: null,
          supplier_invoice_id: invoice.created_supplier_invoice_id,
        }
      }
    }
    return null
  } catch (error) {
    log.warn('inbox pair guard could not read the pairing; nothing refused', {
      companyId,
      inboxItemId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** The guard as an operation failure, or null when the item may be booked. */
export async function refuseWhenPairBooked(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
): Promise<PairAlreadyBookedFailure | null> {
  const found = await pairSiblingAlreadyBooked(supabase, companyId, inboxItemId)
  if (!found) return null
  return { ok: false, code: PAIR_ALREADY_BOOKED_CODE, details: { inbox_item_id: inboxItemId, ...found }, ...pairAlreadyBookedMessages(found) }
}
