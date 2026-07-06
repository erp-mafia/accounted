import { NextResponse } from 'next/server'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { eventBus } from '@/lib/events'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryInput, EntityType, Invoice } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-paid
 *
 * Manually marks an invoice as paid (for payments received outside bank sync).
 *
 * Faktureringsmetoden (accrual): Debit 1930, Credit 1510 (clearing entry)
 * Kontantmetoden (cash):         Debit 1930, Credit 30xx, Credit 26xx
 */
export const POST = withRouteContext(
  'invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Optional body. Backwards-compat: callers may POST with no body.
    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string }[] | undefined
    let force = false
    let rawBody: unknown
    try {
      const text = await request.text()
      if (text) rawBody = JSON.parse(text)
    } catch {
      // Empty / invalid body: fall through to defaults.
    }

    if (rawBody) {
      const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) {
        opLog.warn('mark-paid validation failed', {
          issueCount: parsed.error.issues.length,
        })
        return NextResponse.json(
          { error: 'Ogiltig förfrågan', details: parsed.error.flatten() },
          { status: 400 },
        )
      }
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyPaymentDate = parsed.data.payment_date
      customLines = parsed.data.lines
      force = parsed.data.force === true
    }

    const now = new Date().toISOString()
    const paymentDate = bodyPaymentDate || now.split('T')[0]

    // Duplicate-payment guard: surface a likely-matching unlinked inbound bank
    // transaction before booking. Skipped on partial payments (explicit,
    // deliberate action), on force=true, and on invoices without a resolved
    // customer name. Mirrors the supplier-side guard at
    // /api/supplier-invoices/[id]/mark-paid. The dialog always sends custom
    // lines, so the partial-payment skip is gated on total debit vs remaining,
    // not on the mere presence of customLines.
    const invForRemaining = invoice as Invoice & {
      remaining_amount?: number | null
      paid_amount?: number | null
    }
    const remainingAmount =
      invForRemaining.remaining_amount ?? invoice.total - (invForRemaining.paid_amount ?? 0)
    const paymentAmount = customLines
      ? customLines.reduce((s, l) => s + l.debit_amount, 0)
      : remainingAmount
    const paidRounded = Math.round(paymentAmount * 100) / 100
    const remainingRounded = Math.round(remainingAmount * 100) / 100
    if (!force && paidRounded >= remainingRounded) {
      const customerName = (invoice as Invoice & { customer?: { name?: string } }).customer?.name
      if (!customerName) {
        opLog.warn('duplicate-payment guard skipped', {
          reason: 'missing_customer_name',
          invoiceId: id,
        })
      } else {
        const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId: companyId!,
          invoice: { invoice_number: invoice.invoice_number, customer_name: customerName },
          paymentAmount,
          paymentDate,
        })
        if (candidates.length > 0) {
          return errorResponseFromCode('INVOICE_PAID_LIKELY_DUPLICATE', opLog, {
            requestId,
            details: { candidates },
          })
        }
      }
    } else if (force) {
      opLog.warn('duplicate-payment guard bypassed', {
        reason: 'force=true',
        invoiceId: id,
        userId: user.id,
        paymentAmount,
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    // Drive the JE shape from the invoice's actual booking state, not from
    // the current accounting_method setting. If the invoice was booked at
    // send (Dr 1510 / Cr 30xx + VAT), the payment MUST clear 1510:
    // otherwise the receivable orphans and 30xx + VAT double-count. Only
    // when there is no prior JE (pure kontantmetoden) do we recognise
    // revenue + VAT here.
    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

    // Ledger math + overpayment guard via the shared planInvoicePayment helper:
    // the same single source of truth the match-invoice flow uses, so the three
    // mark-paid surfaces (this route, the v1 API, and the agent commit path)
    // cannot drift again. Runs BEFORE any journal entry is created so a doomed
    // overpayment never burns a voucher number. paymentAmount and the
    // duplicate-payment guard above operate in the booking currency (SEK for
    // custom lines); convert to invoice currency for the ledger comparison so a
    // foreign-currency invoice isn't falsely rejected as overpaid.
    const fxRate =
      invoice.currency && invoice.currency !== 'SEK' && invoice.exchange_rate
        ? invoice.exchange_rate
        : 1
    const paymentAmountInInvoiceCurrency = customLines
      ? roundOre(paymentAmount / fxRate)
      : paymentAmount
    const payment = planInvoicePayment(invoice, paymentAmountInInvoiceCurrency)
    if (!payment.ok) {
      return errorResponseFromCode('MATCH_AMOUNT_EXCEEDS_REMAINING', opLog, {
        requestId,
        details: payment.details,
      })
    }
    const { newPaidAmount, newRemaining, newStatus } = payment.plan

    const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
    let journalEntryId: string | null = null

    if (isRealInvoice) {
      try {
        if (customLines) {
          const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
          const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
          if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
            return errorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', opLog, {
              requestId,
              details: { totalDebit, totalCredit },
            })
          }

          const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, paymentDate)
          if (!fiscalPeriodId) {
            return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', opLog, {
              requestId,
              details: { paymentDate },
            })
          }
          const sourceType = resolveInvoicePaymentSourceType({
            invoiceAlreadyBooked,
            accountingMethod,
          })
          const input: CreateJournalEntryInput = {
            fiscal_period_id: fiscalPeriodId,
            entry_date: paymentDate,
            description: invoice.customer?.name
              ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
              : `Inbetalning kundfaktura ${invoice.invoice_number}`,
            source_type: sourceType,
            source_id: invoice.id,
            lines: customLines,
          }
          const journalEntry = await createJournalEntry(supabase, companyId!, user.id, input)
          journalEntryId = journalEntry?.id ?? null
        } else if (useCashEntry) {
          const journalEntry = await createInvoiceCashEntry(
            supabase, companyId!, user.id, invoice as Invoice, paymentDate,
            entityType, invoice.customer?.name,
          )
          journalEntryId = journalEntry?.id ?? null
        } else {
          const journalEntry = await createInvoicePaymentJournalEntry(
            supabase, companyId!, user.id, invoice as Invoice, paymentDate,
            exchangeRateDifference, invoice.customer?.name,
          )
          journalEntryId = journalEntry?.id ?? null
        }
      } catch (err) {
        if (isBookkeepingError(err)) {
          return errorResponse(err, opLog, { requestId })
        }
        opLog.error('failed to create payment journal entry', err as Error)
        return errorResponseFromCode('INVOICE_PAID_BOOK_FAILED', opLog, {
          requestId,
          details: { reason: err instanceof Error ? err.message : 'unknown' },
        })
      }

      // Fail closed: a real invoice must produce a payment voucher. If a helper
      // returned null without throwing (e.g. a closed/locked fiscal period),
      // refuse to mark the invoice paid: flipping status with no journal entry
      // orphans the receivable and diverges the GL from the sub-ledger.
      if (!journalEntryId) {
        opLog.error('mark-paid produced no journal entry; refusing to mark paid', undefined, {
          invoiceId: id,
        })
        return errorResponseFromCode('INVOICE_PAID_BOOK_FAILED', opLog, {
          requestId,
          details: { reason: 'no_journal_entry_created' },
        })
      }
    }

    // CAS guard: only update if status is still in a payable state.
    const { data: updateResult, error: updateError } = await supabase
      .from('invoices')
      .update({
        status: newStatus,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        ...(newStatus === 'paid' ? { paid_at: now } : {}),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .select('id')

    if (updateError) {
      opLog.error('failed to update invoice status', updateError)
      // The payment voucher already posted but the invoice row did not flip to
      // paid; cancel the orphan so the GL doesn't diverge from the sub-ledger.
      if (journalEntryId) {
        await cancelOrphanedPaymentEntry(
          supabase,
          companyId!,
          user.id,
          journalEntryId,
          'Automatiskt makulerad: fakturauppdatering misslyckades efter bokförd betalning',
        )
      }
      return errorResponse(updateError, opLog, { requestId })
    }

    if (!updateResult || updateResult.length === 0) {
      // Status changed between read and write (concurrent settle): cancel the
      // orphaned payment voucher and document the voucher gap before reporting.
      if (journalEntryId) {
        await cancelOrphanedPaymentEntry(
          supabase,
          companyId!,
          user.id,
          journalEntryId,
          'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
        )
      }
      return errorResponseFromCode('INVOICE_PAID_RACE', opLog, { requestId })
    }

    // Notify subscribers: invoice.paid fans out to registered webhooks
    // (lib/webhooks/handler.ts). Best-effort: the payment is already committed,
    // so an emit failure must not fail the request. Mirrors the v1 route.
    try {
      await eventBus.emit({
        type: 'invoice.paid',
        payload: {
          invoice: {
            ...(invoice as Invoice),
            status: newStatus,
            paid_amount: newPaidAmount,
            remaining_amount: newRemaining,
            paid_at: newStatus === 'paid' ? now : (invoice as Invoice).paid_at,
          } as Invoice,
          companyId: companyId!,
          userId: user.id,
          paymentAmount: paymentAmountInInvoiceCurrency,
          paymentDate,
        },
      })
    } catch (err) {
      opLog.error('invoice.paid emit failed', err as Error, { invoiceId: id })
    }

    return NextResponse.json({
      success: true,
      status: newStatus,
      paid_at: newStatus === 'paid' ? now : null,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
    })
  },
  { requireWrite: true },
)
