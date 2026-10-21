import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { recordRecoveredLoss } from '@/lib/customer-loss/recovered'
import { settleInvoicePayment, type SettleInvoicePaymentResult } from '@/lib/invoices/settle-invoice-payment'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { normalizeCollectedPaymentRow, type CollectedPaymentRow, type CollectedPaymentStatus } from './collected-payment-record'
import { normalizeConnectionRow, type CollectionConnectionRow } from './connection'
import { archivePaymentRecord, buildPaymentRecordModel, paymentRecordFilename, type PaymentRecordModel } from './payment-record'
import { linkDocumentOnce } from './underlag'

/**
 * Payments a debtor made to the collections provider instead of to the
 * company (build spec 4.2 C). The provider lists them on the case
 * (`collectedPayments`, its own payment list: never a payment the ledger
 * reported to it, those come back as `reportedPayments`), and each becomes
 * a payment of the invoice on the day the debtor paid:
 *
 *   settleInvoicePayment(invoice, capital paid, paid at, against the
 *   clearing account (default 1689), source 'collections', the provider's
 *   payment reference)
 *
 * so the receivable is cleared at the gross capital reduction (Dr 1689 /
 * Cr 1510 under faktureringsmetoden; revenue and VAT on the receipt date
 * under kontantmetoden, pro rata for a part payment). The payout later
 * clears 1689 (settlements.ts). Payment rows with source 'collections' are
 * never reported back to the provider (the forwarding triggers skip them)
 * and cannot be removed outside the rebook (block_delete_collected_payment).
 *
 * On an invoice written off as a konstaterad kundförlust the money is no
 * payment of the invoice (settleInvoicePayment refuses a written-off one): it
 * is återvunnen kundförlust (build spec 4.2 H), booked through
 * recordRecoveredLoss against the same clearing account (Dr 1689 / Cr 3950
 * net and Cr 26xx for the VAT reported again), with the payment record as the
 * decision's underlag, and the invoice stays written_off. Only by a person's
 * click: the automatic booking leaves it in needs_review (WRITTEN_OFF_RECOVERY).
 *
 * Booking is a person's click in the settlements view, or automatic when the
 * company turned on auto_book_collected_payments. Either way a refusal
 * (locked period, invoice already paid, another currency) leaves the row in
 * needs_review with the reason, never a workaround. This is an obligation
 * path (build spec rule 3): it runs whatever the start gates say.
 *
 * Every posting here waits for the accountant's sign-off (build spec 4.5
 * items 1, 2 and 8).
 */

const log = createLogger('collections/collected-payments')

/** How long one booking holds its row: far longer than a settlement call takes. */
export const COLLECTED_BOOKING_LEASE_MS = 2 * 60_000

export interface CollectedPaymentBookingDeps {
  /** Service-role client; every query filters on companyId. */
  db: SupabaseClient
  companyId: string
  now?: () => Date
  log?: Logger
  /** settleInvoicePayment, replaceable in tests. */
  settle?: typeof settleInvoicePayment
  /** recordRecoveredLoss, replaceable in tests. */
  recoverLoss?: typeof recordRecoveredLoss
  /** Renders and archives the payment record (the C voucher's underlag); answers the document id. */
  archiveRecord?: (input: { companyId: string; userId: string; model: PaymentRecordModel }) => Promise<string>
}

export type BookCollectedPaymentResult =
  | {
      ok: true
      journalEntryId: string | null
      /** The collections payment row; null when the payment was booked as a recovery (writeOffId). */
      invoicePaymentId: string | null
      /** The recovered kundförlust decision, on a written-off invoice. */
      writeOffId: string | null
      alreadyBooked: boolean
    }
  | { ok: false; outcome: 'needs_review'; reason: string }
  | { ok: false; outcome: 'not_found' | 'ignored' | 'busy' }

export async function loadCollectedPayment(db: SupabaseClient, companyId: string, id: string): Promise<CollectedPaymentRow | null> {
  const { data, error } = await db
    .from('collection_collected_payments')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`collection_collected_payments lookup failed: ${error.message}`)
  return data ? normalizeCollectedPaymentRow(data as Record<string, unknown>) : null
}

