/**
 * The underlag of a supplier invoice that no longer books its purchase,
 * released for a new registration.
 *
 * A credit takes the purchase out of the books: the kreditfaktura's verifikat
 * reverses the registration, and the original rests at 'credited' with
 * nothing left to pay (credit.ts). A registration taken back out with a
 * storno rests at 'reversed'. Either way the underlag stays where it is: on
 * the invoice, and on its registration verifikat for good, since a document
 * is never taken off a posted verifikat (BFL 7 kap,
 * enforce_document_journal_entry_immutability). But nothing books the
 * purchase any more, so the same document may back a new registration: an
 * invoice registered on the wrong supplier is credited and registered again
 * on the right one, the särskild rättelsepost of BFL 5 kap 5 §.
 *
 * Three things held it and read no status: the inbox item still named the
 * credited invoice (INBOX_ITEM_ALREADY_CONVERTED), the verifikat the
 * document sits on read as a booking of the purchase (INBOX_ITEM_ALREADY_BOOKED,
 * document_unavailable), and the credited invoice still used the document
 * (document_already_used). Each reads the invoice's status now. The item's
 * pointer stays until the new registration takes it over: a credited
 * purchase can be registered again, it does not come back as work in the
 * Inkorg. Registered again, the underlag is held again, by the new invoice
 * on the document or on its copy, so one credit releases it into one live
 * invoice, never two.
 *
 * The new registration gets a row of its own: a byte-identical copy of the
 * document (lib/documents/link-document.ts), never the original moved and
 * never an altered file. Re-uploading the same bytes met the duplicate check,
 * so people changed a byte of the PDF to get past it, an underlag that no
 * longer matched what was received (BFL 7 kap 1 § 3 st).
 *
 * A credit note never releases its document: it rests at 'credited' too, and
 * its document is the kreditfaktura, never the underlag of a payable.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { documentHoldOf, withDocumentHold, type DocumentHoldRow } from '@/lib/documents/inbox-item-state'
import { archiveDocumentCopy, linkDocumentCopyToVoucher } from '@/lib/documents/link-document'
import { linkBasisColumns } from '@/lib/links/stamp'

/**
 * The registration stood but its copy of the released underlag could not be
 * made (the original could not be read, or failed its check): the invoice
 * keeps the original, and its verifikat waits for its underlag.
 */
export const RELEASED_UNDERLAG_COPY_FAILED_WARNING = {
  code: 'DOCUMENT_LINK_FAILED',
  message_sv: 'Fakturan registrerades, men underlaget kunde inte kopplas till verifikationen.',
  message_en: 'The invoice was registered, but the document could not be linked to the voucher.',
} as const

/** The statuses of an original invoice that may no longer book its purchase. */
const UNDERLAG_RELEASING_STATUSES: ReadonlySet<string> = new Set(['credited', 'reversed'])

/**
 * The status reading alone: an original resting at credited or reversed.
 * Pure, for a first filter; what decides is releasedAmong, which also asks
 * whether a credit still stands.
 */
export function releasesItsUnderlag(invoice: { status: string | null; is_credit_note?: boolean | null }): boolean {
  return invoice.is_credit_note !== true && UNDERLAG_RELEASING_STATUSES.has(invoice.status ?? '')
}

/** A list read as rows, whatever shape an answer took (a list, one row, nothing). */
function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  return data ? [data as T] : []
}

interface InvoiceStateRow {
  id: string
  status: string | null
  is_credit_note: boolean | null
  registration_journal_entry_id?: string | null
}

const INVOICE_STATE_COLUMNS = 'id, status, is_credit_note, registration_journal_entry_id'

/**
 * Which of `invoices` no longer book their purchase, read now: a reversed
 * original, and a credited one whose credit still stands, that is a live
 * credit note whose verifikat is posted, or that needed none because the
 * original never reached the books. A kreditfaktura's verifikat reversed by
 * hand leaves both rows at 'credited' while the registration books the
 * purchase again: that original holds its underlag. Throws on a failed read.
 */
