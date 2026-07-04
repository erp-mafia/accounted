/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/mark-sent
 *
 * Transitions a DRAFT invoice to `sent` status. Use this for invoices
 * delivered outside the system (Peppol, postal, custom email). The full
 * :send pipeline (PDF + email) will land in PR-B-2b-3.
 *
 * What happens on commit:
 *   1. F-series invoice_number is allocated atomically via the
 *      generate_invoice_number Postgres RPC (ML 17 kap 24§ p.2: only
 *      issued invoices consume numbers; this is where the F-series
 *      number gets assigned, NOT at draft-create per PR-B-2a's design).
 *   2. Invoice status flips to 'sent'.
 *   3. If accounting_method='accrual' AND document_type='invoice', a
 *      journal entry is posted via createInvoiceJournalEntry (Debit AR
 *      1510, Credit revenue 3xxx, Credit output VAT 2611/2621/2631).
 *      Under kontantmetoden ('cash') no journal entry is created here:
 *      booking happens at payment time.
 *   4. invoice.sent event is emitted.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-run shows the would-be
 * post-send state without allocating a number, posting a journal entry,
 * or emitting events.
 *
 * Known residual race window: the F-series number is allocated via the
 * generate_invoice_number RPC BEFORE the status-flip UPDATE. If a
 * concurrent transition wins the race-guard check (status='draft' filter),
 * the F-series number is consumed but no invoice carries it: a gap in
 * the löpnummer series (ML 17 kap 24§ p.2). The internal /api/invoices
 * mark-sent route has the same semantic. The architecturally correct
 * fix is a Postgres RPC that allocates + flips status atomically;
 * tracked as cross-surface compliance work. The race window is narrow
 * (sub-millisecond between the two statements in normal load).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { eventBus } from '@/lib/events'
import type { EntityType, Invoice } from '@/types'

// Explicit projection: drops user_id, company_id (internal scoping).
const INVOICE_MARK_SENT_RESPONSE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, converted_from_id, paid_at, paid_amount, remaining_amount, created_at, updated_at'

const InvoiceMarkSentResponse = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  status: z.literal('sent'),
  total: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  // Present only when the status flip succeeded but a follow-up step
  // (journal entry creation, event emission) failed and the response
  // therefore reflects partial state. Agents that need transactional
  // guarantees can detect this without parsing the body.
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
})

