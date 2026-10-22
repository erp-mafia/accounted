/**
 * The Inkorg's one click: the booking plan of an inbox item
 * (./inkorg-one-click.ts, read by ./inkorg-one-click-read.ts) and its
 * execution, behind GET /api/inkorg/items/:id/booking-plan (what "Så bokförs
 * den" shows, with a preview token) and POST /api/inkorg/items/:id/book.
 *
 * Booking recomputes the plan from the books as they are now and books only
 * what the person saw: a token that no longer matches the recomputed plan
 * is refused with PREVIEW_STALE (nothing written, the fresh plan and token
 * in details), a bank row the request pins that the plan no longer names
 * with INBOX_BANK_MATCH_STALE, and a plan that still asks something
 * (the category, where the seller is, the editor) with
 * INKORG_BOOKING_NEEDS_ANSWER. The purchase is booked once: the other half
 * of it booked already is refused before anything is written (the pair
 * guard, which the internals ask too).
 *
 * Then the form runs through the internals every door shares, never a
 * write of its own:
 *   - direct: book-direct (./inbox-book-direct.ts): the verifikat through
 *     the posting port, the bank row and the item claimed for it, the
 *     document linked, the receipt it came with following it;
 *   - register: the convert door's service (./inbox-convert.ts);
 *   - register_and_settle: the register-and-settle core
 *     (./inbox-register-and-settle.ts), which settles against the arrival
 *     match.
 * A supplier the plan creates is created through createSupplier
 * (lib/suppliers/create-supplier.ts), after one more identity match so a
 * register is never doubled; the answer says supplier_created. A date in a
 * locked period is not moved: the engine's refusal comes back as is, and
 * the page opens the editor.
 */
import type { NextResponse } from 'next/server'
import { CreateSupplierInvoiceSchema, CreateSupplierSchema, BookInboxItemDirectlySchema } from '@/lib/api/schemas'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { PurchaseCategoryCode } from '@/lib/categories/purchase-categories'
import { resolveSupplierInvoiceExchangeRate } from '@/lib/currency/supplier-invoice-rate'
import { matchInboxItemSupplier } from '@/lib/documents/inbox-match'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createSupplier } from '@/lib/suppliers/create-supplier'
import { matchSupplierByIdentity } from '@/lib/suppliers/match-supplier'
import type { SellerRegion } from '@/lib/vat/seller-country'
import { bookInboxItemDirectly } from './inbox-book-direct'
import { convertInboxItemToSupplierInvoice } from './inbox-convert'
import { refuseWhenPairBooked } from './inbox-pair-guard'
import { registerAndSettleInboxItem } from './inbox-register-and-settle'
import { oneClickOutcome, planOneClick, type OneClickForm, type OneClickInput, type OneClickPlan, type OneClickSupplierCreate } from './inkorg-one-click'
import { readOneClickInput, type OneClickItem } from './inkorg-one-click-read'
import { computePreviewToken } from './preview-token'
import { sessionFailureResponse } from './session'
import type { OperationContext, OperationOutcome } from './types'

/** The fingerprint's operation: a token of this plan never passes on another door. */
export const INKORG_BOOK_OPERATION_ID = 'inkorg.book'

/** What a person answered on the page; part of the request, never stored. */
export interface InkorgBookingAnswers {
  purchase_category?: PurchaseCategoryCode
  seller_country?: SellerRegion
}

export interface InkorgBookingPlan {
  plan: OneClickPlan
  preview_token: string
}

export interface InkorgBookRequest extends InkorgBookingAnswers {
  preview_token: string
  /** The bank row the page showed; the plan must still name it. */
  transaction_id?: string
}

export interface InkorgBooked {
  form: OneClickForm
  /** The verifikat that books the purchase: the one verifikat, else the registration (under kontantmetoden the payment). */
  journal_entry_id: string | null
  /** Its voucher label (A71). */
  voucher: string | null
  supplier_id: string | null
  /** A supplier card was created for it. */
  supplier_created: boolean
  supplier_invoice_id: string | null
  transaction_id: string | null
  /** register_and_settle: whether the payment was booked too (false: registered, not settled). */
  settled: boolean | null
  settlement_error: { code: string; message: string; message_en?: string } | null
}

export type InkorgBookOutcome = { ok: true; data: InkorgBooked } | { ok: false; response: NextResponse }

type Planned =
  | { ok: true; plan: OneClickPlan; token: string; item: OneClickItem; accountingCash: boolean; input: OneClickInput }
  | { ok: false; code: string; details?: Record<string, unknown> }