async function releasedAmong(supabase: SupabaseClient, companyId: string, invoices: InvoiceStateRow[]): Promise<Set<string>> {
  const released = new Set<string>()
  const credited = new Map<string, InvoiceStateRow>()
  for (const invoice of invoices) {
    if (!releasesItsUnderlag(invoice)) continue
    if (invoice.status === 'credited') credited.set(invoice.id, invoice)
    else released.add(invoice.id)
  }
  if (credited.size === 0) return released

  const { data: notes, error: notesError } = await supabase
    .from('supplier_invoices')
    .select('credited_invoice_id, registration_journal_entry_id')
    .eq('company_id', companyId)
    .eq('is_credit_note', true)
    .neq('status', 'reversed')
    .in('credited_invoice_id', [...credited.keys()])
  if (notesError) throw dbError(notesError, 'released underlag: credit note lookup failed')
  const creditNotes = rowsOf<{ credited_invoice_id: string; registration_journal_entry_id: string | null }>(notes)

  const entryIds = [...new Set(creditNotes.map((note) => note.registration_journal_entry_id).filter((id): id is string => !!id))]
  const posted = new Set<string>()
  if (entryIds.length > 0) {
    const { data: entries, error: entriesError } = await supabase
      .from('journal_entries')
      .select('id, status')
      .eq('company_id', companyId)
      .in('id', entryIds)
    if (entriesError) throw dbError(entriesError, 'released underlag: credit verifikat lookup failed')
    for (const entry of rowsOf<{ id: string; status: string }>(entries)) if (entry.status === 'posted') posted.add(entry.id)
  }
  for (const note of creditNotes) {
    const original = credited.get(note.credited_invoice_id)
    if (!original) continue
    const stands = note.registration_journal_entry_id
      ? posted.has(note.registration_journal_entry_id)
      : !original.registration_journal_entry_id
    if (stands) released.add(original.id)
  }
  return released
}

/**
 * The verifikat among `entryIds` that no longer book the purchase of the
 * underlag they hold: the registration or payment verifikat of an invoice
 * that released it, or the kreditfaktura's verifikat of one. Every other
 * verifikat, spent or live, keeps holding its document as it always did.
 * Throws on a failed read.
 */
async function releasedEntries(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
  /** An invoice whose own verifikat never count as holding: the one asking. */
  except: string | null = null,
): Promise<Set<string>> {
  if (entryIds.length === 0) return new Set()
  const columns = `${INVOICE_STATE_COLUMNS}, credited_invoice_id, payment_journal_entry_id`
  const [byRegistration, byPayment] = await Promise.all([
    supabase.from('supplier_invoices').select(columns).eq('company_id', companyId).in('registration_journal_entry_id', entryIds),
    supabase.from('supplier_invoices').select(columns).eq('company_id', companyId).in('payment_journal_entry_id', entryIds),
  ])
  if (byRegistration.error) throw dbError(byRegistration.error, 'released underlag: holder lookup failed')
  if (byPayment.error) throw dbError(byPayment.error, 'released underlag: holder lookup failed')
  type Owner = InvoiceStateRow & { credited_invoice_id: string | null; payment_journal_entry_id: string | null }
  const owners = [...rowsOf<Owner>(byRegistration.data), ...rowsOf<Owner>(byPayment.data)]

  // The originals to judge: the owners themselves, and the originals of the credit notes among them.
  const originals = new Map<string, InvoiceStateRow>()
  for (const owner of owners) if (!owner.is_credit_note) originals.set(owner.id, owner)
  const missing = [
    ...new Set(owners.filter((o) => o.is_credit_note && o.credited_invoice_id && !originals.has(o.credited_invoice_id)).map((o) => o.credited_invoice_id as string)),
  ]
  if (missing.length > 0) {
    const { data, error } = await supabase.from('supplier_invoices').select(INVOICE_STATE_COLUMNS).eq('company_id', companyId).in('id', missing)
    if (error) throw dbError(error, 'released underlag: original lookup failed')
    for (const row of rowsOf<InvoiceStateRow>(data)) originals.set(row.id, row)
  }
  const released = await releasedAmong(supabase, companyId, [...originals.values()])

  const ownerIsReleased = (owner: Owner) => {
    const original = owner.is_credit_note ? owner.credited_invoice_id : owner.id
    return !!original && (original === except || released.has(original))
  }
  const dead = new Set<string>()
  for (const entryId of entryIds) {
    const own = owners.filter((o) => o.registration_journal_entry_id === entryId || o.payment_journal_entry_id === entryId)
    if (own.length > 0 && own.every(ownerIsReleased)) dead.add(entryId)
  }
  return dead
}

