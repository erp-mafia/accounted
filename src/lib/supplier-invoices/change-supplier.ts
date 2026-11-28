/**
 * Byt leverantör: an invoice registered on the wrong supplier moves to the
 * right one while nothing has been decided on it yet. One implementation
 * behind the dashboard route (POST /api/supplier-invoices/[id]/change-supplier),
 * the v1 operation and the MCP tool (supplier-invoices.change-supplier,
 * lib/operations/supplier-invoice-actions.ts), so every door applies the
 * same rules:
 *
 *   - what the row says (change-supplier-rules.ts): never a credit note or a
 *     självfaktura; only an unsettled invoice with nothing paid, that nobody
 *     has attested and nobody has typed into the bank;
 *   - and what only reads tell: no payment row, no approval in the attest
 *     round (a first approval of two counts), no open payment file or bank
 *     payment (loadOpenPaymentInstructions). Each of those was made out to
 *     the old supplier;
 *   - the new supplier is the company's, not archived, of the same kind
 *     (svensk, EU, utanför EU): the kind decides how the moms is booked, so
 *     another kind would change the verifikat's lines, which is a credit and
 *     a new registration, never this; and it holds no live invoice under the
 *     same number (idx_supplier_invoices_company_supplier_number);
 *   - a posted registration verifikat names the supplier in its text, the
 *     motpart a verifikation states (BFL 5 kap 7 §). The text is corrected
 *     inside the same verifikat through the logged rättelse
 *     (correct_entry_metadata, BFL 5 kap 5 § and 9 §: who and when, the old
 *     text kept), which only an open, unlocked period takes. Past a lock, a
 *     close or the lock date the change is refused, and the way is the one
 *     there was: credit the invoice and register its underlag again. The
 *     lines keep their texts; the amounts and accounts do not change;
 *   - the invoice row is written first, a compare-and-set on what the checks
 *     read, then the verifikat; a refused rättelse puts the old supplier
 *     back, so the invoice and its verifikat never name two suppliers;
 *   - the payee check needs no write: what holds a payment back is derived
 *     from the invoice, the card and the decisions every time it is read
 *     (lib/payments/payee-alerts.ts), so the account the invoice states is
 *     compared with the new supplier's card from now on.
 *
 * Everything else on the invoice stays as registered: dates, amounts, lines,
 * dimensions, the stated payee and the "dras automatiskt" mark.
 *
 * A dry run reads, checks and replays the rättelse's rules (the MCP staging
 * preview); it writes nothing.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { buildSupplierDescription } from '@/lib/bookkeeping/supplier-invoice-description'
import { correctJournalEntryMetadata } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { readDuplicateNumberHolder } from './duplicate-lookup'
import { loadOpenPaymentInstructions } from './lifecycle-stages'
import { currentRound, type AttestationRecord } from './attest-policy'
import { SUPPLIER_CHANGE_REFUSAL_CODES, supplierChangeRowRefusal } from './change-supplier-rules'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface ChangeSupplierResult {
  supplier_invoice_id: string
  supplier_id: string
  previous_supplier_id: string
  /** False when the invoice was on that supplier already. */
  changed: boolean
  /** The registration verifikat whose text was corrected, when one was. */
  corrected_journal_entry_id: string | null
}

const INVOICE_COLUMNS =
  'id, supplier_id, status, is_credit_note, is_self_billed, approved_at, paid_amount, remaining_amount, due_date, bank_entered_at, supplier_invoice_number, arrival_number, registration_journal_entry_id'

interface InvoiceRow {
  id: string
  supplier_id: string
  status: string
  is_credit_note: boolean | null
  is_self_billed: boolean | null
  approved_at: string | null
  paid_amount: number | string | null
  remaining_amount: number | string | null
  due_date: string | null
  bank_entered_at: string | null
  supplier_invoice_number: string | null
  arrival_number: number | null
  registration_journal_entry_id: string | null
}

