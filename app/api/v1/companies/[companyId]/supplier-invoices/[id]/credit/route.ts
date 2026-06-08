/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/credit
 *
 * Issues a credit note (kreditfaktura) for an existing supplier invoice.
 * Mirrors the dashboard credit flow:
 *
 *   1. Allocate a new arrival_number for the credit note.
 *   2. Insert a new supplier_invoices row with is_credit_note=true,
 *      credited_invoice_id=<original.id>, and reversed amounts copied from
 *      the original.
 *   3. Copy items from the original.
 *   4. Under accrual, post the credit-note JE (reverses the registration:
 *      Debit 2440 / Credit 5xxx + Credit 2641).
 *   5. Flip the original's status to `credited`.
 *
 * Strict-mode v1: any failure rolls back the credit-note row before
 * returning the error. Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { createSupplierCreditNoteEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountingMethod, SupplierInvoice, SupplierInvoiceItem } from '@/types'

const SI_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, is_credit_note, credited_invoice_id, registration_journal_entry_id, created_at, updated_at'

// GDPR Art.25 data minimisation: the original SI's `user_id` (the row's
// historical creator) is never used in the credit flow — the new credit-note
// row uses `ctx.userId` (the actor performing the credit). Don't fetch what
// you don't need. `company_id` is already scoped by the `.eq('company_id')`
// filter, so omit that too — the route can't write to a different one.
// GDPR Art.25 data minimisation: only fields actually read in the credit
// flow are projected. `user_id` and `company_id` were dropped earlier; this
// round drops `notes` (the original SI's free-text notes are never copied
// onto the credit note and never inspected) plus several housekeeping
// fields (`paid_at`, `payment_journal_entry_id`, `transaction_id`,
// `document_id`, `payment_reference`, `paid_amount`, `delivery_date`,
// `received_date`, `is_credit_note`, `reversed_at`, `created_at`,
// `updated_at`) that the credit handler never reads. SEK-conversion fields
// (`subtotal_sek` / `vat_amount_sek` / `total_sek`) ARE read — they're
// copied verbatim onto the credit-note row so the 2440 reversal nets
// correctly.
const SI_FULL_COLUMNS = `
  id, supplier_id, supplier_invoice_number, invoice_date, status,
  currency, exchange_rate,
  subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek,
  vat_treatment, reverse_charge, remaining_amount,
  is_credit_note, credited_invoice_id, arrival_number,
  supplier:suppliers(id, name, supplier_type),
  items:supplier_invoice_items(id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate)
`

