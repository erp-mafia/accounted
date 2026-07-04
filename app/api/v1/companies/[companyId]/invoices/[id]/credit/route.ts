/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/credit
 *
 * Issues a credit note (kreditfaktura) against the invoice identified by `:id`.
 * Per ML 17 kap 22-23§, a kreditfaktura references the original invoice's
 * löpnummer and carries reversed-sign amounts.
 *
 * Behaviour:
 *   1. Validates the target is a real invoice (document_type='invoice') and
 *      currently sent / paid / overdue (already-credited rows are rejected).
 *   2. Creates a NEW invoice row with credited_invoice_id set, status='sent',
 *      invoice_number='KR-<original>', and negated subtotal / vat / total.
 *   3. Mirrors the items table with negated quantity + line_total + vat_amount.
 *      On items failure, rolls back the credit-note row (scoped DELETE).
 *   4. Flips the original invoice to status='credited'.
 *   5. Posts the reverse journal entry via createCreditNoteJournalEntry
 *      (accrual only: cash basis defers recognition to refund time).
 *   6. Emits invoice.credited.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable. The credit-note row
 * gets created via INSERT: under dry-run NO row is created.
 *
 * Optional body: { reason?: string }: populates the credit note's `notes`
 * field. Defaults to "Krediterar faktura <original>".
 */

import { z } from 'zod'
import { created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { createCreditNoteJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { eventBus } from '@/lib/events'
import type { AccountingMethod, CreditNote, EntityType, Invoice } from '@/types'

const CreditNoteRequest = z.object({
  reason: z.string().max(2000).optional(),
})

const ORIGINAL_INVOICE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type'

const CREDIT_NOTE_RESPONSE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, paid_at, paid_amount, remaining_amount, created_at, updated_at'

const ORIGINAL_ITEMS_COLUMNS =
  'sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount'

const CreditNoteCreated = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  credited_invoice_id: z.string().uuid(),
  status: z.literal('sent'),
  total: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
})