/** The collections payment row this provider payment already settled the invoice with, if any. */
async function findCollectionsPaymentRow(
  db: SupabaseClient,
  row: Pick<CollectedPaymentRow, 'company_id' | 'invoice_id' | 'provider_payment_ref'>,
): Promise<{ id: string; journal_entry_id: string | null } | null> {
  const { data, error } = await db
    .from('invoice_payments')
    .select('id, journal_entry_id')
    .eq('company_id', row.company_id)
    .eq('invoice_id', row.invoice_id)
    .eq('source', 'collections')
    .eq('external_ref', row.provider_payment_ref)
    .maybeSingle()
  if (error) throw new Error(`invoice_payments lookup failed: ${error.message}`)
  return (data as { id: string; journal_entry_id: string | null } | null) ?? null
}

/**
 * The recovered kundförlust decision this payment was already booked as: a
 * run that recovered the loss and died before recording it. The decision
 * names the payment record as its underlag, and its voucher still stands.
 */
async function findRecoveryOf(
  db: SupabaseClient,
  row: Pick<CollectedPaymentRow, 'company_id' | 'invoice_id' | 'payment_record_document_id'>,
): Promise<{ id: string; journal_entry_id: string } | null> {
  if (!row.payment_record_document_id) return null
  const { data, error } = await db
    .from('invoice_write_offs')
    .select('id, journal_entry_id')
    .eq('company_id', row.company_id)
    .eq('invoice_id', row.invoice_id)
    .eq('kind', 'recovered')
    .eq('evidence_document_id', row.payment_record_document_id)
  if (error) throw new Error(`invoice_write_offs lookup failed: ${error.message}`)
  for (const decision of (data ?? []) as { id: string; journal_entry_id: string | null }[]) {
    if (decision.journal_entry_id && (await voucherStatus(db, row.company_id, decision.journal_entry_id)) === 'posted') {
      return { id: decision.id, journal_entry_id: decision.journal_entry_id }
    }
  }
  return null
}

/** The status of a voucher of this company, null when there is none. */
async function voucherStatus(db: SupabaseClient, companyId: string, journalEntryId: string): Promise<string | null> {
  const { data, error } = await db
    .from('journal_entries')
    .select('status')
    .eq('company_id', companyId)
    .eq('id', journalEntryId)
    .maybeSingle()
  if (error) throw new Error(`journal_entries lookup failed: ${error.message}`)
  return (data as { status?: string | null } | null)?.status ?? null
}

/**
 * Remove the collections payment row a failed settlement left behind: when
 * settleInvoicePayment loses its race it cancels its fresh voucher
 * (cancel_orphaned_entry) and removes the row, and a row that outlived that
 * (written before 20261021120600, or a removal that failed) points at a
 * cancelled voucher on an invoice that never reached paid. The database lets
 * exactly that row go (block_delete_collected_payment); the payment is then
 * booked again.
 */
async function removeStrandedPaymentRow(db: SupabaseClient, companyId: string, paymentRowId: string): Promise<void> {
  const { error } = await db
    .from('invoice_payments')
    .delete()
    .eq('company_id', companyId)
    .eq('id', paymentRowId)
    .eq('source', 'collections')
  if (error) throw new Error(`invoice_payments delete failed: ${error.message}`)
}

async function loadCaseConnection(
  db: SupabaseClient,
  row: Pick<CollectedPaymentRow, 'company_id' | 'case_id'>,
): Promise<{ openedBy: string | null; caseNumber: string | null; connection: CollectionConnectionRow }> {
  const { data: caseRow, error: caseError } = await db
    .from('collection_cases')
    .select('connection_id, opened_by, provider_case_number, provider_case_ref')
    .eq('company_id', row.company_id)
    .eq('id', row.case_id)
    .maybeSingle()
  if (caseError) throw new Error(`collection_cases lookup failed: ${caseError.message}`)
  if (!caseRow) throw new Error(`collection case ${row.case_id} not found`)
  const {
    connection_id: connectionId,
    opened_by: openedBy,
    provider_case_number: caseNumber,
    provider_case_ref: caseRef,
  } = caseRow as { connection_id: string; opened_by: string | null; provider_case_number?: string | null; provider_case_ref?: string | null }
  const { data, error } = await db
    .from('collection_connections')
    .select('*')
    .eq('company_id', row.company_id)
    .eq('id', connectionId)
    .maybeSingle()
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  if (!data) throw new Error(`collections connection ${connectionId} not found`)
  return { openedBy, caseNumber: caseNumber ?? caseRef ?? null, connection: normalizeConnectionRow(data as Record<string, unknown>) }
}

