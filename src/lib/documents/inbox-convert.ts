/**
 * Turn an invoice-inbox item into a registered supplier invoice (the
 * "Skapa leverantörsfaktura" of the Underlag inbox). One implementation
 * behind the invoice-inbox extension route
 * (POST /api/extensions/ext/invoice-inbox/items/:id/convert) and the v1
 * operation inbox-items.convert-to-supplier-invoice
 * (lib/operations/inbox-items.ts), so both apply the same rules:
 *
 *   - the item and the supplier must belong to the company; an item already
 *     converted is refused;
 *   - särskild löneskatt only on 741x pension lines and never with
 *     periodisering; periodisering never with reverse charge and only under
 *     faktureringsmetoden;
 *   - a non-SEK invoice gets Riksbanken's rate for the invoice date unless a
 *     rate is given, and is refused when none can be had (never a NULL rate);
 *   - the item's document becomes the supplier invoice's underlag, and the
 *     registration verifikat's when one is booked (BFL 5 kap 6 §);
 *   - a company that books on issue gets the registration verifikat through
 *     the engine at once; if that fails the invoice is removed again, so the
 *     item is never marked converted against an unbooked invoice;
 *   - a duplicate supplier invoice number answers the existing invoice.
 *
 * A dry run resolves the item, the supplier, the rules and the rate, and
 * computes the invoice; it allocates no ankomstnummer and writes no invoice,
 * verifikat or supplier payment details.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import type { z } from 'zod'
import type { CoreEvent } from '@/lib/events/types'
import { eventBus } from '@/lib/events'
import { backfillSupplierPaymentDetails, type SupplierPaymentDetails } from '@/lib/supplier-invoices/payment-details-backfill'
import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { defaultVatRateForTreatment } from '@/lib/vat/supplier-invoice-line-checks'
import { suggestBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { roundOre } from '@/lib/money'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { createSchedulesForSupplierInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import type { InboxChannelContext, InvoiceInboxItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'

export type ConvertInboxItemInput = z.infer<typeof CreateSupplierInvoiceSchema>

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface ConvertInboxItemResult {
  invoice: SupplierInvoice
  items: Array<Record<string, unknown>>
  registration_journal_entry_id: string | null
  inbox_item_id: string
}

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

export async function convertInboxItemToSupplierInvoice(
  ctx: OperationContext,
  inboxItemId: string,
  body: ConvertInboxItemInput,
  options: { dryRun?: boolean; emit?: (event: CoreEvent) => Promise<void> } = {},
): Promise<OperationOutcome<ConvertInboxItemResult>> {
  const { supabase, companyId, userId, log } = ctx
  const emit = options.emit ?? ((event: CoreEvent) => eventBus.emit(event))

  const { data: item, error: fetchError } = await supabase
    .from('invoice_inbox_items')
    .select('*')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !item) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
  if (item.created_supplier_invoice_id) {
    return { ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED', details: { supplier_invoice_id: item.created_supplier_invoice_id } }
  }

  const { data: supplier, error: supplierError } = await supabase
    .from('suppliers')
    .select('*')
    .eq('id', body.supplier_id)
    .eq('company_id', companyId)
    .single()
  if (supplierError || !supplier) return { ok: false, code: 'SUPPLIER_NOT_FOUND' }

  // The scan read the supplier's giro or IBAN with everything else: a
  // supplier that lacks them takes them now, so the invoice can go into a
  // betalfil without a detour to the supplier card. A write: commit only.
  const scannedSupplier = (item.extracted_data as { supplier?: SupplierPaymentDetails } | null)?.supplier
  if (scannedSupplier && !options.dryRun) {
    await backfillSupplierPaymentDetails(supabase, companyId, supplier.id as string, scannedSupplier)
  }

  // Särskild löneskatt (SLP): the 7533/2514 pair is only lawful on 741x
  // pension premiums and cannot be combined with periodisering on the row.
  if (body.items.some((line) => line.apply_slp && !isSlpPensionAccount(line.account_number))) {
    return { ok: false, code: 'SI_CREATE_SLP_INVALID_ACCOUNT' }
  }
  if (
    body.items.some(
      (line) =>
        line.apply_slp && (line.accrual_period_start || line.accrual_period_end || line.accrual_balance_account),
    )
  ) {
    return { ok: false, code: 'SI_CREATE_SLP_ACCRUAL' }
  }

  // Periodisering requires faktureringsmetoden, and never rides a reverse
  // charge invoice: the expense line carries the VAT base for rutor 20-32,
  // so deferring the net to a 17xx account would corrupt the momsdeklaration.
  const hasAccrualItems = body.items.some((line) => line.accrual_period_start && line.accrual_period_end)
  if (hasAccrualItems && body.reverse_charge) {
    return { ok: false, code: 'SI_CREATE_ACCRUAL_REVERSE_CHARGE' }
  }
  if (hasAccrualItems) {
    const { data: methodSettings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()
    if ((methodSettings?.accounting_method || 'accrual') !== 'accrual') {
      return {
        ok: false,
        code: 'SI_CREATE_INVALID_INPUT',
        details: { reason: 'periodisering requires faktureringsmetoden (accrual)' },
      }
    }
  }

  // Same currency policy as POST /api/supplier-invoices and the v1 create:
  // inbox items are AI-extracted, the currency comes off the PDF and the rate
  // never does, so a missing rate is fetched and an unresolvable one refused.
  // Resolved before the arrival number so a refusal burns no ankomstnummer.
  const fx = await resolveSupplierInvoiceExchangeRate(supabase, {
    currency: body.currency,
    invoiceDate: body.invoice_date,
    suppliedRate: body.exchange_rate,
  })
  if (!fx.ok) {
    return { ok: false, code: 'SI_FX_RATE_MISSING', details: { currency: fx.currency, invoice_date: fx.invoiceDate } }
  }

  // The stored treatment decides what a line that omits vat_rate falls back
  // to (#2553): exempt, export and reverse_charge carry no Swedish moms.
  const vatTreatment = body.vat_treatment || 'standard_25'

  const items = body.items.map((line, index) => {
    const vatRate = line.vat_rate ?? defaultVatRateForTreatment(vatTreatment)
    const lineTotal = line.amount != null
      ? roundOre(line.amount)
      : roundOre((line.quantity ?? 1) * (line.unit_price ?? 0))
    const vatAmount = roundOre(lineTotal * vatRate)
    const accrues = Boolean(line.accrual_period_start && line.accrual_period_end)
    return {
      sort_order: index,
      description: line.description,
      quantity: line.amount != null ? 1 : (line.quantity ?? 1),
      unit: line.amount != null ? 'st' : (line.unit || 'st'),
      unit_price: line.amount != null ? lineTotal : (line.unit_price ?? 0),
      line_total: lineTotal,
      account_number: line.account_number,
      vat_code: line.vat_code || null,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      // Self-assessed RC rate or null: the engine defaults to 25 % huvudregeln.
      reverse_charge_rate: body.reverse_charge ? (line.reverse_charge_rate ?? null) : null,
      // Periodisering frozen onto the line; the balance account defaults
      // from the cost account's BAS convention.
      accrual_period_start: accrues ? line.accrual_period_start : null,
      accrual_period_end: accrues ? line.accrual_period_end : null,
      accrual_balance_account: accrues
        ? (line.accrual_balance_account ?? suggestBalanceAccount('expense', line.account_number))
        : null,
      apply_slp: line.apply_slp === true,
    }
  })

  const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
  const totalVat = items.reduce((sum, i) => sum + i.vat_amount, 0)
  // `total` and `total_sek` must round identically or a SEK invoice ends up
  // one öre apart.
  const total = roundOre(subtotal + totalVat)
  const {
    subtotal_sek: subtotalSek,
    vat_amount_sek: vatAmountSek,
    total_sek: totalSek,
  } = supplierInvoiceSekAmounts(fx.rate, { subtotal, vatAmount: totalVat, total })

  // WhatsApp-sourced items: when the request carries NO notes field at all,
  // default to the rendered chat context (representation deltagare + syfte).
  // Presence decides, not truthiness: `notes: ""` is an explicit clear.
  const notes =
    body.notes === undefined
      ? renderChannelContextNotes((item as { channel_context?: InboxChannelContext | null }).channel_context)
      : body.notes.trim() || null

  if (options.dryRun) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, defer_invoice_booking')
      .eq('company_id', companyId)
      .single()
    return {
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: inboxItemId,
        supplier_id: body.supplier_id,
        supplier_name: (supplier.name as string | null) ?? null,
        supplier_invoice_number: body.supplier_invoice_number,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        currency: fx.rate.currency,
        exchange_rate: fx.rate.exchangeRate,
        exchange_rate_date: fx.rate.exchangeRateDate,
        vat_treatment: vatTreatment,
        reverse_charge: body.reverse_charge || false,
        subtotal: roundOre(subtotal),
        vat_amount: roundOre(totalVat),
        total,
        total_sek: totalSek,
        document_id: item.document_id || null,
        notes,
        items,
        would_create_registration_journal_entry: booksInvoicesOnIssue(settings),
      },
    }
  }

  const { data: arrivalNum, error: arrivalError } = await supabase.rpc('get_next_arrival_number', {
    p_company_id: companyId,
  })
  if (arrivalError) {
    log.error('inbox convert: arrival number allocation failed', arrivalError as unknown as Error)
    return { ok: false, code: 'SI_CREATE_FAILED', details: { step: 'arrival_number' } }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_id: body.supplier_id,
      arrival_number: arrivalNum,
      supplier_invoice_number: body.supplier_invoice_number,
      invoice_date: body.invoice_date,
      due_date: body.due_date,
      delivery_date: body.delivery_date || null,
      status: 'registered',
      currency: fx.rate.currency,
      exchange_rate: fx.rate.exchangeRate,
      // Which day's kurs the SEK amounts were translated at (BFL 5 kap).
      exchange_rate_date: fx.rate.exchangeRateDate,
      vat_treatment: vatTreatment,
      reverse_charge: body.reverse_charge || false,
      payment_reference: body.payment_reference || null,
      subtotal: roundOre(subtotal),
      subtotal_sek: subtotalSek,
      vat_amount: roundOre(totalVat),
      vat_amount_sek: vatAmountSek,
      total,
      total_sek: totalSek,
      remaining_amount: total,
      document_id: item.document_id || null,
      notes,
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    // A unique-index hit on (company_id, supplier_id, supplier_invoice_number)
    // is a recoverable conflict: the invoice is already registered (often by
    // hand, then converted from the same inbox document). Answer the existing
    // row, read under the company filter, and only server-authoritative
    // fields (never the request body echoed back).
    const pgErr = invoiceError as { code?: string; message?: string } | null
    const isDuplicateNumber =
      pgErr?.code === '23505' && (pgErr.message || '').includes('idx_supplier_invoices_company_supplier_number')
    if (isDuplicateNumber) {
      const { data: existing } = await supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, status')
        .eq('company_id', companyId)
        .eq('supplier_id', body.supplier_id)
        .eq('supplier_invoice_number', body.supplier_invoice_number)
        .maybeSingle()

      let creditNoteId: string | null = null
      if (existing?.status === 'credited') {
        const { data: creditNote } = await supabase
          .from('supplier_invoices')
          .select('id')
          .eq('company_id', companyId)
          .eq('credited_invoice_id', existing.id)
          .eq('is_credit_note', true)
          .maybeSingle()
        creditNoteId = creditNote?.id ?? null
      }
      return {
        ok: false,
        code: 'SI_CREATE_DUPLICATE_INVOICE_NUMBER',
        details: {
          existing: existing
            ? {
                id: existing.id,
                supplier_invoice_number: existing.supplier_invoice_number,
                status: existing.status,
                credit_note_id: creditNoteId,
              }
            : null,
        },
      }
    }
    return failed(invoiceError ?? new Error('Failed to create invoice'))
  }

  const itemInserts = items.map((line) => ({ supplier_invoice_id: invoice.id, ...line }))
  const { data: insertedItems, error: itemsError } = await supabase
    .from('supplier_invoice_items')
    .insert(itemInserts)
    .select('id, sort_order')
  if (itemsError) {
    await supabase.from('supplier_invoices').delete().eq('id', invoice.id)
    return failed(itemsError)
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking')
    .eq('company_id', companyId)
    .single()

  let registrationJournalEntryId: string | null = null

  // #967: deferred companies register WITHOUT booking; ekonomi books later.
  if (booksInvoicesOnIssue(settings)) {
    try {
      const journalEntry = await createSupplierInvoiceRegistrationEntry(
        supabase,
        companyId,
        userId,
        invoice as SupplierInvoice,
        items as SupplierInvoiceItem[],
        supplier.supplier_type,
        supplier.name,
      )
      if (journalEntry) {
        registrationJournalEntryId = journalEntry.id
        ;(invoice as SupplierInvoice).registration_journal_entry_id = journalEntry.id
        await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)

        if (item.document_id) {
          await supabase
            .from('document_attachments')
            .update({ journal_entry_id: journalEntry.id })
            .eq('id', item.document_id)
            .eq('company_id', companyId)
        }

        if (hasAccrualItems) {
          // Schedules + catch-up dissolutions for deferred lines. Never
          // fatal: the registration entry is committed; failures surface on
          // the periodiseringar page.
          const idBySortOrder = new Map(
            ((insertedItems ?? []) as Array<{ id: string; sort_order: number }>).map((row) => [row.sort_order, row.id]),
          )
          const itemsWithIds = items.map((line) => ({ ...line, id: idBySortOrder.get(line.sort_order) ?? null }))
          const scheduleResult = await createSchedulesForSupplierInvoice(
            supabase,
            companyId,
            userId,
            invoice as SupplierInvoice,
            itemsWithIds as unknown as SupplierInvoiceItem[],
            journalEntry.id,
          )
          if (scheduleResult.failed > 0) {
            log.error('accrual schedule creation failed on inbox convert', {
              supplierInvoiceId: invoice.id,
              failed: scheduleResult.failed,
            })
          }
        }
      } else {
        // null means no fiscal period covers invoice_date (every other
        // failure throws). Roll back so the item is never marked converted
        // against an unbooked invoice (an orphan understating 2440/2641).
        await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
        return {
          ok: false,
          code: 'SI_CREATE_NO_FISCAL_PERIOD',
          details: { invoiceDate: (invoice as SupplierInvoice).invoice_date },
        }
      }
    } catch (err) {
      // The engine threw (period lock, unbalanced entry, ...): roll back the
      // invoice for the same reason, then surface the engine's error.
      await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
      if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREATE_FAILED', error: err }
      return {
        ok: false,
        code: 'SI_CREATE_FAILED',
        details: { reason: err instanceof Error ? err.message : 'unknown', step: 'registration_journal_entry' },
      }
    }
  }

  try {
    await emit({
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: invoice as SupplierInvoice, companyId, userId },
    })
  } catch {
    /* non-blocking */
  }

  await supabase
    .from('invoice_inbox_items')
    .update({ created_supplier_invoice_id: invoice.id })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)

  try {
    await emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { ...item, created_supplier_invoice_id: invoice.id } as InvoiceInboxItem,
        supplierInvoice: invoice as SupplierInvoice,
        userId,
        companyId,
      },
    })
  } catch {
    /* non-blocking */
  }

  return {
    ok: true,
    created: true,
    data: {
      invoice: invoice as SupplierInvoice,
      items: itemInserts,
      registration_journal_entry_id: registrationJournalEntryId,
      inbox_item_id: inboxItemId,
    },
  }
}