/** What holds an underlag now: a live invoice, or a posted verifikat that books a purchase with it. */
export type UnderlagHolder = { supplier_invoice_id: string } | { journal_entry_id: string }

/**
 * What books the underlag now, the invoice `except` left out: an original
 * invoice that has not released it, naming the document or a byte-identical
 * copy (the same bytes, which is what a copy is), or a posted verifikat
 * holding either that is not the own verifikat of an invoice that released
 * it. One read each on the invoices and the documents by the document's hash,
 * so no copy is missed however many there are. Null when nothing does.
 * Throws on a failed read.
 */
async function liveHolderOf(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  except: string | null,
): Promise<UnderlagHolder | null> {
  const { data: source, error: sourceError } = await supabase
    .from('document_attachments')
    .select('id, sha256_hash')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (sourceError) throw dbError(sourceError, 'released underlag: document lookup failed')
  const hash = (source as { sha256_hash?: string | null } | null)?.sha256_hash ?? null

  let invoiceQuery = supabase
    .from('supplier_invoices')
    .select(`${INVOICE_STATE_COLUMNS}, document:document_attachments!supplier_invoices_document_id_fkey!inner(sha256_hash)`)
    .eq('company_id', companyId)
    .eq('is_credit_note', false)
  invoiceQuery = hash ? invoiceQuery.eq('document.sha256_hash', hash) : invoiceQuery.eq('document_id', documentId)
  if (except) invoiceQuery = invoiceQuery.neq('id', except)
  const { data: invoices, error: invoicesError } = await invoiceQuery
  if (invoicesError) throw dbError(invoicesError, 'released underlag: registration lookup failed')
  const users = rowsOf<InvoiceStateRow>(invoices)
  const released = await releasedAmong(supabase, companyId, users)
  const liveInvoice = users.find((invoice) => !released.has(invoice.id))
  if (liveInvoice) return { supplier_invoice_id: liveInvoice.id }

  let documentQuery = supabase
    .from('document_attachments')
    .select('journal_entry_id, entry:journal_entries!document_attachments_journal_entry_id_fkey!inner(status)')
    .eq('company_id', companyId)
    .eq('entry.status', 'posted')
  documentQuery = hash ? documentQuery.eq('sha256_hash', hash) : documentQuery.eq('id', documentId)
  const { data: held, error: heldError } = await documentQuery
  if (heldError) throw dbError(heldError, 'released underlag: verifikat lookup failed')
  const entryIds = [
    ...new Set(rowsOf<{ journal_entry_id: string | null }>(held).map((row) => row.journal_entry_id).filter((id): id is string => !!id)),
  ]
  const dead = await releasedEntries(supabase, companyId, entryIds, except)
  const liveEntry = entryIds.find((id) => !dead.has(id))
  return liveEntry ? { journal_entry_id: liveEntry } : null
}