/**
 * What booking a collected payment would do, read only: the payment, its
 * invoice number and the clearing account its voucher debits (the case's
 * connection, as the booking reads it). Null when the company has no such
 * payment.
 */
export async function previewCollectedPayment(
  db: SupabaseClient,
  companyId: string,
  id: string,
): Promise<{ row: CollectedPaymentRow; invoiceNumber: string | null; clearingAccount: string } | null> {
  const row = await loadCollectedPayment(db, companyId, id)
  if (!row) return null
  const { connection } = await loadCaseConnection(db, row)
  const { data, error } = await db.from('invoices').select('invoice_number').eq('company_id', companyId).eq('id', row.invoice_id).maybeSingle()
  if (error) throw new Error(`invoices lookup failed: ${error.message}`)
  return { row, invoiceNumber: (data as { invoice_number?: string | null } | null)?.invoice_number ?? null, clearingAccount: connection.clearing_account }
}

/** Who a booking is booked as when no person clicked: the person who handed the invoice over, else who set up the connection. */
export function automaticBookingUser(
  openedBy: string | null,
  connection: Pick<CollectionConnectionRow, 'user_id' | 'consented_by'>,
): string {
  return openedBy ?? connection.user_id ?? connection.consented_by
}

function failureReason(result: Extract<SettleInvoicePaymentResult, { ok: false }>): string {
  if (result.code === 'BOOKKEEPING_ERROR') {
    const error = result.error as { code?: unknown; message?: unknown } | null
    const code = typeof error?.code === 'string' ? error.code : null
    return (code ?? 'BOOKKEEPING_ERROR').slice(0, 200)
  }
  return result.code
}

interface RecordInvoice {
  invoice_number?: string | null
  currency?: string | null
  customer?: { name?: string | null } | null
}

interface RecordContext {
  invoice: RecordInvoice
  caseNumber: string | null
  connection: CollectionConnectionRow
  /** The user the booking runs as: the person who clicked, else automaticBookingUser. */
  userId: string
}

/** What a payment record needs when the booking itself did not load it (a recovery). */
async function loadRecordContext(db: SupabaseClient, row: CollectedPaymentRow, actor: { userId: string } | null): Promise<RecordContext> {
  const { openedBy, caseNumber, connection } = await loadCaseConnection(db, row)
  const { data, error } = await db
    .from('invoices')
    .select('invoice_number, currency, customer:customers(name)')
    .eq('company_id', row.company_id)
    .eq('id', row.invoice_id)
    .maybeSingle()
  if (error) throw new Error(`invoices lookup failed: ${error.message}`)
  return {
    invoice: (data as RecordInvoice | null) ?? {},
    caseNumber,
    connection,
    userId: actor?.userId ?? automaticBookingUser(openedBy, connection),
  }
}

/** A person's name for the record: full name, else e-mail. */
async function userDisplayName(db: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await db.from('profiles').select('full_name, email').eq('id', userId).maybeSingle()
  if (error) throw new Error(`profiles lookup failed: ${error.message}`)
  const profile = data as { full_name?: string | null; email?: string | null } | null
  return profile?.full_name?.trim() || profile?.email?.trim() || 'okänd användare'
}

/**
 * The C voucher a rebook reversed last and its storno, as the new payment
 * record names them ("C12, stornerad genom C13"), so the rättelse can be
 * followed from the new voucher's underlag too (BFL 5 kap 5 §). Null for a
 * payment never rebooked.
 */