const SupplierInvoiceCredited = z.object({
  credit_note_id: z.string().uuid(),
  original_id: z.string().uuid(),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string(),
  registration_journal_entry_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'supplier-invoices.credit',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/credit',
  summary: 'Issue a credit note for a supplier invoice.',
  description:
    'Creates a kreditfaktura that reverses the original supplier invoice. Under accrual the reversing JE is posted atomically (Debit 2440 / Credit expense + Credit 2641). The original status flips to `credited`. Strict-mode: any failure rolls back the credit-note row. Idempotent. Dry-runnable.',
  useWhen:
    'You need to nullify a registered, approved, partially_paid, or paid supplier invoice — for a returned shipment, an over-invoice, or a vendor dispute resolution. Use dry-run to confirm the totals first.',
  doNotUseFor:
    'Editing line items on an unchanged invoice (use PATCH on `registered` SIs). Crediting an already-credited SI (returns 409 SI_CREDIT_ALREADY_CREDITED). Reversing a v1-issued credit (no v1 endpoint today — use the dashboard).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Today\'s date is used as the credit-note invoice_date. It must fall in an open fiscal period — locked period returns 400 SI_CREDIT_PERIOD_LOCKED.',
    'Cash basis (kontantmetoden): no reversing JE is posted — recognition is deferred until a refund transaction is booked. The credit-note row is still created so the AP audit trail stays consistent.',
    'The original SI is flipped to `credited` regardless of how much of it was already paid; reconcile the bank refund via the transactions endpoints.',
  ],
  example: {
    response: {
      data: {
        credit_note_id: '4d2a…',
        original_id: '0e9c…',
        arrival_number: 43,
        supplier_invoice_number: 'KREDIT-2026-1234',
        registration_journal_entry_id: '9c2f…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: SupplierInvoiceCredited },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.credit',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    // Fetch the original with supplier + items.
    const { data: original, error: fetchErr } = await ctx.supabase
      .from('supplier_invoices')
      .select(SI_FULL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!original) {
      return v1ErrorResponseFromCode('SI_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    type SupplierObj = { id: string; name: string; supplier_type: string }
    type Original = {
      id: string
      supplier_id: string
      status: string
      currency: string
      exchange_rate: number | null
      subtotal: number
      subtotal_sek: number | null
      vat_amount: number
      vat_amount_sek: number | null
      total: number
      total_sek: number | null
      vat_treatment: string
      reverse_charge: boolean
      remaining_amount: number
      paid_amount: number
      is_credit_note: boolean
      credited_invoice_id: string | null
      supplier_invoice_number: string
      arrival_number: number
      supplier: SupplierObj | SupplierObj[] | null
      items?: Array<{
        sort_order: number
        description: string
        quantity: number
        unit: string
        unit_price: number
        line_total: number
        account_number: string
        vat_code: string | null
        vat_rate: number
        vat_amount: number
        reverse_charge_rate: number | null
      }>
    } & Record<string, unknown>

    const typed = original as unknown as Original

    if (typed.is_credit_note) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Cannot credit a credit note. Reverse from the dashboard instead.' },
      })
    }
    if (typed.status === 'credited') {
      return v1ErrorResponseFromCode('SI_CREDIT_ALREADY_CREDITED', ctx.log, { requestId: ctx.requestId })
    }

    const today = new Date().toISOString().split('T')[0]

    // Pre-flight period-lock on the credit-note invoice_date (today).
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, today)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('SI_CREDIT_PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
        },
      })
    }

    const pickSupplier = (s: Original['supplier']): SupplierObj | null => {
      if (!s) return null
      return Array.isArray(s) ? (s[0] ?? null) : s
    }
    const supplierRow = pickSupplier(typed.supplier)

    if (ctx.dryRun) {
      // The arrival_number isn't allocated in a dry-run (would burn the
      // sequence on a non-commit). The preview reports the count.
      const previewItems = (typed.items ?? []).map((item) => ({
        sort_order: item.sort_order,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        line_total: item.line_total,
        account_number: item.account_number,
        vat_code: item.vat_code,
        vat_rate: item.vat_rate,
        vat_amount: item.vat_amount,
        reverse_charge_rate: item.reverse_charge_rate,
      }))
      return dryRunPreview(
        {
          credit_note: {
            supplier_id: typed.supplier_id,
            supplier_invoice_number: `KREDIT-${typed.supplier_invoice_number}`,
            invoice_date: today,
            due_date: today,
            status: 'registered',
            currency: typed.currency,
            exchange_rate: typed.exchange_rate,
            subtotal: typed.subtotal,
            vat_amount: typed.vat_amount,
            total: typed.total,
            is_credit_note: true,
            credited_invoice_id: typed.id,
            items: previewItems,
          },
          original_will_become: 'credited',
          would_create_reversal_journal_entry: true,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Allocate arrival_number for the credit note.
    const { data: arrivalNum, error: arrivalErr } = await ctx.supabase
      .rpc('get_next_arrival_number', { p_company_id: ctx.companyId! })
    if (arrivalErr || arrivalNum == null) {
      ctx.log.error('arrival_number allocation failed (credit)', (arrivalErr as Error) ?? new Error('null'))
      return v1ErrorResponseFromCode('SI_CREDIT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'arrival_number' },
      })
    }

    // Insert credit-note row.
    const { data: creditNote, error: creditErr } = await ctx.supabase
      .from('supplier_invoices')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        supplier_id: typed.supplier_id,
        arrival_number: arrivalNum,
        supplier_invoice_number: `KREDIT-${typed.supplier_invoice_number}`,
        invoice_date: today,
        due_date: today,
        status: 'registered',
        currency: typed.currency,
        exchange_rate: typed.exchange_rate,
        vat_treatment: typed.vat_treatment,
        reverse_charge: typed.reverse_charge,
        subtotal: typed.subtotal,
        subtotal_sek: typed.subtotal_sek,
        vat_amount: typed.vat_amount,
        vat_amount_sek: typed.vat_amount_sek,
        total: typed.total,
        total_sek: typed.total_sek,
        remaining_amount: 0,
        is_credit_note: true,
        credited_invoice_id: typed.id,
      })
      .select(SI_RESPONSE_COLUMNS)
      .single()

    if (creditErr || !creditNote) {
      ctx.log.error('credit-note insert failed', creditErr as Error, {
        originalId: typed.id,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('SI_CREDIT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'credit_note_insert', pg_code: (creditErr as { code?: string } | null)?.code },
      })
    }

    const creditNoteId = (creditNote as { id: string }).id

    // Copy items.
    const creditItems = (typed.items ?? []).map((item) => ({
      supplier_invoice_id: creditNoteId,
      sort_order: item.sort_order,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: item.line_total,
      account_number: item.account_number,
      vat_code: item.vat_code,
      vat_rate: item.vat_rate,
      vat_amount: item.vat_amount,
      // Preserve the self-assessed RC rate so the credit note reverses fiktiv
      // moms at the same rate the original was booked at.
      reverse_charge_rate: item.reverse_charge_rate,
    }))
    if (creditItems.length > 0) {
      const { error: itemsErr } = await ctx.supabase
        .from('supplier_invoice_items')
        .insert(creditItems)
      if (itemsErr) {
        // items_insert fires before any engine call — no JE could exist.
        await rollbackCreditNote(ctx.supabase, creditNoteId, ctx.companyId!, ctx.log, 'items_insert', false)
        return v1ErrorResponseFromCode('SI_CREDIT_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: { step: 'credit_items_insert', pg_code: (itemsErr as { code?: string }).code },
        })
      }
    }

    // Accrual: post the reversing JE. Cash basis: skip (no original
    // registration entry to reverse; refund is recognized when the bank
    // transaction is booked).
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod = ((settings as { accounting_method?: string } | null)?.accounting_method
      ?? 'accrual') as AccountingMethod

    let journalEntryId: string | null = null
    if (accountingMethod === 'accrual') {
      try {
        const entry = await createSupplierCreditNoteEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          creditNote as unknown as SupplierInvoice,
          creditItems as unknown as SupplierInvoiceItem[],
          supplierRow?.supplier_type ?? 'swedish_business',
          supplierRow?.name,
        )
        if (entry) {
          journalEntryId = entry.id
          const { error: linkErr } = await ctx.supabase
            .from('supplier_invoices')
            .update({ registration_journal_entry_id: entry.id })
            .eq('id', creditNoteId)
            .eq('company_id', ctx.companyId!)
          if (linkErr) {
            // Symmetric with the SI register path: storno the posted JE +
            // roll back the credit note before returning, so we never leave
            // a credit note row with registration_journal_entry_id=null while
            // the reversing JE sits live on the books.
            ctx.log.error('credit-note JE link update failed — stornoing JE and rolling back row', linkErr, {
              creditNoteId,
              originalId: typed.id,
              journalEntryId: entry.id,
              companyId: ctx.companyId,
              userId: ctx.userId,
            })
            try {
              await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, entry.id, today)
            } catch (revErr) {
              ctx.log.error('JE storno failed after credit-note link-update error — manual reconciliation required', revErr as Error, {
                creditNoteId,
                journalEntryId: entry.id,
                userId: ctx.userId,
              })
            }
            // je_link_failed: the credit-note JE was posted (and we just
            // stornoed it above). Soft-mark keeps the trail per BFL 5:5.
            await rollbackCreditNote(ctx.supabase, creditNoteId, ctx.companyId!, ctx.log, 'je_link_failed', true)
            return v1ErrorResponseFromCode('SI_CREDIT_FAILED', ctx.log, {
              requestId: ctx.requestId,
              details: { step: 'credit_journal_entry_link' },
            })
          }
        } else {
          // Engine returned null before posting — no JE exists.
          await rollbackCreditNote(ctx.supabase, creditNoteId, ctx.companyId!, ctx.log, 'no_fiscal_period', false)
          return v1ErrorResponseFromCode('SI_CREDIT_FAILED', ctx.log, {
            requestId: ctx.requestId,
            details: { step: 'credit_journal_entry', reason: 'no_fiscal_period' },
          })
        }
      } catch (err) {
        // Engine threw — conservatively assume the JE may have committed.
        await rollbackCreditNote(ctx.supabase, creditNoteId, ctx.companyId!, ctx.log, 'credit_journal_entry', true)
        if (isBookkeepingError(err)) {
          return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
        }
        ctx.log.error('supplier credit-note JE creation failed', err as Error, {
          creditNoteId,
          originalId: typed.id,
          companyId: ctx.companyId,
        })
        return v1ErrorResponseFromCode('SI_CREDIT_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: { step: 'credit_journal_entry' },
        })
      }
    }

    // Step 5: flip the original to `credited`. CAS guard: only transition
    // from a non-terminal state (avoids a concurrent credit/credit race
    // leaving us with two credit notes against one original).
    //
    // A kreditfaktura nullifies the AP obligation on the original (BFL 5 kap
    // 5 §); refunds of already-paid amounts are recorded separately via the
    // transactions endpoints. So both `remaining_amount` and `status` are set
    // unconditionally — no arithmetic on remaining_amount - total (the prior
    // calc was a logic error: remaining_amount ≤ total, so the result was
    // always ≤ 0, forcing status to 'credited' anyway via the clamp).
    const { data: originalUpdated, error: originalUpdateErr } = await ctx.supabase
      .from('supplier_invoices')
      .update({
        status: 'credited',
        remaining_amount: 0,
      })
      .eq('company_id', ctx.companyId!)
      .eq('id', typed.id)
      // Don't re-credit an already-credited/reversed original.
      .not('status', 'in', '(credited,reversed)')
      .select('id, status, remaining_amount')
      .maybeSingle()

    if (originalUpdateErr) {
      ctx.log.error('original SI status flip to credited failed', originalUpdateErr, {
        originalId: typed.id,
        creditNoteId,
      })
      // Don't roll back the credit note here — the JE exists on the books
      // and rolling back leaves a partial state. Surface the error; manual
      // reconciliation will flip the original.
      return v1ErrorResponseFromCode('SI_CREDIT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'original_status_flip', credit_note_id: creditNoteId, journal_entry_id: journalEntryId },
      })
    }
    if (!originalUpdated) {
      // Race: original was credited/reversed between fetch and update. Roll
      // back the new credit note (and its JE) to avoid a double-credit state.
      ctx.log.warn('credit race detected; rolling back new credit note', {
        originalId: typed.id,
        creditNoteId,
        journalEntryId,
        userId: ctx.userId,
      })
      if (journalEntryId) {
        try {
          await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, journalEntryId, today)
        } catch (revErr) {
          ctx.log.error('orphan credit JE storno failed', revErr as Error, {
            creditNoteId,
            journalEntryId,
            userId: ctx.userId,
          })
        }
      }
      // credit_race: the credit-note JE was posted (and just stornoed above).
      await rollbackCreditNote(ctx.supabase, creditNoteId, ctx.companyId!, ctx.log, 'credit_race', true)
      return v1ErrorResponseFromCode('SI_CREDIT_ALREADY_CREDITED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.credited',
        payload: {
          supplierInvoice: typed as unknown as SupplierInvoice,
          creditNote: creditNote as unknown as SupplierInvoice,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.warn('supplier_invoice.credited emit failed', err as Error)
    }

    return ok(
      {
        credit_note_id: creditNoteId,
        original_id: typed.id,
        arrival_number: (creditNote as { arrival_number: number }).arrival_number,
        supplier_invoice_number: (creditNote as { supplier_invoice_number: string }).supplier_invoice_number,
        registration_journal_entry_id: journalEntryId,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)

async function rollbackCreditNote(
  supabase: SupabaseClient,
  creditNoteId: string,
  companyId: string,
  log: import('@/lib/logger').Logger,
  reason: string,
  journalEntryPosted: boolean,
) {
  // BFL 5 kap 5 § applies once a verifikation has been committed to the
  // books. Pre-JE failures (items_insert, engine-returned-null) are not
  // bokföringsposter and should hard-delete. Post-JE failures soft-mark
  // `'reversed'` so the audit trail of the attempt (and the JE+storno pair
  // on the verifikation side) stays visible.
  if (!journalEntryPosted) {
    await supabase.from('supplier_invoice_items').delete().eq('supplier_invoice_id', creditNoteId)
    const { error: parentErr } = await supabase
      .from('supplier_invoices')
      .delete()
      .eq('id', creditNoteId)
      .eq('company_id', companyId)
    if (parentErr) {
      log.error('credit-note hard-rollback failed — orphan row', parentErr, {
        creditNoteId,
        companyId,
        rollbackReason: reason,
      })
    } else {
      log.warn('credit-note hard-rolled back (no JE existed)', {
        creditNoteId,
        companyId,
        rollbackReason: reason,
      })
    }
    return
  }

  const { error: updateErr } = await supabase
    .from('supplier_invoices')
    .update({ status: 'reversed', reversed_at: new Date().toISOString() })
    .eq('id', creditNoteId)
    .eq('company_id', companyId)
  if (updateErr) {
    log.error('credit-note soft-rollback failed — manual reconciliation required', updateErr, {
      creditNoteId,
      companyId,
      rollbackReason: reason,
    })
  } else {
    log.warn('credit-note soft-rolled back (status=reversed)', {
      creditNoteId,
      companyId,
      rollbackReason: reason,
    })
  }
}