async function planItem(ctx: OperationContext, itemId: string, answers: InkorgBookingAnswers): Promise<Planned> {
  const read = await readOneClickInput(
    ctx.supabase,
    ctx.companyId,
    itemId,
    { purchaseCategory: answers.purchase_category ?? null, sellerRegion: answers.seller_country ?? null },
    ctx.log,
  )
  if (!read.ok) return read
  let plan = planOneClick(read.input)
  // A register path in a foreign currency is planned at Riksbanken's rate for
  // the invoice date, the same resolver the convert door registers it with.
  const invoiceDate = read.input.reading?.invoice?.invoiceDate
  if (plan.reason === 'fx_rate_missing' && invoiceDate) {
    const fx = await resolveSupplierInvoiceExchangeRate(ctx.supabase, { currency: read.input.reading?.invoice?.currency, invoiceDate })
    if (fx.ok && fx.rate.exchangeRate) plan = planOneClick({ ...read.input, invoiceRate: fx.rate.exchangeRate })
  }
  const token = computePreviewToken({
    operationId: INKORG_BOOK_OPERATION_ID,
    companyId: ctx.companyId,
    input: { inbox_item_id: itemId, purchase_category: answers.purchase_category ?? null, seller_country: answers.seller_country ?? null },
    preview: plan as unknown as Record<string, unknown>,
  })
  return { ok: true, plan, token, item: read.item, accountingCash: read.input.company.cashMethod, input: read.input }
}

/** GET .../booking-plan: the plan and its token. */
export async function readInkorgBookingPlan(
  ctx: OperationContext,
  itemId: string,
  answers: InkorgBookingAnswers,
): Promise<OperationOutcome<InkorgBookingPlan>> {
  const planned = await planItem(ctx, itemId, answers)
  if (!planned.ok) return { ok: false, code: planned.code, details: planned.details }
  // Codes only (oneClickOutcome): what the one click would do for this item, and why not when it would not.
  ctx.log.info('one-click plan', {
    itemId,
    ...oneClickOutcome(planned.input, planned.plan, { category: !!answers.purchase_category, seller: !!answers.seller_country }),
  })
  return { ok: true, data: { plan: planned.plan, preview_token: planned.token } }
}

async function voucherOf(ctx: OperationContext, journalEntryId: string | null): Promise<string | null> {
  if (!journalEntryId) return null
  const { data } = await ctx.supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number')
    .eq('id', journalEntryId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  const label = data ? formatVoucher(data as { voucher_series: string | null; voucher_number: number | null }) : '-'
  return label === '-' ? null : label
}

type SupplierResult = { ok: true; id: string; created: boolean } | { ok: false; response: NextResponse }

/**
 * The supplier card a register path needs, created from the reading. Fields
 * the register's rules refuse (a giro or IBAN that does not check out) are
 * left off rather than failing the booking: the card keeps what is certain.
 */
async function createPlannedSupplier(ctx: OperationContext & { requestId: string }, create: OneClickSupplierCreate): Promise<SupplierResult> {
  // One more identity match: a card created since the plan was read is used, never doubled.
  const again = await matchSupplierByIdentity(ctx.supabase, ctx.companyId, { orgNumber: create.org_number, vatNumber: create.vat_number, name: create.name })
  if (again) return { ok: true, id: again.supplierId, created: false }

  const full = CreateSupplierSchema.safeParse(create)
  const parsed = full.success
    ? full
    : CreateSupplierSchema.safeParse({
        name: create.name,
        supplier_type: create.supplier_type,
        country: create.country,
        vat_number: create.vat_number,
        address_line1: create.address_line1,
      })
  if (!parsed.success) {
    return { ok: false, response: errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, reason: 'supplier from the reading', details: { field: 'supplier' } }) }
  }
  const created = await createSupplier(ctx, parsed.data)
  if (created.ok && !created.dryRun) return { ok: true, id: created.data.id, created: true }
  if (!created.ok && created.code === 'SUPPLIER_DUPLICATE_ORG_NUMBER') {
    const existing = await matchSupplierByIdentity(ctx.supabase, ctx.companyId, { orgNumber: create.org_number })
    if (existing) return { ok: true, id: existing.supplierId, created: false }
  }
  if (!created.ok) return { ok: false, response: sessionFailureResponse(created, ctx.log, ctx.requestId) }
  return { ok: false, response: errorResponseFromCode('SUPPLIER_CREATE_FAILED', ctx.log, { requestId: ctx.requestId }) }
}