async function replacedVoucherLabel(db: SupabaseClient, companyId: string, rebookedEntryIds: readonly string[]): Promise<string | null> {
  const last = rebookedEntryIds[rebookedEntryIds.length - 1]
  if (!last) return null
  const label = (entry: { voucher_series?: string | null; voucher_number?: number | null } | null) =>
    entry?.voucher_series && entry.voucher_number != null ? `${entry.voucher_series}${entry.voucher_number}` : null
  const { data, error } = await db
    .from('journal_entries')
    .select('voucher_series, voucher_number, reversed_by_id')
    .eq('company_id', companyId)
    .eq('id', last)
    .maybeSingle()
  if (error) throw new Error(`journal_entries lookup failed: ${error.message}`)
  const entry = data as { voucher_series?: string | null; voucher_number?: number | null; reversed_by_id?: string | null } | null
  const original = label(entry)
  if (!original) return null
  if (!entry?.reversed_by_id) return original
  const { data: storno, error: stornoError } = await db
    .from('journal_entries')
    .select('voucher_series, voucher_number')
    .eq('company_id', companyId)
    .eq('id', entry.reversed_by_id)
    .maybeSingle()
  if (stornoError) throw new Error(`journal_entries lookup failed: ${stornoError.message}`)
  const stornoLabel = label(storno as { voucher_series?: string | null; voucher_number?: number | null } | null)
  return stornoLabel ? `${original}, stornerad genom ${stornoLabel}` : original
}

/**
 * The payment record of this payment an earlier attempt archived but never
 * noted on the row: the system document with the record's file name (which
 * carries the invoice, the payment day and the provider's payment reference)
 * that sits on no voucher yet. A record already on a voucher (an earlier
 * booking a rebook reversed) never matches.
 */
