import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { InvoicesBulkBookSchema } from '@/lib/api/schemas'
import { issueAndBookInvoice, type IssuableInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import {
  bookInvoiceDeferred,
  INVOICE_BOOKABLE_STATUSES,
} from '@/lib/invoices/book-invoice-deferred'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { CompanySettings, EntityType } from '@/types'

ensureInitialized()

interface BulkBookItemResult {
  id: string
  status: 'booked' | 'failed'
  journal_entry_id?: string | null
  error_code?: string
  /** Swedish user-facing message; raw errors stay in logs. */
  error?: string
}

function failItem(id: string, errorCode: string): BulkBookItemResult {
  return {
    id,
    status: 'failed',
    error_code: errorCode,
    error: getErrorEntry(errorCode)?.message_sv ?? 'Något gick fel. Försök igen.',
  }
}

/**
 * POST /api/invoices/bulk-book
 *
 * One "Bokför" click for many customer invoices (MCP-created invoices land as
 * drafts that used to need individual issuance). Per invoice:
 *   - draft            → issueAndBookInvoice(): F-number + mark sent (NO
 *                        email) + revenue verifikat. Exactly the mark-sent
 *                        semantics; only when the company books at issue,
 *                        deferred-booking companies get a per-item error
 *                        instead of a silent issuance.
 *   - sent/overdue,
 *     unbooked         → bookInvoiceDeferred(): the /book semantics
 *                        (CAS-guarded claim).
 *   - anything else    → per-item error.
 *
 * The loop is sequential on purpose: commit_journal_entry assigns voucher
 * numbers atomically per call, so a serial loop keeps them gap-free and in
 * order. Failures never abort the batch; each item reports its own outcome.
 */
export const POST = withRouteContext(
  'invoice.bulk_book',
  async (request, { user, supabase, companyId, log, requestId }) => {
    const validated = await validateBody(request, InvoicesBulkBookSchema)
    if (!validated.success) return validated.response
    const { ids } = validated.data

    // One settings read for the whole batch: issuance needs the full row
    // (payment accounts + PDF branding), booking needs method + entity type.
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single()
    if (settingsError || !settings) {
      return errorResponseFromCode('INVOICE_SEND_COMPANY_SETTINGS_MISSING', log, { requestId })
    }
    // Under kontantmetoden nothing books before payment, so the whole request
    // is a no-op: reject it instead of issuing drafts nobody asked to send.
    if ((settings.accounting_method || 'accrual') !== 'accrual') {
      return errorResponseFromCode('INVOICE_BOOK_CASH_METHOD', log, { requestId })
    }
    const entityType =
      ((settings as Partial<CompanySettings>).entity_type as EntityType) || 'enskild_firma'

    const { data: invoices, error: fetchError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .in('id', ids)
      .eq('company_id', companyId)
    if (fetchError) {
      log.error('failed to fetch invoices for bulk book', fetchError)
      return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
    }

    const invoicesById = new Map(
      ((invoices ?? []) as IssuableInvoice[]).map((invoice) => [invoice.id, invoice]),
    )
    const results: BulkBookItemResult[] = []

    // Dedupe: the loop's already-booked checks read the pre-loop snapshot, so
    // a repeated id would pass them twice and commit a second voucher that the
    // CAS claim then cancels (a cancelled verifikat + gap explanation per
    // duplicate). Each unique id is processed exactly once.
    const uniqueIds = [...new Set(ids)]

    for (const id of uniqueIds) {
      const invoice = invoicesById.get(id)
      if (!invoice) {
        results.push(failItem(id, 'INVOICE_NOT_FOUND'))
        continue
      }

      const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
      if (!isRealInvoice || invoice.credited_invoice_id) {
        results.push(failItem(id, 'INVOICE_BOOK_NOT_BOOKABLE'))
        continue
      }

      if (invoice.status === 'draft') {
        // Deferred-booking companies (#967) issue via mark-sent and book via
        // the explicit /book step. issueAndBookInvoice would consume an
        // F-number and flip the draft to sent WITHOUT booking anything, an
        // irreversible side effect nobody asked for, so the item fails
        // before the invoice is touched.
        if (!booksInvoicesOnIssue(settings)) {
          results.push(failItem(id, 'INVOICE_BOOK_DEFERRED_DRAFT'))
          continue
        }
        const result = await issueAndBookInvoice({
          supabase,
          companyId,
          userId: user.id,
          invoice,
          settings: settings as CompanySettings,
          log,
        })
        if (!result.ok) {
          results.push(failItem(id, result.errorCode))
        } else {
          results.push({ id, status: 'booked', journal_entry_id: result.journalEntryId })
        }
        continue
      }

      if (INVOICE_BOOKABLE_STATUSES.includes(invoice.status)) {
        // Worklist-canonical unbooked predicate: journal_entry_id IS NULL.
        if (invoice.journal_entry_id) {
          results.push(failItem(id, 'INVOICE_BOOK_ALREADY_BOOKED'))
          continue
        }
        const result = await bookInvoiceDeferred({
          supabase,
          companyId,
          userId: user.id,
          invoice,
          entityType,
          log,
        })
        if (!result.ok) {
          if (result.kind === 'domain') {
            const code = (result.error as { code?: string } | null)?.code
            results.push({
              id,
              status: 'failed',
              ...(code ? { error_code: code } : {}),
              error: getErrorMessage(result.error),
            })
          } else {
            results.push(failItem(id, result.errorCode))
          }
        } else {
          results.push({ id, status: 'booked', journal_entry_id: result.journalEntryId })
        }
        continue
      }

      results.push(failItem(id, 'INVOICE_BOOK_INVALID_STATUS'))
    }

    const summary = {
      total: results.length,
      booked: results.filter((r) => r.status === 'booked').length,
      failed: results.filter((r) => r.status === 'failed').length,
    }

    return NextResponse.json({ data: { results, summary } })
  },
  { requireWrite: true },
)
