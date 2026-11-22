import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'
import { loadOpenPaymentInstructions } from '@/lib/supplier-invoices/lifecycle-stages'
import { SETTLED_SUPPLIER_INVOICE_STATUSES } from '@/lib/supplier-invoices/stages'
import { filterSupplierInvoicesByReportedStatus } from '@/lib/supplier-invoices/reported-status'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import type { AttestInvoiceFacts } from '@/lib/supplier-invoices/attest-policy'
import { readAttestHold } from '@/lib/supplier-invoices/attest-hold'
import { isToPayInList, type ListTabInvoice } from '@/lib/supplier-invoices/list-tabs'

export const GET = withRouteContext(
  'supplier_invoice.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const supplierId = searchParams.get('supplier_id')

    // Paged: the list used to end at 1,000 invoices.
    let data: unknown[]
    try {
      // What the attest policy holds back from payment (paymentWaitsForAttest,
      // the payment file's attest_required): each unsettled row says so, and
      // the Att betala tab and to_pay leave those out (lib/supplier-invoices/to-pay.ts).
      // Never throws (a failed read answers "not held"), so it runs beside the list read.
      const waitsForAttestRead = readAttestHold(supabase, companyId)

      data = await fetchAllRows<unknown>(({ from, to }) => {
        let query = supabase
          .from('supplier_invoices')
          .select('*, supplier:suppliers(id, name)')
          .eq('company_id', companyId)

        // Optional narrowing to one supplier: the supplier detail page only
        // needs that supplier's invoices, not the whole company ledger.
        if (supplierId) {
          query = query.eq('supplier_id', supplierId)
        }

        if (status && status !== 'all') {
          if (status === 'to_pay') {
            // The statuses a payment may be made in; isToPayInList below decides.
            query = query.in('status', [...PAYABLE_SUPPLIER_INVOICE_STATUSES]).eq('auto_debit', false)
          } else if (status === 'unsettled') {
            // Everything not yet settled: what the attest, to-pay and
            // in-payment tabs and their counts are read from. The list
            // paints from this read and the settled history follows behind,
            // so a register of thousands of paid invoices no longer holds up
            // the page.
            query = query.not('status', 'in', `(${[...SETTLED_SUPPLIER_INVOICE_STATUSES].join(',')})`)
          } else {
            // approved and overdue are read from the attest mark and the due
            // date, every other status as stored (reported-status.ts).
            query = filterSupplierInvoicesByReportedStatus(query, status)
          }
        }

        return query.order('due_date', { ascending: true }).order('id', { ascending: true }).range(from, to)
      })
      // Each unsettled invoice carries the payment instruction that already
      // covers it (an open bank payment or payment file), read the same way
      // as the lifecycle stage, so a person deciding what to pay sees that a
      // payment is under way (crm#1243). Null when nothing covers it.
      const rows = data as Array<AttestInvoiceFacts & ListTabInvoice & { id: string; approved_at: string | null }>
      const unsettledIds = rows.filter((r) => !SETTLED_SUPPLIER_INVOICE_STATUSES.has(r.status)).map((r) => r.id)
      const [open, waitsForAttest] = await Promise.all([
        loadOpenPaymentInstructions(supabase, companyId, unsettledIds),
        waitsForAttestRead,
      ])
      const listed = rows.map((r) => ({
        ...r,
        open_payment: open.get(r.id) ?? null,
        waits_for_attest: SETTLED_SUPPLIER_INVOICE_STATUSES.has(r.status) ? false : waitsForAttest(r),
      }))
      // to_pay is the Att betala tab, row for row (isToPayInList).
      data = status === 'to_pay' ? listed.filter((r) => isToPayInList(r)) : listed
    } catch (error) {
      log.error('supplier_invoice list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'supplier_invoice.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateSupplierInvoiceSchema, {
      log,
      operation: 'supplier_invoice.create',
    })
    if (!validation.success) return validation.response

    // Every rule lives in the shared service, so this door and the v1 REST
    // door register an invoice the same way (lib/supplier-invoices/create.ts).
    const result = await createSupplierInvoice(
      { supabase, companyId, userId: user.id, log },
      validation.data,
    )
    if (!result.ok) {
      if (result.error) return errorResponse(result.error, log, { requestId })
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }
    if (result.dryRun) {
      // Unreachable: this door never asks for a dry run.
      return NextResponse.json({ data: result.preview })
    }

    return NextResponse.json({
      data: {
        ...result.invoice,
        items: result.items,
        registration_journal_entry_id: result.registrationJournalEntryId,
        payment_journal_entry_id: result.paymentJournalEntryId,
        expense_claim: result.expenseClaim,
      },
      ...(result.warnings.length > 0
        ? { warnings: result.warnings.map((w) => ({ code: w.code, message: w.message_sv })) }
        : {}),
    })
  },
  { requireWrite: true },
)