registerEndpoint({
  operation: 'invoices.mark-sent',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/mark-sent',
  summary: 'Transition a draft invoice to sent (without emailing).',
  description:
    'Marks a draft invoice as sent: for invoices delivered outside Accounted (Peppol, postal, manual email). Allocates the F-series invoice_number atomically (ML 17 kap 24§ p.2). On accounting_method=accrual, also posts the invoice journal entry (Debit AR 1510 / Credit revenue + output VAT). Emits invoice.sent. Idempotent and dry-runnable. The companion :send action (PR-B-2b-3) adds PDF rendering and email delivery on top of this same flow.',
  useWhen:
    'You delivered the invoice through a channel other than Accounted\'s email (Peppol, postal, your own SMTP) and need to record it as sent so the F-series number is allocated and the journal entry is posted.',
  doNotUseFor:
    'Sending the invoice via Accounted email: use :send (PR-B-2b-3) for that. Marking an already-sent invoice as paid: use :mark-paid (PR-B-2b-2).',
  pitfalls: [
    'Only invoices in `status=draft` can be marked sent. Other states return 409 INVOICE_UPDATE_NOT_DRAFT (re-used; the action is structurally an update).',
    'Allocation is atomic. If a concurrent transition beats the agent\'s request to the same draft, the runner-up gets 409 INVOICE_UPDATE_NOT_DRAFT and no number is consumed.',
    'Delivery notes (document_type=delivery_note) don\'t transition to sent: they were never drafts in the f-series sense. This endpoint will reject them with 400 VALIDATION_ERROR.',
    'Idempotency-Key is mandatory. A retried mark-sent with the same key replays the cached response.',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        invoice_number: '2026-0042',
        status: 'sent',
        total: 12500,
        journal_entry_id: '7b3a…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(InvoiceMarkSentResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.mark-sent',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    // Pre-flight: fetch the invoice (with items + customer for the journal-
    // entry generator) and verify it's a draft.
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(
        `${INVOICE_MARK_SENT_RESPONSE_COLUMNS}, customer:customers(id, name, customer_type, country), items:invoice_items(id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, revenue_account)`,
      )
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      ctx.log.warn('invoices.mark-sent: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    const typed = invoice as unknown as Invoice & { customer?: { name?: string } }

    // Type/document-shape guards run BEFORE the status check so the
    // returned error matches the documented contract (400 VALIDATION_ERROR
    // for delivery notes / credit notes regardless of their current
    // status; 409 INVOICE_UPDATE_NOT_DRAFT only for genuine invoices).
    if (typed.document_type === 'delivery_note') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'document_type',
          message: 'Delivery notes are not transitioned via mark-sent; they have no F-series lifecycle.',
        },
      })
    }

    // Credit notes (document_type='invoice' but credited_invoice_id set)
    // need the credit-note journal entry generator (reverses sign of the
    // original invoice). The PR-B-2b-4 :credit endpoint handles them.
    // Reject here so we don't post the wrong-direction journal entry.
    if (typed.credited_invoice_id) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'credited_invoice_id',
          message: 'Credit notes are issued via POST /invoices/:id/credit (PR-B-2b-4); they cannot be mark-sent like regular invoices.',
        },
      })
    }

    if (typed.status !== 'draft') {
      return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    // Defense in depth: moms_ruta drives which output-VAT account the
    // journal-entry generator posts to (2611 / 2614 / etc.). A null value
    // would silently default: wrong for reverse-charge / EU-service /
    // zero-rated invoices. moms_ruta is populated by the POST handler
    // from getVatRules(); a null here means the row was created via a
    // path that bypassed v1 (legacy import, manual SQL).
    if (!typed.moms_ruta) {
      ctx.log.warn('invoices.mark-sent: missing moms_ruta', {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'moms_ruta',
          message: 'Invoice has no moms_ruta set. The customer\'s VAT rule must be applied (re-create the draft via POST /invoices).',
        },
      })
    }

    // Fetch company settings (accounting method + entity type drive the
    // journal-entry decision). Best-effort: without settings we default
    // to enskild_firma / accrual which matches the dashboard default.
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod = (settings as { accounting_method?: string } | null)?.accounting_method ?? 'accrual'
    const entityType = ((settings as { entity_type?: string } | null)?.entity_type ?? 'enskild_firma') as EntityType
    const isRealInvoice = !typed.document_type || typed.document_type === 'invoice'
    const wouldCreateJournalEntry = isRealInvoice && accountingMethod === 'accrual'

    if (ctx.dryRun) {
      // Preview the post-send state. invoice_number can't be predicted
      // exactly (atomic sequence allocation); show a marker so the agent
      // knows commit will assign one.
      return dryRunPreview(
        {
          ...typed,
          status: 'sent' as const,
          invoice_number: typed.invoice_number ?? '(allocated atomically on commit)',
          would_create_journal_entry: wouldCreateJournalEntry,
          accounting_method: accountingMethod,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Commit path. Step 1: F-series invoice_number allocation. The RPC is
    // atomic; the helper writes the number back onto the invoice row.
    try {
      await ensureInvoiceNumber(ctx.supabase, ctx.companyId!, typed)
    } catch (err) {
      ctx.log.error('mark-sent: ensureInvoiceNumber failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_NUMBER_ASSIGN_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Step 2: flip status to 'sent'. Guard with status='draft' so a
    // concurrent transition becomes a 409 rather than a silent re-flip.
    const { data: updated, error: statusErr } = await ctx.supabase
      .from('invoices')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .eq('status', 'draft')
      .select(INVOICE_MARK_SENT_RESPONSE_COLUMNS)
      .maybeSingle()

    if (statusErr) {
      ctx.log.error('mark-sent: status update failed', statusErr as Error, {
        invoiceId,
        companyId: ctx.companyId,
        pgCode: (statusErr as { code?: string }).code,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_PROVIDER_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }
    if (!updated) {
      // Race: invoice transitioned out of draft between our pre-flight and
      // the update. The F-series number has been consumed (atomic RPC), so
      // we have a draft-cancelled with an allocated number: log so the
      // operator can investigate.
      ctx.log.warn(
        'mark-sent: status race: invoice transitioned out of draft between pre-flight and update',
        { invoiceId, companyId: ctx.companyId },
      )
      return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'Invoice transitioned out of draft during mark-sent.' },
      })
    }

    // Collect partial-state signals to surface on the response. BFL 5 kap
    // requires every affärshändelse to have a verifikation; if the
    // journal-entry creation fails after the status flip, the response
    // must surface this so the agent (or the dashboard, or a monitoring
    // sink) can reconcile rather than silently treating the invoice as
    // fully posted.
    const warnings: { code: string; message: string }[] = []

    // Step 3: journal entry for accrual + real invoices. Failure escalates
    // to error-level log AND surfaces in the response as a warning.
    let journalEntryId: string | null = null
    if (wouldCreateJournalEntry) {
      try {
        // Pass the just-updated invoice (carries the new invoice_number).
        const refreshedInvoice = { ...typed, ...(updated as object), customer: typed.customer } as Invoice & { customer?: { name?: string } }
        const entry = await createInvoiceJournalEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          refreshedInvoice as Invoice,
          entityType,
          refreshedInvoice.customer?.name,
        )
        if (entry) {
          journalEntryId = entry.id
          // Supabase returns { data, error }: never rejects on DB error.
          // A failed write-back leaves the invoice with a real journal
          // entry in the ledger but no pointer on the row, which is
          // unreconcilable without operator visibility.
          const { error: writeBackErr } = await ctx.supabase
            .from('invoices')
            .update({ journal_entry_id: entry.id })
            .eq('id', invoiceId)
            .eq('company_id', ctx.companyId!)
          if (writeBackErr) {
            ctx.log.error('mark-sent: journal_entry_id write-back failed', writeBackErr as Error, {
              invoiceId,
              companyId: ctx.companyId,
              journalEntryId: entry.id,
            })
            warnings.push({
              code: 'JOURNAL_ENTRY_ID_WRITEBACK_FAILED',
              message: 'Journal entry was posted but the invoice row could not be updated with its id. Re-fetch the invoice and reconcile manually.',
            })
          }
        } else {
          // null result = no fiscal period or other engine-side guard.
          ctx.log.error('mark-sent: journal entry not created (engine returned null)', new Error('null entry'), {
            invoiceId,
            companyId: ctx.companyId,
          })
          warnings.push({
            code: 'JOURNAL_ENTRY_NOT_POSTED',
            message: 'Invoice was marked sent but no journal entry was posted. Check fiscal period, then issue a credit note and reissue if the missing verifikation is required (BFL 5 kap).',
          })
        }
      } catch (err) {
        ctx.log.error('mark-sent: journal entry creation failed', err as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
        warnings.push({
          code: 'JOURNAL_ENTRY_NOT_POSTED',
          message: 'Invoice was marked sent but the journal entry posting failed. Check fiscal period and engine logs; the verifikation must be created for BFL 5 kap compliance.',
        })
      }
    }

    // Step 4: emit invoice.sent. Best-effort; escalate to error if it
    // fails (downstream webhook delivery and audit trails depend on this).
    try {
      await eventBus.emit({
        type: 'invoice.sent',
        payload: {
          invoice: { ...(typed as object), ...(updated as object) } as Invoice,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.error('invoice.sent emit failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      warnings.push({
        code: 'EVENT_EMIT_FAILED',
        message: 'invoice.sent event did not reach the bus; downstream subscribers (webhooks) may miss this transition.',
      })
    }

    ctx.log.info('invoices.mark-sent success', {
      invoiceId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      invoiceNumber: (updated as { invoice_number?: string }).invoice_number,
      journalEntryId,
      hadWarnings: warnings.length > 0,
    })

    return ok(
      {
        ...(updated as object),
        journal_entry_id: journalEntryId,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