/** What a registration door may take over from a released item. */
export interface UnderlagRelease {
  /** The invoice the item's pointer still names, whose credit stands (or reversed): the new registration takes the pointer over. */
  supplier_invoice_id: string | null
  /** The item's document, when the verifikat it sits on is the own verifikat of such an invoice: the new registration gets a copy. */
  copy_from_document_id: string | null
}

/**
 * An inbox item as the doors that register it read it, `row` read with
 * INBOX_ITEM_DOCUMENT_HOLD: withDocumentHold's reading, with a pointer at an
 * invoice that released its underlag, and a document on that invoice's own
 * verifikat, holding nothing. Only while nothing else books the underlag:
 * registered or booked again already, the item answers as converted to that
 * invoice, or as booked on that verifikat. Only these doors read it: every
 * list and count keeps the plain reading, so the item stays handled there.
 * Throws on a failed read, so a door fails closed.
 */
export async function releasedForRegistration<
  Row extends DocumentHoldRow & { created_supplier_invoice_id?: string | null; document_id?: string | null },
>(
  supabase: SupabaseClient,
  companyId: string,
  row: Row,
): Promise<{ item: ReturnType<typeof withDocumentHold<Row>>; release: UnderlagRelease }> {
  const release: UnderlagRelease = { supplier_invoice_id: null, copy_from_document_id: null }

  const pointer = row.created_supplier_invoice_id ?? null
  if (pointer) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select(INVOICE_STATE_COLUMNS)
      .eq('id', pointer)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw dbError(error, 'released underlag: invoice lookup failed')
    if (data && (await releasedAmong(supabase, companyId, [data as InvoiceStateRow])).has(pointer)) release.supplier_invoice_id = pointer
  }

  const hold = documentHoldOf(row)
  if (row.document_id && hold.journal_entry_id && (await releasedEntries(supabase, companyId, [hold.journal_entry_id])).size > 0) {
    release.copy_from_document_id = row.document_id
  }

  const held = withDocumentHold(row)
  if (!release.supplier_invoice_id && !release.copy_from_document_id) return { item: held, release }

  const holder = row.document_id ? await liveHolderOf(supabase, companyId, row.document_id, null) : null
  if (holder) {
    return {
      item:
        'supplier_invoice_id' in holder
          ? { ...held, created_supplier_invoice_id: holder.supplier_invoice_id }
          : { ...held, document_journal_entry_id: holder.journal_entry_id },
      release: { supplier_invoice_id: null, copy_from_document_id: null },
    }
  }
  return {
    item: {
      ...held,
      ...(release.supplier_invoice_id ? { created_supplier_invoice_id: null } : {}),
      document_journal_entry_id: release.copy_from_document_id ? null : held.document_journal_entry_id,
    },
    release,
  }
}

/** Whether a document can be the underlag of a new registration, and how. */
export type DocumentForRegistration =
  /** Nothing holds it: the registration takes the document itself. `copy`: it sits on the own verifikat of an invoice that released it, and the registration gets a copy. */
  | { ok: true; copy: boolean }
  /** Not the company's, or on a verifikat that still books a purchase. */
  | { ok: false; reason: 'document_unavailable' }
  /** A supplier invoice that still holds it uses it. */
  | { ok: false; reason: 'document_already_used'; supplier_invoice_id: string }

/**
 * The checks a registration from a named document runs (POST
 * /supplier-invoices with document_id). A document on any verifikat is
 * refused as before, unless that verifikat is the own verifikat of an invoice
 * that released it. Throws on a failed read.
 */
