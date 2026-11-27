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
import {
  SPENT_ENTRY_STATUSES,
  documentHoldOf,
  withDocumentHold,
  type DocumentHoldRow,
} from '@/lib/documents/inbox-item-state'
import { archiveDocumentCopy, linkDocumentCopyToVoucher } from '@/lib/documents/link-document'
import { linkBasisColumns } from '@/lib/links/stamp'

/** The statuses of an original invoice that no longer books its purchase. */
const UNDERLAG_RELEASING_STATUSES: ReadonlySet<string> = new Set(['credited', 'reversed'])

/** True when the invoice no longer holds the underlag it was registered from. */
export function releasesItsUnderlag(invoice: { status: string | null; is_credit_note?: boolean | null }): boolean {
  return invoice.is_credit_note !== true && UNDERLAG_RELEASING_STATUSES.has(invoice.status ?? '')
}

interface InvoiceStateRow {
  id: string
  status: string | null
  is_credit_note: boolean | null
}

/**
 * True when the verifikat a document sits on no longer books the purchase:
 * spent (reversed or cancelled), or the registration verifikat of invoices
 * that all released their underlag. Throws on a failed read.
 */
async function holderReleasesDocument(
  supabase: SupabaseClient,
  companyId: string,
  holder: { journal_entry_id: string; status: string | null },
): Promise<boolean> {
  if (holder.status && SPENT_ENTRY_STATUSES.has(holder.status)) return true
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select('id, status, is_credit_note')
    .eq('company_id', companyId)
    .eq('registration_journal_entry_id', holder.journal_entry_id)
  if (error) throw dbError(error, 'released underlag: holder lookup failed')
  const rows = (data ?? []) as InvoiceStateRow[]
  return rows.length > 0 && rows.every(releasesItsUnderlag)
}

/** What a registration door may take over from a released item. */
export interface UnderlagRelease {
  /** The invoice the item's pointer still names, credited or reversed: the new registration takes the pointer over. */
  supplier_invoice_id: string | null
  /** The item's document, when the verifikat it sits on no longer books the purchase: the new registration gets a copy. */
  copy_from_document_id: string | null
}

/**
 * An inbox item as the doors that register it read it, `row` read with
 * INBOX_ITEM_DOCUMENT_HOLD: withDocumentHold's reading, with a pointer at an
 * invoice that released its underlag and a document on a verifikat that no
 * longer books the purchase holding nothing. Only these doors read it: every
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
      .select('id, status, is_credit_note')
      .eq('id', pointer)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw dbError(error, 'released underlag: invoice lookup failed')
    if (data && releasesItsUnderlag(data as InvoiceStateRow)) release.supplier_invoice_id = pointer
  }

  const hold = documentHoldOf(row)
  if (row.document_id && hold.journal_entry_id) {
    if (await holderReleasesDocument(supabase, companyId, { journal_entry_id: hold.journal_entry_id, status: hold.status })) {
      release.copy_from_document_id = row.document_id
    }
  }

  const held = withDocumentHold(row)
  if (!release.supplier_invoice_id && !release.copy_from_document_id) return { item: held, release }

  // Registered again already, through the document or a copy of it (POST
  // /supplier-invoices takes a document, not the item): that invoice holds
  // the underlag now, and the item answers as converted to it.
  const live = row.document_id ? await liveRegistrationOf(supabase, companyId, row.document_id, null) : null
  if (live) {
    return {
      item: { ...held, created_supplier_invoice_id: live },
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
  /** Nothing holds it: the registration takes the document itself. `copy`: it sits on a verifikat that no longer books the purchase, and the registration gets a copy. */
  | { ok: true; copy: boolean }
  /** Not the company's, or on a verifikat that still books a purchase. */
  | { ok: false; reason: 'document_unavailable' }
  /** A supplier invoice that still holds it uses it. */
  | { ok: false; reason: 'document_already_used'; supplier_invoice_id: string }

/**
 * The checks a registration from a named document runs (POST
 * /supplier-invoices with document_id). Throws on a failed read.
 */
export async function documentForRegistration(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
): Promise<DocumentForRegistration> {
  const { data: document, error: documentError } = await supabase
    .from('document_attachments')
    .select('id, journal_entry_id, entry:journal_entries!document_attachments_journal_entry_id_fkey(status)')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (documentError || !document) return { ok: false, reason: 'document_unavailable' }
  const hold = documentHoldOf({ document_hold: document as NonNullable<DocumentHoldRow['document_hold']> })
  let copy = false
  if (hold.journal_entry_id) {
    if (!(await holderReleasesDocument(supabase, companyId, { journal_entry_id: hold.journal_entry_id, status: hold.status }))) {
      return { ok: false, reason: 'document_unavailable' }
    }
    copy = true
  }

  const { data: users, error: usersError } = await supabase
    .from('supplier_invoices')
    .select('id, status, is_credit_note')
    .eq('company_id', companyId)
    .eq('document_id', documentId)
  if (usersError) throw dbError(usersError, 'released underlag: document usage lookup failed')
  const rows = (users ?? []) as InvoiceStateRow[]
  const live = rows.find((invoice) => !releasesItsUnderlag(invoice))
  if (live) return { ok: false, reason: 'document_already_used', supplier_invoice_id: live.id }
  // Released: unless it was registered again already, on a copy of it.
  if (copy || rows.length > 0) {
    const again = await liveRegistrationOf(supabase, companyId, documentId, null)
    if (again) return { ok: false, reason: 'document_already_used', supplier_invoice_id: again }
  }
  return { ok: true, copy }
}

/**
 * The live invoice a credited invoice's underlag was registered again as,
 * through the document itself or a byte-identical copy of it; null when there
 * is none. Undoing the credit would bring the invoice back beside that one:
 * the purchase booked twice. Throws on a failed read.
 */
export async function registeredAgainAs(
  supabase: SupabaseClient,
  companyId: string,
  invoice: { id: string; document_id: string | null },
): Promise<string | null> {
  if (!invoice.document_id) return null
  return liveRegistrationOf(supabase, companyId, invoice.document_id, invoice.id)
}

/**
 * The invoice, other than `except`, that holds an underlag now: an original
 * that is not credited or reversed and names the document, or a copy of it
 * (the same bytes, which is what a copy is). Throws on a failed read.
 */
async function liveRegistrationOf(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  except: string | null,
): Promise<string | null> {
  const { data: source, error: sourceError } = await supabase
    .from('document_attachments')
    .select('id, sha256_hash')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (sourceError) throw dbError(sourceError, 'released underlag: document lookup failed')
  const hash = (source as { sha256_hash?: string | null } | null)?.sha256_hash ?? null
  let documentIds = [documentId]
  if (hash) {
    const { data: copies, error: copiesError } = await supabase
      .from('document_attachments')
      .select('id')
      .eq('company_id', companyId)
      .eq('sha256_hash', hash)
      .limit(50)
    if (copiesError) throw dbError(copiesError, 'released underlag: copy lookup failed')
    documentIds = [...new Set([documentId, ...((copies ?? []) as Array<{ id: string }>).map((row) => row.id)])]
  }

  let query = supabase
    .from('supplier_invoices')
    .select('id, status, is_credit_note')
    .eq('company_id', companyId)
    .eq('is_credit_note', false)
    .in('document_id', documentIds)
  if (except) query = query.neq('id', except)
  const { data: users, error: usersError } = await query
  if (usersError) throw dbError(usersError, 'released underlag: registration lookup failed')
  return ((users ?? []) as InvoiceStateRow[]).find((row) => !releasesItsUnderlag(row))?.id ?? null
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