interface SupplierRow {
  id: string
  name: string
  supplier_type: string | null
  archived_at: string | null
}

/** How the moms of a supplier's invoices is booked: a card without a kind reads as Swedish, as the line builders read it. */
const kindOf = (supplier: SupplierRow) => supplier.supplier_type ?? 'swedish_business'

/**
 * The verifikat text with the new supplier: the text the registration wrote
 * ("Leverantörsfaktura <nr>, <leverantör> (ankomstnr <n>)", whatever name
 * the card had then) gets the new name in the supplier's place; a text
 * corrected by hand gets the old name replaced where it stands as a name of
 * its own, never inside a longer word or inside the new name ("Acme" in
 * "Acme Nordic"). Null when the text does not name the old supplier: there is
 * nothing to correct.
 */
export function verifikatTextWithSupplier(
  current: string,
  invoice: { supplier_invoice_number: string | null; arrival_number: number | null },
  oldName: string,
  newName: string,
): string | null {
  const suffix = `(ankomstnr ${invoice.arrival_number})`
  const head = buildSupplierDescription('Leverantörsfaktura', invoice.supplier_invoice_number)
  const named = current.slice(head.length + 2, current.length - suffix.length - 1)
  const corrected =
    current.startsWith(`${head}, `) && current.endsWith(` ${suffix}`) && named.trim() !== ''
      ? buildSupplierDescription('Leverantörsfaktura', invoice.supplier_invoice_number, newName, suffix)
      : oldName
        ? nameReplaced(current, oldName, newName)
        : null
  return corrected === current ? null : corrected
}

function nameReplaced(text: string, oldName: string, newName: string): string {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const standing = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu')
  const replace = (part: string) => part.replace(standing, () => newName)
  // Where the new name holds the old one, the text naming the new one already stays as it is.
  return newName.includes(oldName) ? text.split(newName).map(replace).join(newName) : replace(text)
}