export async function documentForRegistration(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
): Promise<DocumentForRegistration> {
  const { data: document, error: documentError } = await supabase
    .from('document_attachments')
    .select('id, journal_entry_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  // A malformed id finds nothing; any other failure is the database's, never an unavailable document.
  if (documentError && documentError.code !== '22P02') throw dbError(documentError, 'released underlag: document lookup failed')
  if (!document) return { ok: false, reason: 'document_unavailable' }
  const holderId = (document as { journal_entry_id: string | null }).journal_entry_id
  const copy = !!holderId
  if (holderId && (await releasedEntries(supabase, companyId, [holderId])).size === 0) {
    return { ok: false, reason: 'document_unavailable' }
  }

  const { data: users, error: usersError } = await supabase
    .from('supplier_invoices')
    .select(INVOICE_STATE_COLUMNS)
    .eq('company_id', companyId)
    .eq('document_id', documentId)
  if (usersError) throw dbError(usersError, 'released underlag: document usage lookup failed')
  const rows = rowsOf<InvoiceStateRow>(users)
  const released = await releasedAmong(supabase, companyId, rows)
  const live = rows.find((invoice) => !released.has(invoice.id))
  if (live) return { ok: false, reason: 'document_already_used', supplier_invoice_id: live.id }
  // Released: unless something books it again already, on a copy of it.
  if (copy || rows.length > 0) {
    const holder = await liveHolderOf(supabase, companyId, documentId, null)
    if (holder && 'supplier_invoice_id' in holder) {
      return { ok: false, reason: 'document_already_used', supplier_invoice_id: holder.supplier_invoice_id }
    }
    if (holder) return { ok: false, reason: 'document_unavailable' }
  }
  return { ok: true, copy }
}

/**
 * Whether the invoice's underlag can be registered again now: it released it
 * (releasedAmong). The detail page's hint; the doors ask for themselves.
 */
export async function releasesItsUnderlagNow(
  supabase: SupabaseClient,
  companyId: string,
  invoice: InvoiceStateRow,
): Promise<boolean> {
  if (!releasesItsUnderlag(invoice)) return false
  return (await releasedAmong(supabase, companyId, [invoice])).has(invoice.id)
}

/**
 * What books a credited invoice's underlag again: a live invoice registered
 * from the document or a byte-identical copy, or a posted verifikat holding
 * either; null when nothing does. Undoing the credit would bring the invoice
 * back beside it: the purchase booked twice. Throws on a failed read.
 */
export async function registeredAgainAs(
  supabase: SupabaseClient,
  companyId: string,
  invoice: { id: string; document_id?: string | null },
): Promise<UnderlagHolder | null> {
  if (!invoice.document_id) return null
  return liveHolderOf(supabase, companyId, invoice.document_id, invoice.id)
}

/**
 * Give a new registration its copy of a released underlag: on its
 * registration verifikat when it posted one now, else on no verifikat yet,
 * for the invoice's booking to anchor (a deferring company, kontantmetoden).
 * The invoice then names the copy instead of the original. Returns the
 * copy's id. Throws when no copy could be made; the caller warns, since the
 * registration stands.
 */
export async function copyReleasedUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  target: { sourceDocumentId: string; supplierInvoiceId: string; journalEntryId: string | null },
): Promise<string> {
  let copyId: string
  if (target.journalEntryId) {
    const copied = await linkDocumentCopyToVoucher(
      supabase,
      companyId,
      userId,
      { document_id: target.sourceDocumentId, journal_entry_id: target.journalEntryId },
      // The verifikat was booked from this document.
      { linkBasis: linkBasisColumns('user_created') },
    )
    if (!copied.ok) throw new Error(`released underlag: the copy was refused (${copied.code})`)
    copyId = copied.document.id
  } else {
    const copy = await archiveDocumentCopy(
      supabase,
      companyId,
      userId,
      target.sourceDocumentId,
      `supplier-invoice:${target.supplierInvoiceId}`,
    )
    if (!copy) throw new Error('released underlag: the source document is gone')
    copyId = copy.id
  }

  const { error } = await supabase
    .from('supplier_invoices')
    .update({ document_id: copyId })
    .eq('id', target.supplierInvoiceId)
    .eq('company_id', companyId)
    .eq('document_id', target.sourceDocumentId)
  if (error) throw dbError(error, 'released underlag: the invoice could not name its copy')
  return copyId
}
