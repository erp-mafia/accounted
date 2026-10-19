/**
 * The reads behind the invoice and receipt pairing (./pairs.ts holds the
 * rule): which arrivals produced each item (arrival_outputs), and the items
 * that came with one item.
 *
 * Read only. Every query filters by company_id beside RLS (the service-role
 * doors have none). Throws on a failed read: every caller treats a pairing
 * it could not read as no pairing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PairableItem } from './pairs'

/** Ids per `.in()` filter, so the request line stays well inside URL limits. */
const ID_CHUNK = 100
/** The items one delivery may hold: a mail carries a handful of attachments. */
const SIBLINGS_READ = 50

/**
 * An item as the pairing and the doors acting on a pair read it. Each read
 * spells its columns out (a literal select, so the schema guard can check
 * them): id, status, source, document_id, resend_email_id, channel_context,
 * kind_hint, extracted_data, routed_to_arkiv_at, matched_transaction_id,
 * created_supplier_invoice_id, created_journal_entry_id.
 */
export interface PairableRow extends PairableItem {
  document_id: string | null
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`inbox pairing: ${what} failed: ${error.message}`)
}

function chunked<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK))
  return out
}

/** The arrivals that produced each of `itemIds`, by item id; items without one are absent. */
export async function readArrivalIds(
  supabase: SupabaseClient,
  companyId: string,
  itemIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const ids of chunked([...new Set(itemIds)])) {
    const { data, error } = await supabase
      .from('arrival_outputs')
      .select('arrival_id, output_id')
      .eq('company_id', companyId)
      .eq('output_kind', 'inbox_item')
      .in('output_id', ids)
    if (error) fail('arrival read', error)
    for (const row of (data ?? []) as Array<{ arrival_id: string; output_id: string }>) {
      out.set(row.output_id, [...(out.get(row.output_id) ?? []), row.arrival_id])
    }
  }
  return out
}

/**
 * The reading the list shows for an item routed in before its own landed:
 * the document's (the same stand-in as GET /items).
 */
async function withDocumentReadings(supabase: SupabaseClient, companyId: string, rows: PairableRow[]): Promise<PairableRow[]> {
  const unread = rows.filter((row) => row.extracted_data == null && row.document_id).map((row) => row.document_id as string)
  if (unread.length === 0) return rows
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id, extracted_data')
    .eq('company_id', companyId)
    .in('id', unread)
  if (error) fail('document reading read', error)
  const readingOf = new Map(((data ?? []) as Array<{ id: string; extracted_data: unknown }>).map((d) => [d.id, d.extracted_data]))
  return rows.map((row) =>
    row.extracted_data == null && row.document_id && readingOf.get(row.document_id) != null
      ? { ...row, extracted_data: readingOf.get(row.document_id) }
      : row,
  )
}

/**
 * The items that came in the same delivery as `item`, the item itself
 * included: the other outputs of its arrivals, the other attachments of its
 * inbound mail and of its hunted message. With the arrivals each was read
 * through, for pairInboxItems.
 */
export async function readDeliverySiblings(
  supabase: SupabaseClient,
  companyId: string,
  item: PairableRow,
): Promise<{ items: PairableRow[]; arrivalIds: Map<string, string[]> }> {
  const arrivalIds = new Map<string, string[]>()
  const ownArrivals = (await readArrivalIds(supabase, companyId, [item.id])).get(item.id) ?? []
  const ids = new Set<string>()

  if (ownArrivals.length > 0) {
    arrivalIds.set(item.id, ownArrivals)
    const { data, error } = await supabase
      .from('arrival_outputs')
      .select('arrival_id, output_id')
      .eq('company_id', companyId)
      .eq('output_kind', 'inbox_item')
      .in('arrival_id', ownArrivals)
      .limit(SIBLINGS_READ)
    if (error) fail('arrival outputs read', error)
    for (const row of (data ?? []) as Array<{ arrival_id: string; output_id: string }>) {
      if (row.output_id === item.id) continue
      ids.add(row.output_id)
      arrivalIds.set(row.output_id, [...(arrivalIds.get(row.output_id) ?? []), row.arrival_id])
    }
  }

  const byKey: PairableRow[] = []
  const mailId = typeof item.resend_email_id === 'string' && item.resend_email_id ? item.resend_email_id : null
  if (mailId) {
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select('id, status, source, document_id, resend_email_id, channel_context, kind_hint, extracted_data, routed_to_arkiv_at, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id')
      .eq('company_id', companyId)
      .eq('resend_email_id', mailId)
      .limit(SIBLINGS_READ)
    if (error) fail('mail siblings read', error)
    byKey.push(...((data ?? []) as unknown as PairableRow[]))
  }
  const messageId = (item.channel_context as { mail_message_id?: unknown } | null)?.mail_message_id
  if (typeof messageId === 'string' && messageId) {
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select('id, status, source, document_id, resend_email_id, channel_context, kind_hint, extracted_data, routed_to_arkiv_at, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id')
      .eq('company_id', companyId)
      .eq('channel_context->>mail_message_id', messageId)
      .limit(SIBLINGS_READ)
    if (error) fail('message siblings read', error)
    byKey.push(...((data ?? []) as unknown as PairableRow[]))
  }

  const known = new Set([item.id, ...byKey.map((row) => row.id)])
  const missing = [...ids].filter((id) => !known.has(id))
  const byArrival: PairableRow[] = []
  if (missing.length > 0) {
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select('id, status, source, document_id, resend_email_id, channel_context, kind_hint, extracted_data, routed_to_arkiv_at, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id')
      .eq('company_id', companyId)
      .in('id', missing)
    if (error) fail('arrival siblings read', error)
    byArrival.push(...((data ?? []) as unknown as PairableRow[]))
  }

  const seen = new Set<string>()
  const rows = [item, ...byKey, ...byArrival].filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
  return { items: await withDocumentReadings(supabase, companyId, rows), arrivalIds }
}