async function findUnnotedPaymentRecord(db: SupabaseClient, companyId: string, fileName: string): Promise<string | null> {
  const { data, error } = await db
    .from('document_attachments')
    .select('id')
    .eq('company_id', companyId)
    .eq('file_name', fileName)
    .eq('upload_source', 'system')
    .eq('is_current_version', true)
    .is('journal_entry_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`document_attachments lookup failed: ${error.message}`)
  return ((data ?? []) as { id: string }[])[0]?.id ?? null
}

/**
 * The payment record of a collected payment (payment-record.tsx), archived
 * once: a row that already has one keeps it (a booking refused after the
 * archive, or a run that died, uses it on the next attempt), so a retry never
 * leaves a second unlinked document behind. Answers the document id.
 */
async function ensurePaymentRecord(
  deps: CollectedPaymentBookingDeps,
  row: CollectedPaymentRow,
  context: RecordContext,
  actor: { userId: string } | null,
  now: Date,
): Promise<string> {
  if (row.payment_record_document_id) return row.payment_record_document_id
  const { db } = deps
  const [{ data: company, error: companyError }, bookedBy, replaces] = await Promise.all([
    db.from('company_settings').select('company_name, org_number').eq('company_id', row.company_id).maybeSingle(),
    userDisplayName(db, context.userId),
    replacedVoucherLabel(db, row.company_id, row.rebooked_entry_ids),
  ])
  if (companyError) throw new Error(`company_settings lookup failed: ${companyError.message}`)
  const model = buildPaymentRecordModel({
    providerName: context.connection.display_name,
    company: company as { company_name?: string | null; org_number?: string | null } | null,
    invoice: { invoice_number: context.invoice.invoice_number ?? null, customer_name: context.invoice.customer?.name ?? null },
    caseNumber: context.caseNumber,
    payment: row,
    currency: context.invoice.currency || 'SEK',
    clearingAccount: context.connection.clearing_account,
    bookedAt: now,
    bookedBy,
    automatic: actor === null,
    replaces,
  })
  // An earlier attempt that died between its archive and the note below left
  // its record unlinked: use that one, never archive a second.
  const documentId =
    (await findUnnotedPaymentRecord(db, row.company_id, paymentRecordFilename(model))) ??
    (await (deps.archiveRecord ?? ((input) => archivePaymentRecord(db, input)))({ companyId: row.company_id, userId: context.userId, model }))
  const { error } = await db
    .from('collection_collected_payments')
    .update({ payment_record_document_id: documentId })
    .eq('company_id', row.company_id)
    .eq('id', row.id)
  if (error) throw new Error(`collection_collected_payments update failed: ${error.message}`)
  return documentId
}

/**
 * Book one collected payment (step C). `actor` is the person who clicked,
 * null for the automatic booking. Safe to call twice: a row already booked
 * answers alreadyBooked, a booking in flight answers busy, and a payment the
 * invoice already carries (a run that died after settling) is recorded
 * without a second voucher.
 */
export async function bookCollectedPayment(
  deps: CollectedPaymentBookingDeps,
  collectedPaymentId: string,
  actor: { userId: string } | null,
): Promise<BookCollectedPaymentResult> {
  const { db, companyId } = deps
  const logger = deps.log ?? log
  const now = deps.now ? deps.now() : new Date()
  const row = await loadCollectedPayment(db, companyId, collectedPaymentId)
  if (!row) return { ok: false, outcome: 'not_found' }
  if (row.status === 'booked' && (row.invoice_payment_id || row.write_off_id)) {
    return {
      ok: true,
      journalEntryId: row.journal_entry_id,
      invoicePaymentId: row.invoice_payment_id,
      writeOffId: row.write_off_id,
      alreadyBooked: true,
    }
  }
  if (row.status === 'ignored') return { ok: false, outcome: 'ignored' }

  const nowIso = now.toISOString()
  const leaseUntil = new Date(now.getTime() + COLLECTED_BOOKING_LEASE_MS).toISOString()
  // A free lease was never taken or has run out: two conditional updates with
  // literal filters (the schema guard checks every column), the run-out one
  // only when no never-taken lease was there to claim.
  const claim = (runOut: boolean) => {
    let query = db
      .from('collection_collected_payments')
      .update({ booking_lease_until: leaseUntil })
      .eq('company_id', companyId)
      .eq('id', row.id)
      .in('status', ['pending', 'needs_review'])
    query = runOut ? query.lt('booking_lease_until', nowIso) : query.is('booking_lease_until', null)
    return query.select('id').maybeSingle()
  }
  let { data: claimed, error: claimError } = await claim(false)
  if (!claimError && !claimed) ({ data: claimed, error: claimError } = await claim(true))
  if (claimError) throw new Error(`collection_collected_payments claim failed: ${claimError.message}`)
  if (!claimed) return { ok: false, outcome: 'busy' }

  const done = (error: { message: string } | null) => {
    if (error) throw new Error(`collection_collected_payments update failed: ${error.message}`)
  }
  const releaseLease = async () => {
    const { error } = await db
      .from('collection_collected_payments')
      .update({ booking_lease_until: null })
      .eq('company_id', companyId)
      .eq('id', row.id)
    done(error)
  }
  const booked = async (
    link: { invoicePaymentId: string; writeOffId?: never } | { invoicePaymentId?: never; writeOffId: string },
    journalEntryId: string | null,
    alreadyBooked: boolean,
  ): Promise<BookCollectedPaymentResult> => {
    const invoicePaymentId = link.invoicePaymentId ?? null
    const writeOffId = link.writeOffId ?? null
    const { error } = await db
      .from('collection_collected_payments')
      .update({
        status: 'booked',
        invoice_payment_id: invoicePaymentId,
        write_off_id: writeOffId,
        journal_entry_id: journalEntryId,
        booked_by: actor?.userId ?? null,
        booked_at: nowIso,
        review_reason: null,
        booking_lease_until: null,
      })
      .eq('company_id', companyId)
      .eq('id', row.id)
    done(error)
    return { ok: true, journalEntryId, invoicePaymentId, writeOffId, alreadyBooked }
  }
  const review = async (reason: string): Promise<BookCollectedPaymentResult> => {
    const { error } = await db
      .from('collection_collected_payments')
      .update({ status: 'needs_review', review_reason: reason.slice(0, 200), booking_lease_until: null })
      .eq('company_id', companyId)
      .eq('id', row.id)
    done(error)
    logger.info('collected payment needs review', { collectedPaymentId: row.id, reason })
    return { ok: false, outcome: 'needs_review', reason }
  }

  try {
    // A run that settled the invoice and died before recording it: record, never settle twice.
    const existing = await findCollectionsPaymentRow(db, row)
    if (existing) {
      const status = existing.journal_entry_id ? await voucherStatus(db, companyId, existing.journal_entry_id) : null
      if (status === 'posted' && existing.journal_entry_id) {
        // The payment record may be missing (archived after all, or never linked): finish it.
        const recordId =
          row.payment_record_document_id ??
          (await ensurePaymentRecord(deps, row, await loadRecordContext(db, row, actor), actor, now))
        await linkDocumentOnce(db, companyId, recordId, existing.journal_entry_id, logger)
        return await booked({ invoicePaymentId: existing.id }, existing.journal_entry_id, true)
      }
      // Never booked on a voucher the books do not hold: a row with no posted
      // voucher that no failed settlement explains waits for a person.
      if (status !== 'cancelled') {
        logger.warn('collections payment row without a posted voucher', { collectedPaymentId: row.id, voucherStatus: status })
        return await review('INVOICE_PAID_BOOK_FAILED')
      }
      // A settlement that lost its race: its voucher is cancelled, the row goes, the payment is booked below.
      await removeStrandedPaymentRow(db, companyId, existing.id)
      logger.warn('stranded collections payment row removed', { collectedPaymentId: row.id, invoicePaymentId: existing.id })
    }

    // A run that booked the recovery and died before recording it: record, never recover twice.
    const recovered = await findRecoveryOf(db, row)
    if (recovered && row.payment_record_document_id) {
      await linkDocumentOnce(db, companyId, row.payment_record_document_id, recovered.journal_entry_id, logger)
      return await booked({ writeOffId: recovered.id }, recovered.journal_entry_id, true)
    }

    const capital = roundOre(row.capital_paid)
    if (!(capital > 0)) return await review('NO_CAPITAL')

    const { openedBy, caseNumber, connection } = await loadCaseConnection(db, row)
    const { data: invoice, error: invoiceError } = await db
      .from('invoices')
      .select('*, customer:customers(name), items:invoice_items(*)')
      .eq('company_id', companyId)
      .eq('id', row.invoice_id)
      .maybeSingle()
    if (invoiceError) throw new Error(`invoices lookup failed: ${invoiceError.message}`)
    if (!invoice) return await review('INVOICE_NOT_FOUND')
    if ((invoice as { currency?: string }).currency !== 'SEK') return await review('CURRENCY_NOT_SEK')

    const { data: settings, error: settingsError } = await db
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .maybeSingle()
    if (settingsError) throw new Error(`company_settings lookup failed: ${settingsError.message}`)
    const accountingMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method || 'accrual'
    const entityType = await resolveCompanyEntityType(db, companyId, (settings as { entity_type?: string | null } | null)?.entity_type)

    // A written-off invoice: återvunnen kundförlust, never automatic (build spec 4.2 H).
    const writtenOff = (invoice as { status?: string }).status === 'written_off'
    if (writtenOff && !actor) return await review('WRITTEN_OFF_RECOVERY')

    const userId = actor?.userId ?? automaticBookingUser(openedBy, connection)
    // The underlag first (BFL 5 kap 6 and 7 §§): no C voucher without its payment record.
    const recordId = await ensurePaymentRecord(
      deps,
      row,
      { invoice: invoice as RecordInvoice, caseNumber, connection, userId },
      actor,
      now,
    )

    if (writtenOff) {
      const recover = deps.recoverLoss ?? recordRecoveredLoss
      const outcome = await recover(db, companyId, userId, {
        invoiceId: row.invoice_id,
        amount: capital,
        entryDate: row.paid_at,
        paymentAccount: connection.clearing_account,
        reason: `Inbetalning via inkasso, betalningsreferens ${row.provider_payment_ref}`,
        decidedBy: userId,
        fromCollectedPayment: true,
        evidenceDocumentId: recordId,
      })
      // The record stays archived on the row, unlinked: the next attempt uses it.
      if (!outcome.ok) return await review(outcome.code)
      if (outcome.journalEntryId) await linkDocumentOnce(db, companyId, recordId, outcome.journalEntryId, logger)
      logger.info('collected payment booked as a recovered customer loss', { collectedPaymentId: row.id, journalEntryId: outcome.journalEntryId })
      return await booked({ writeOffId: outcome.writeOffId }, outcome.journalEntryId, false)
    }

    const settle = deps.settle ?? settleInvoicePayment
    const result = await settle(db, companyId, userId, {
      invoice: invoice as Parameters<typeof settleInvoicePayment>[3]['invoice'],
      paymentAmountInInvoiceCurrency: capital,
      paymentDate: row.paid_at,
      accountingMethod,
      entityType,
      settlementAccountNumber: connection.clearing_account,
      paymentSource: 'collections',
      externalRef: row.provider_payment_ref,
    })
    // The record stays archived on the row, unlinked: the next attempt uses it.
    if (!result.ok) return await review(failureReason(result))

    const paymentRow = await findCollectionsPaymentRow(db, row)
    if (!paymentRow) throw new Error(`collected payment ${row.id} settled without a payment row`)
    if (result.journalEntryId) await linkDocumentOnce(db, companyId, recordId, result.journalEntryId, logger)
    logger.info('collected payment booked', { collectedPaymentId: row.id, journalEntryId: result.journalEntryId })
    return await booked({ invoicePaymentId: paymentRow.id }, result.journalEntryId, false)
  } catch (error) {
    // Leave the row for the next attempt; the lease would block it otherwise.
    await releaseLease().catch(() => undefined)
    throw error
  }
}

/** The collected payments still waiting for the books, oldest first. */
export async function loadUnbookedCollectedPayments(
  db: Pick<SupabaseClient, 'from'>,
  options: {
    companyId?: string
    companyIds?: readonly string[]
    caseIds?: readonly string[]
    statuses?: readonly CollectedPaymentStatus[]
    limit?: number
  } = {},
): Promise<CollectedPaymentRow[]> {
  let query = db
    .from('collection_collected_payments')
    .select('*')
    .in('status', [...(options.statuses ?? ['pending'])])
  if (options.companyId) query = query.eq('company_id', options.companyId)
  if (options.companyIds) query = query.in('company_id', [...options.companyIds])
  if (options.caseIds) query = query.in('case_id', [...options.caseIds])
  const { data, error } = await query.order('paid_at', { ascending: true }).limit(options.limit ?? 100)
  if (error) throw new Error(`collection_collected_payments lookup failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeCollectedPaymentRow)
}

export interface AutoBookCollectedSummary {
  booked: number
  needsReview: number
  skipped: number
  failed: number
  /** Payments left for the next run because the run budget was spent. */
  deferred: number
}

/**
 * The automatic booking of collected payments, for the companies that turned
 * it on (auto_book_collected_payments). Called from the sync run; a failure
 * on one row never stops the rest. The companies come first: payments that
 * wait for a person's click in other companies never crowd them out. Nothing
 * new starts once `budgetMs` (the sync run's time left) is spent.
 */
export async function autoBookCollectedPayments(
  deps: Omit<CollectedPaymentBookingDeps, 'companyId'>,
  options: { limit?: number; budgetMs?: number; clock?: () => number } = {},
): Promise<AutoBookCollectedSummary> {
  const summary: AutoBookCollectedSummary = { booked: 0, needsReview: 0, skipped: 0, failed: 0, deferred: 0 }
  const clock = options.clock ?? Date.now
  const started = clock()
  const budget = options.budgetMs ?? Number.POSITIVE_INFINITY
  const { data, error } = await deps.db
    .from('collection_connections')
    .select('company_id')
    .eq('auto_book_collected_payments', true)
    .limit(1000)
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  const auto = [...new Set(((data ?? []) as { company_id: string }[]).map((c) => c.company_id))]
  if (auto.length === 0) return summary
  const pending = await loadUnbookedCollectedPayments(deps.db, { companyIds: auto, limit: options.limit ?? 50 })
  for (const payment of pending) {
    // Nothing new starts once the sync run's budget is spent; the next run books the rest.
    if (clock() - started >= budget) {
      summary.deferred++
      continue
    }
    try {
      const result = await bookCollectedPayment({ ...deps, companyId: payment.company_id }, payment.id, null)
      if (result.ok) summary.booked++
      else if (result.outcome === 'needs_review') summary.needsReview++
      else summary.skipped++
    } catch (err) {
      summary.failed++
      ;(deps.log ?? log).warn('automatic booking of a collected payment failed', {
        collectedPaymentId: payment.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return summary
}