registerEndpoint({
  operation: 'invoices.credit',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/credit',
  summary: 'Issue a credit note (kreditfaktura) against an invoice.',
  description:
    'Creates a credit note referencing the original invoice. The credit note carries reversed-sign amounts (matching the original line for line) and gets invoice_number=KR-<original>. The original invoice transitions to status=credited. Under faktureringsmetoden, posts a reversing journal entry (Credit AR 1510 / Debit revenue + Debit output VAT). Under kontantmetoden the credit note still creates the row but defers the reversal entry until refund. Idempotent and dry-runnable. Emits invoice.credited.',
  useWhen:
    'You need to legally cancel an issued invoice (ML 17 kap 22-23§). The original invoice cannot be edited once issued: credit it and reissue corrected.',
  doNotUseFor:
    'Cancelling a draft (DELETE the draft instead). Refunding a partial payment without invalidating the whole invoice (book the refund manually via the journal-entries API in a future PR).',
  pitfalls: [
    'Idempotency-Key is mandatory. Retried credits with the same key replay the cached response: no duplicate credit note is created.',
    'The original invoice must be in sent / paid / overdue status. Drafts, cancelled invoices, and already-credited invoices are rejected with specific error codes.',
    'Credit-note items mirror the original\'s lines with negated values. To credit only part of an invoice (line-level), credit the full invoice first then reissue with the corrected lines.',
    'Under kontantmetoden no journal entry is created here: refund booking is deferred. A `JOURNAL_ENTRY_NOT_POSTED` warning is NOT emitted in this case (the deferral is correct, not a failure).',
  ],
  example: {
    request: { reason: 'Felaktig kund' },
    response: {
      data: {
        id: 'ccccccc-c…',
        invoice_number: 'KR-2026-0042',
        credited_invoice_id: '0e9c…',
        status: 'sent',
        total: -12500,
        journal_entry_id: '8b4b…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CreditNoteRequest },
  response: { success: dataEnvelope(CreditNoteCreated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.credit',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const originalId = idParse.data

    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    // Body is optional. Empty POST is valid (uses default notes).
    let rawBody: unknown = null
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    let reason: string | undefined
    if (rawBody) {
      const parsed = CreditNoteRequest.safeParse(rawBody)
      if (!parsed.success) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            issues: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          },
        })
      }
      reason = parsed.data.reason
    }

    // Pre-flight: fetch original invoice + items.
    const { data: originalInvoice, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(`${ORIGINAL_INVOICE_COLUMNS}, customer:customers(id, name), items:invoice_items(${ORIGINAL_ITEMS_COLUMNS})`)
      .eq('company_id', ctx.companyId!)
      .eq('id', originalId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!originalInvoice) {
      ctx.log.warn('invoices.credit: original not found', {
        invoiceId: originalId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_CREDIT_ORIGINAL_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    type OriginalShape = Invoice & {
      customer?: { name?: string }
      items?: Array<{
        sort_order: number
        description: string
        quantity: number
        unit: string
        unit_price: number
        line_total: number
        vat_rate?: number | null
        vat_amount?: number | null
      }>
    }
    const original = originalInvoice as unknown as OriginalShape

    // Document-shape guards.
    if (original.document_type && original.document_type !== 'invoice') {
      return v1ErrorResponseFromCode('INVOICE_CREDIT_NOT_INVOICE', ctx.log, {
        requestId: ctx.requestId,
        details: { document_type: original.document_type },
      })
    }
    if (original.credited_invoice_id) {
      // Original IS itself a credit note: can't credit a credit.
      return v1ErrorResponseFromCode('INVOICE_CREDIT_NOT_INVOICE', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'cannot credit a credit note' },
      })
    }
    if (original.status === 'credited') {
      return v1ErrorResponseFromCode('INVOICE_CREDIT_ALREADY_CREDITED', ctx.log, {
        requestId: ctx.requestId,
      })
    }
    if (!['sent', 'paid', 'overdue'].includes(original.status)) {
      return v1ErrorResponseFromCode('INVOICE_CREDIT_NOT_SENT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: original.status },
      })
    }

    const today = new Date().toISOString().split('T')[0]
    const creditNoteNumber = `KR-${original.invoice_number ?? original.id.slice(0, 8)}`
    const negate = (n: number | null | undefined): number =>
      n == null ? 0 : -Math.abs(n)
    const negateNullable = (n: number | null | undefined): number | null =>
      n == null ? null : -Math.abs(n)

    // Compute credit-note items + totals up front (used in both dry-run and commit).
    const creditNoteRow = {
      user_id: ctx.userId,
      company_id: ctx.companyId!,
      customer_id: original.customer_id,
      invoice_number: creditNoteNumber,
      invoice_date: today,
      due_date: today,
      delivery_date: original.delivery_date ?? null,
      currency: original.currency,
      exchange_rate: original.exchange_rate ?? null,
      exchange_rate_date: original.exchange_rate_date ?? null,
      subtotal: negate(original.subtotal),
      subtotal_sek: negateNullable(original.subtotal_sek),
      vat_amount: negate(original.vat_amount),
      vat_amount_sek: negateNullable(original.vat_amount_sek),
      total: negate(original.total),
      total_sek: negateNullable(original.total_sek),
      vat_treatment: original.vat_treatment,
      vat_rate: original.vat_rate,
      moms_ruta: original.moms_ruta,
      reverse_charge_text: original.reverse_charge_text ?? null,
      your_reference: original.your_reference ?? null,
      our_reference: original.our_reference ?? null,
      notes: reason || `Krediterar faktura ${original.invoice_number ?? original.id}`,
      credited_invoice_id: originalId,
      status: 'sent' as const,
      document_type: 'invoice' as const,
    }

    const creditNoteItems = (original.items ?? []).map((item) => ({
      sort_order: item.sort_order,
      description: item.description,
      quantity: -Math.abs(item.quantity),
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: -Math.abs(item.line_total),
      vat_rate: item.vat_rate ?? 0,
      vat_amount: -Math.abs(item.vat_amount ?? 0),
    }))

    // Fetch settings for accounting method + entity type.
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod =
      ((settings as { accounting_method?: string } | null)?.accounting_method ??
        'accrual') as AccountingMethod
    const entityType = ((settings as { entity_type?: string } | null)?.entity_type ??
      'enskild_firma') as EntityType
    const wouldCreateJournalEntry = accountingMethod === 'accrual'

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: '(allocated on commit)',
          ...creditNoteRow,
          // Strip internal ids from the preview.
          user_id: undefined,
          company_id: undefined,
          items: creditNoteItems,
          would_create_journal_entry: wouldCreateJournalEntry,
          accounting_method: accountingMethod,
          original_invoice_number: original.invoice_number,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Commit. Step 1: insert credit note header.
    const { data: creditNote, error: insertErr } = await ctx.supabase
      .from('invoices')
      .insert(creditNoteRow)
      .select(CREDIT_NOTE_RESPONSE_COLUMNS)
      .single()
    if (insertErr) {
      ctx.log.error('credit-note insert failed', insertErr, {
        invoiceId: originalId,
        companyId: ctx.companyId,
        pgCode: insertErr.code,
      })
      return v1ErrorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { pg_code: insertErr.code },
      })
    }
    const creditNoteId = (creditNote as { id: string }).id

    // Step 2: insert items. Roll back on failure.
    const itemsToInsert = creditNoteItems.map((r) => ({ ...r, invoice_id: creditNoteId }))
    const { error: itemsErr } = await ctx.supabase.from('invoice_items').insert(itemsToInsert)
    if (itemsErr) {
      const { error: rollbackErr } = await ctx.supabase
        .from('invoices')
        .delete()
        .eq('id', creditNoteId)
        .eq('company_id', ctx.companyId!)
      if (rollbackErr) {
        ctx.log.error(
          'credit-note items insert failed AND rollback delete failed: orphaned header',
          rollbackErr,
          {
            creditNoteId,
            originalInvoiceId: originalId,
            companyId: ctx.companyId,
            originalPgCode: itemsErr.code,
          },
        )
      } else {
        ctx.log.error('credit-note items insert failed; rolled back', itemsErr, {
          creditNoteId,
          companyId: ctx.companyId,
        })
      }
      return v1ErrorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { pg_code: itemsErr.code },
      })
    }

    // Step 3: flip original invoice to credited.
    const warnings: { code: string; message: string }[] = []
    const { error: flipErr } = await ctx.supabase
      .from('invoices')
      .update({ status: 'credited', updated_at: new Date().toISOString() })
      .eq('id', originalId)
      .eq('company_id', ctx.companyId!)
    if (flipErr) {
      ctx.log.error('credit: failed to mark original as credited', flipErr as Error, {
        invoiceId: originalId,
        creditNoteId,
        companyId: ctx.companyId,
      })
      warnings.push({
        code: 'ORIGINAL_NOT_FLIPPED',
        message: 'Credit note was created but the original invoice could not be marked credited. Reconcile manually.',
      })
    }

    // Step 4: post the reverse journal entry (accrual only). Best-effort.
    let journalEntryId: string | null = null
    if (wouldCreateJournalEntry) {
      try {
        const refreshedCreditNote = {
          ...creditNote,
          items: itemsToInsert,
          customer: original.customer,
        } as unknown as Invoice
        const entry = await createCreditNoteJournalEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          refreshedCreditNote,
          entityType,
          original.customer?.name,
        )
        if (entry) {
          journalEntryId = entry.id
          const { error: writeBackErr } = await ctx.supabase
            .from('invoices')
            .update({ journal_entry_id: entry.id })
            .eq('id', creditNoteId)
            .eq('company_id', ctx.companyId!)
          if (writeBackErr) {
            ctx.log.error('credit: journal_entry_id write-back failed', writeBackErr as Error, {
              creditNoteId,
              journalEntryId: entry.id,
            })
            warnings.push({
              code: 'JOURNAL_ENTRY_ID_WRITEBACK_FAILED',
              message: 'Credit-note journal entry was posted but the row could not be updated with its id. Re-fetch and reconcile.',
            })
          }
        } else {
          ctx.log.error('credit: journal entry not created (engine returned null)', new Error('null entry'), {
            creditNoteId,
          })
          warnings.push({
            code: 'JOURNAL_ENTRY_NOT_POSTED',
            message: 'Credit note was created but no journal entry was posted. Check fiscal period and the engine logs (BFL 5 kap reconciliation required).',
          })
        }
      } catch (err) {
        ctx.log.error('credit: journal entry creation failed', err as Error, {
          creditNoteId,
          companyId: ctx.companyId,
        })
        warnings.push({
          code: 'JOURNAL_ENTRY_NOT_POSTED',
          message: 'Credit note was created but the journal entry failed. Reconcile manually.',
        })
      }
    }

    // Step 5: emit credit_note.created (existing event in the bus). The
    // payload carries the new credit note; subscribers can read
    // credited_invoice_id off it to find the original.
    try {
      await eventBus.emit({
        type: 'credit_note.created',
        payload: {
          creditNote: { ...(creditNote as object), customer: original.customer } as unknown as CreditNote,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.error('credit_note.created emit failed', err as Error, {
        creditNoteId,
        companyId: ctx.companyId,
      })
      warnings.push({
        code: 'EVENT_EMIT_FAILED',
        message: 'credit_note.created event did not reach the bus; downstream subscribers may miss this transition.',
      })
    }

    ctx.log.info('invoices.credit success', {
      creditNoteId,
      originalInvoiceId: originalId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      creditNoteNumber,
      journalEntryId,
      hadWarnings: warnings.length > 0,
    })

    return created(
      {
        ...(creditNote as object),
        journal_entry_id: journalEntryId,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