/** POST .../book: recompute, check the pin, book the plan's form through the shared internals. */
export async function bookInkorgItem(
  ctx: OperationContext & { requestId: string },
  itemId: string,
  request: InkorgBookRequest,
): Promise<InkorgBookOutcome> {
  const { log, requestId } = ctx
  const refused = (response: NextResponse): InkorgBookOutcome => ({ ok: false, response })
  // What the plan built is refused by the door's own rules: the editor's, after all.
  const editorAfterAll = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) =>
    errorResponseFromCode('INKORG_BOOKING_NEEDS_ANSWER', log, {
      requestId,
      details: { ask: 'editor', reason: 'refused_by_door', issues: issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
    })

  const planned = await planItem(ctx, itemId, request)
  if (!planned.ok) return refused(errorResponseFromCode(planned.code, log, { requestId, details: planned.details }))
  const { plan, item } = planned
  if (planned.token !== request.preview_token) {
    return refused(errorResponseFromCode('PREVIEW_STALE', log, { requestId, details: { preview: plan, preview_token: planned.token } }))
  }
  if (request.transaction_id && request.transaction_id !== plan.transactionId) {
    return refused(errorResponseFromCode('INBOX_BANK_MATCH_STALE', log, { requestId, details: { proposed_transaction_id: plan.transactionId } }))
  }
  if (plan.ask || !plan.form) {
    return refused(errorResponseFromCode('INKORG_BOOKING_NEEDS_ANSWER', log, {
      requestId,
      details: { ask: plan.ask ?? 'editor', reason: plan.reason, preview: plan, preview_token: planned.token },
    }))
  }
  const form = plan.form

  // The purchase is booked once (lib/operations/inbox-pair-guard.ts).
  const pairBooked = await refuseWhenPairBooked(ctx.supabase, ctx.companyId, itemId)
  if (pairBooked) {
    return refused(errorResponseFromCode(pairBooked.code, log, {
      requestId,
      details: pairBooked.details,
      messageSv: pairBooked.messageSv,
      messageEn: pairBooked.messageEn,
    }))
  }

  // The supplier: the matched card, else one created from the reading (register paths).
  let supplierId: string | null = plan.supplier && 'id' in plan.supplier ? plan.supplier.id : null
  let supplierCreated = false
  if (plan.supplier && 'create' in plan.supplier) {
    const supplier = await createPlannedSupplier(ctx, plan.supplier.create)
    if (!supplier.ok) return refused(supplier.response)
    supplierId = supplier.id
    supplierCreated = supplier.created
  }

  const booked = (rest: Partial<InkorgBooked> & Pick<InkorgBooked, 'journal_entry_id' | 'voucher'>): InkorgBookOutcome => ({
    ok: true,
    data: {
      form,
      supplier_id: supplierId,
      supplier_created: supplierCreated,
      supplier_invoice_id: null,
      transaction_id: plan.transactionId,
      settled: null,
      settlement_error: null,
      ...rest,
    },
  })

  if (form === 'direct') {
    // A matched supplier card is named on the item, as the convert door's supplier would be. Best effort.
    if (supplierId && !item.matchedSupplierId) {
      const linked = await matchInboxItemSupplier(ctx, itemId, supplierId)
      if (!linked.ok) log.warn('one click: the matched supplier could not be named on the item', { itemId, code: linked.code })
    }
    const entryDate = plan.entryDate as string
    const fiscalPeriodId = await findFiscalPeriod(ctx.supabase, ctx.companyId, entryDate)
    if (!fiscalPeriodId) return refused(errorResponseFromCode('NO_OPEN_PERIOD_FOR_DATE', log, { requestId, details: { date: entryDate } }))
    const parsed = BookInboxItemDirectlySchema.safeParse({
      fiscal_period_id: fiscalPeriodId,
      entry_date: entryDate,
      description: item.description || 'Underlag från inkorgen',
      lines: plan.lines.map((line) => ({
        account_number: line.account_number,
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
        ...(line.description ? { line_description: line.description } : {}),
      })),
      ...(plan.transactionId ? { transaction_id: plan.transactionId } : {}),
    })
    if (!parsed.success) return refused(editorAfterAll(parsed.error.issues))
    const outcome = await bookInboxItemDirectly(ctx, itemId, parsed.data)
    if (!outcome.ok) return refused(outcome.response)
    const label = formatVoucher(outcome.journalEntry)
    return booked({ journal_entry_id: outcome.journalEntry.id, voucher: label === '-' ? null : label, transaction_id: outcome.transactionId })
  }

  const parsedInvoice = CreateSupplierInvoiceSchema.safeParse({ supplier_id: supplierId, ...plan.invoice })
  if (!parsedInvoice.success) return refused(editorAfterAll(parsedInvoice.error.issues))
  const invoice = parsedInvoice.data
  if (form === 'register') {
    const registered = await convertInboxItemToSupplierInvoice(ctx, itemId, invoice)
    if (!registered.ok) return refused(sessionFailureResponse(registered, log, requestId))
    if (registered.dryRun) return refused(errorResponseFromCode('UNKNOWN_ERROR', log, { requestId }))
    const entryId = registered.data.registration_journal_entry_id
    return booked({
      journal_entry_id: entryId,
      voucher: await voucherOf(ctx, entryId),
      supplier_invoice_id: registered.data.invoice.id,
      transaction_id: null,
    })
  }

  const outcome = await registerAndSettleInboxItem(ctx, itemId, { transaction_id: plan.transactionId as string, invoice })
  if (!outcome.ok) return refused(outcome.response)
  const result = outcome.data
  // Under kontantmetoden the payment is the verifikat that books the purchase.
  const entryId = planned.accountingCash
    ? (result.payment_journal_entry_id ?? result.registration_journal_entry_id)
    : (result.registration_journal_entry_id ?? result.payment_journal_entry_id ?? null)
  return booked({
    journal_entry_id: entryId ?? null,
    voucher: await voucherOf(ctx, entryId ?? null),
    supplier_invoice_id: result.supplier_invoice_id,
    settled: result.settled,
    settlement_error: result.settlement_error,
  })
}