async function readSupplier(ctx: OperationContext, supplierId: string): Promise<SupplierRow | null> {
  const { data } = await ctx.supabase
    .from('suppliers')
    .select('id, name, supplier_type, archived_at')
    .eq('id', supplierId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  return (data as SupplierRow | null) ?? null
}

/**
 * An approval in the current attest round, given before `before` when it is
 * set: an approval is given for the supplier the invoice had then, and one of
 * two approvals does not set approved_at. Null when there is none.
 */
async function approvalRefusal(ctx: OperationContext, invoiceId: string, before?: string): Promise<Failure | null> {
  const { data, error } = await ctx.supabase
    .from('supplier_invoice_attestations')
    .select('user_id, decision, decided_at')
    .eq('company_id', ctx.companyId)
    .eq('supplier_invoice_id', invoiceId)
  if (error) return { ok: false, code: 'UNKNOWN_ERROR', error }
  const given = currentRound((data ?? []) as AttestationRecord[]).some(
    (row) => row.decision === 'approved' && (!before || Date.parse(row.decided_at) < Date.parse(before)),
  )
  return given ? { ok: false, code: SUPPLIER_CHANGE_REFUSAL_CODES.attested, details: { reason: 'approval_in_round' } } : null
}

/**
 * The checks that need reads: a payment row, an approval in the attest
 * round, an open payment file or bank payment. Null when none applies.
 */
async function readRefusal(ctx: OperationContext, invoice: InvoiceRow): Promise<Failure | null> {
  const { supabase, companyId } = ctx
  const [payments, approval] = await Promise.all([
    supabase.from('supplier_invoice_payments').select('id').eq('company_id', companyId).eq('supplier_invoice_id', invoice.id).limit(1),
    approvalRefusal(ctx, invoice.id),
  ])
  // Fail closed: an unread payment or attest is never read as none.
  if (payments.error) return { ok: false, code: 'UNKNOWN_ERROR', error: payments.error }
  if ((payments.data ?? []).length > 0) return { ok: false, code: SUPPLIER_CHANGE_REFUSAL_CODES.not_unpaid, details: { reason: 'payments' } }
  if (approval) return approval

  let instruction
  try {
    instruction = (await loadOpenPaymentInstructions(supabase, companyId, [invoice.id])).get(invoice.id)
  } catch (err) {
    return { ok: false, code: 'UNKNOWN_ERROR', error: err }
  }
  if (instruction?.payment_order || instruction?.batch) {
    return {
      ok: false,
      code: SUPPLIER_CHANGE_REFUSAL_CODES.payment_under_way,
      details: instruction.payment_order
        ? { reason: 'bank_payment', payment_order_id: instruction.payment_order.id }
        : { reason: 'payment_file', batch_id: instruction.batch!.id },
    }
  }
  return null
}

export async function changeSupplierInvoiceSupplier(
  ctx: OperationContext,
  supplierInvoiceId: string,
  supplierId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ChangeSupplierResult>> {
  const { supabase, companyId, log } = ctx

  const { data: stored, error: readError } = await supabase
    .from('supplier_invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (readError) return { ok: false, code: 'UNKNOWN_ERROR', error: readError }
  if (!stored) return { ok: false, code: 'SI_NOT_FOUND' }
  const invoice = stored as unknown as InvoiceRow
  const unchanged: ChangeSupplierResult = {
    supplier_invoice_id: invoice.id,
    supplier_id: invoice.supplier_id,
    previous_supplier_id: invoice.supplier_id,
    changed: false,
    corrected_journal_entry_id: null,
  }

  // Idempotent: the invoice is on that supplier already.
  if (invoice.supplier_id === supplierId) {
    if (options.dryRun) {
      return { ok: true, dryRun: true, preview: { ...unchanged, will: 'change nothing: the invoice is on that supplier already' } }
    }
    return { ok: true, data: unchanged }
  }

  const rowRefusal = supplierChangeRowRefusal(invoice)
  if (rowRefusal) {
    return { ok: false, code: SUPPLIER_CHANGE_REFUSAL_CODES[rowRefusal], details: { currentStatus: invoice.status } }
  }
  const refused = await readRefusal(ctx, invoice)
  if (refused) return refused

  const [from, to] = await Promise.all([readSupplier(ctx, invoice.supplier_id), readSupplier(ctx, supplierId)])
  if (!to || to.archived_at) return { ok: false, code: 'SUPPLIER_NOT_FOUND', details: { supplier_id: supplierId } }
  if (!from) return { ok: false, code: 'SUPPLIER_NOT_FOUND', details: { supplier_id: invoice.supplier_id } }
  if (kindOf(from) !== kindOf(to)) {
    return { ok: false, code: 'SI_CHANGE_SUPPLIER_OTHER_KIND', details: { from_kind: kindOf(from), to_kind: kindOf(to) } }
  }
  // A credited or reversed invoice under the number holds no slot in the index.
  const holder = await readDuplicateNumberHolder(supabase, companyId, to.id, invoice.supplier_invoice_number)
  if (holder && holder.status !== 'credited' && holder.status !== 'reversed') {
    return { ok: false, code: 'SI_CHANGE_SUPPLIER_DUPLICATE_NUMBER', details: { existing: holder } }
  }

  // The text the registration verifikat gets, and whether its period takes the rättelse.
  const entryId = invoice.registration_journal_entry_id
  let newText: string | null = null
  if (entryId) {
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, description')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (entryError) return { ok: false, code: 'UNKNOWN_ERROR', error: entryError }
    if (!entry) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND', details: { journal_entry_id: entryId } }
    newText = verifikatTextWithSupplier((entry.description as string | null) ?? '', invoice, from.name, to.name)
    if (newText) {
      const preview = await correctJournalEntryMetadata(ctx, entryId, { description: newText }, { dryRun: true })
      if (!preview.ok) return lockedOrRefused(preview)
    }
  }

  const move = { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name } }
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: invoice.id,
        arrival_number: invoice.arrival_number,
        supplier_invoice_number: invoice.supplier_invoice_number,
        ...move,
        changed: true,
        corrects_verifikat: newText !== null,
        journal_entry_id: entryId,
        ...(newText ? { new_verifikat_text: newText } : {}),
        will: newText
          ? 'move the invoice to the new supplier and correct the registration verifikat\'s text inside the same verifikat (inline rättelse, logged with who and when); no amount, account or line changes'
          : 'move the invoice to the new supplier; no verifikat names the supplier, so nothing in the books changes',
      },
    }
  }

  // The checks read a row a moment ago: the write holds only while the
  // invoice is still exactly that (no payment, attest, tick or booking since).
  const guarded = supabase
    .from('supplier_invoices')
    .update({ supplier_id: to.id })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
    .eq('supplier_id', invoice.supplier_id)
    .eq('status', invoice.status)
    .is('approved_at', null)
    .is('bank_entered_at', null)
  const { data: moved, error: moveError } = await (entryId
    ? guarded.eq('registration_journal_entry_id', entryId)
    : guarded.is('registration_journal_entry_id', null)
  ).select('id, updated_at')
  if (moveError) {
    // The number is unique per supplier among live invoices: one registered on the new supplier in between.
    if ((moveError as { code?: string }).code === '23505') {
      return {
        ok: false,
        code: 'SI_CHANGE_SUPPLIER_DUPLICATE_NUMBER',
        details: { existing: await readDuplicateNumberHolder(supabase, companyId, to.id, invoice.supplier_invoice_number) },
      }
    }
    log.error('supplier invoice supplier change failed', moveError as unknown as Error, { supplierInvoiceId })
    return { ok: false, code: 'UNKNOWN_ERROR', error: moveError }
  }
  if (!moved || moved.length === 0) {
    return { ok: false, code: 'SI_CHANGE_SUPPLIER_CONFLICT', details: { reason: 'race' } }
  }

  const moveBack = async (why: string) => {
    const { error: revertError } = await supabase
      .from('supplier_invoices')
      .update({ supplier_id: invoice.supplier_id })
      .eq('id', invoice.id)
      .eq('company_id', companyId)
      .eq('supplier_id', to.id)
    if (revertError) {
      log.error(`supplier change: ${why} left the invoice on the new supplier`, revertError as unknown as Error, {
        supplierInvoiceId,
        journalEntryId: entryId,
      })
    }
  }

  // One of two approvals sets no approved_at, so the guard above cannot see
  // it: one given while the invoice moved was given for the old supplier.
  const approvedMeanwhile = await approvalRefusal(ctx, invoice.id, (moved as { updated_at?: string }[])[0]?.updated_at)
  if (approvedMeanwhile) {
    await moveBack('an approval given meanwhile')
    return approvedMeanwhile
  }

  const done: ChangeSupplierResult = {
    supplier_invoice_id: invoice.id,
    supplier_id: to.id,
    previous_supplier_id: invoice.supplier_id,
    changed: true,
    corrected_journal_entry_id: null,
  }
  if (!entryId || !newText) return { ok: true, data: done }

  const corrected = await correctJournalEntryMetadata(ctx, entryId, { description: newText })
  if (!corrected.ok) {
    // The verifikat still names the old supplier: so does the invoice again.
    await moveBack('the refused rättelse')
    return lockedOrRefused(corrected)
  }
  return { ok: true, data: { ...done, corrected_journal_entry_id: entryId } }
}

/**
 * A rättelse its period refuses: past a lock the supplier is changed the way
 * it always was, by a credit and a new registration of the underlag. Every
 * other refusal is the rättelse's own.
 */
function lockedOrRefused(failure: Failure): Failure {
  if (failure.code !== 'JOURNAL_RATTELSE_PERIOD_LOCKED') return failure
  return { ok: false, code: 'SI_CHANGE_SUPPLIER_PERIOD_LOCKED', details: { ...failure.details } }
}
