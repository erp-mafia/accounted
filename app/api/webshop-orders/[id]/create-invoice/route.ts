import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateInvoiceFromWebshopOrderSchema } from '@/lib/api/schemas'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { roundOre } from '@/lib/money'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Currency, Customer, Invoice, WebshopOrder } from '@/types'

ensureInitialized()

/**
 * Convert one webshop order into a pre-filled DRAFT kundfaktura. Manual,
 * per-order, never automatic (invoice-of-record stays the user's decision):
 * the user reviews the draft and sends it through the normal invoice flow,
 * which also books it. Follows the invoice-inbox convert pattern: guard
 * already-converted, map items, reuse the shared invoice write path, link
 * back, roll back the draft if the link-back fails.
 *
 * Numbering: none here (unnumbered draft, save_as_draft semantics). The
 * F-number is allocated at finalize/send, so an abandoned draft can be
 * hard-deleted without an F-series gap (ML 17 kap 24§).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.create_invoice',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CreateInvoiceFromWebshopOrderSchema)
    if (!validation.success) return validation.response
    const { customer_id } = validation.data

    const { data: order, error: fetchError } = await supabase
      .from('webshop_orders')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single<WebshopOrder>()

    if (fetchError || !order) {
      return errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId })
    }
    if (order.invoice_id) {
      return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_INVOICED', log, {
        requestId,
        details: { invoice_id: order.invoice_id },
      })
    }
    if (order.journal_entry_id) {
      return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_BOOKED', log, {
        requestId,
        details: { journal_entry_id: order.journal_entry_id },
      })
    }
    // Refund rows never convert (kreditfaktura is created from the invoice).
    if (order.row_type === 'refund') {
      return errorResponseFromCode('WEBSHOP_ORDER_REFUND_PARENT_INVOICED', log, { requestId })
    }
    // Same legacy double-booking lock as the book route: an invoice created
    // for a sale whose feed row is later booked in the transactions inbox
    // would double-count the revenue. An ignored feed row unlocks the path.
    if (order.legacy_transaction_id) {
      const { data: legacyTxn } = await supabase
        .from('transactions')
        .select('id, journal_entry_id, is_ignored')
        .eq('id', order.legacy_transaction_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (legacyTxn) {
        if (legacyTxn.journal_entry_id) {
          return errorResponseFromCode('WEBSHOP_ORDER_LEGACY_TRANSACTION_BOOKED', log, {
            requestId,
            details: { transaction_id: legacyTxn.id },
          })
        }
        if (!legacyTxn.is_ignored) {
          return errorResponseFromCode('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN', log, {
            requestId,
            details: { transaction_id: legacyTxn.id },
          })
        }
      }
    }

    // Resolve the customer: explicit id, else match by email within the
    // company, else create from the order's billing snapshot. The orgnr is
    // best-effort scraped data and is deliberately NOT written to a customer
    // the user did not review; it rides along in notes for the review step.
    let customer: Customer | null = null
    if (customer_id) {
      const { data } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customer_id)
        .eq('company_id', companyId)
        .single<Customer>()
      if (!data) {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', log, {
          requestId,
          details: { customerId: customer_id },
        })
      }
      customer = data
    } else {
      if (order.customer_email) {
        const { data } = await supabase
          .from('customers')
          .select('*')
          .eq('company_id', companyId)
          .ilike('email', order.customer_email)
          .limit(1)
          .maybeSingle<Customer>()
        customer = data ?? null
      }
      if (!customer) {
        const name = order.customer_company || order.customer_name
        if (!name) {
          return errorResponseFromCode('WEBSHOP_ORDER_CREATE_INVOICE_MISSING_CUSTOMER', log, {
            requestId,
          })
        }
        const { data: created, error: createError } = await supabase
          .from('customers')
          .insert({
            company_id: companyId,
            user_id: user.id,
            name,
            customer_type: order.customer_company ? 'business' : 'individual',
            contact_person: order.customer_company ? order.customer_name : null,
            email: order.customer_email,
            org_number: order.customer_orgnr,
          })
          .select('*')
          .single<Customer>()
        if (createError || !created) {
          log.error('failed to create customer from webshop order', createError ?? undefined, {
            orderId: id,
          })
          return errorResponseFromCode('WEBSHOP_ORDER_CREATE_INVOICE_CUSTOMER_FAILED', log, {
            requestId,
          })
        }
        customer = created
        try {
          await eventBus.emit({
            type: 'customer.created',
            payload: { customer, userId: user.id, companyId },
          })
        } catch {
          // Non-critical
        }
      }
    }

    // Items from the order's line snapshot (products + shipping + fees; the
    // sync stores everything inside order.total). vat_rate null maps to the
    // order's DOMINANT rate bucket so a tax-detail-stripped store does not
    // silently fall through to the customer-type default rate. Where the net
    // does not divide evenly by the quantity, the line collapses to quantity
    // 1 at its exact total: buildInvoiceWriteData recomputes
    // line_total = quantity * unit_price, and an öre of division drift would
    // make the invoice total diverge from what the customer actually paid.
    const dominantRate =
      order.vat_breakdown.length > 0
        ? [...order.vat_breakdown].sort(
            (a, b) => Math.abs(b.net) - Math.abs(a.net),
          )[0].rate
        : undefined
    const items: InvoiceWriteInput['items'] =
      order.line_items.length > 0
        ? order.line_items.map((item) => {
            const unitPrice =
              item.quantity > 0 ? roundOre(item.total / item.quantity) : item.total
            const dividesEvenly =
              item.quantity > 0 && roundOre(unitPrice * item.quantity) === item.total
            return dividesEvenly
              ? {
                  description: item.name,
                  quantity: item.quantity,
                  unit: 'st',
                  unit_price: unitPrice,
                  vat_rate: item.vat_rate ?? dominantRate,
                }
              : {
                  description:
                    item.quantity > 1 ? `${item.name} (${item.quantity} st)` : item.name,
                  quantity: 1,
                  unit: 'st',
                  unit_price: item.total,
                  vat_rate: item.vat_rate ?? dominantRate,
                }
          })
        : [
            {
              description: `Order ${order.order_number}`,
              quantity: 1,
              unit: 'st',
              unit_price: roundOre(order.total - order.total_tax),
              vat_rate: dominantRate,
            },
          ]

    const invoiceDate = new Date().toISOString().split('T')[0]
    const paymentTermsDays = customer.default_payment_terms ?? 30
    const due = new Date()
    due.setDate(due.getDate() + paymentTermsDays)
    const dueDate = due.toISOString().split('T')[0]

    const input: InvoiceWriteInput = {
      customer_id: customer.id,
      invoice_date: invoiceDate,
      due_date: dueDate,
      currency: order.currency.toUpperCase() as Currency,
      your_reference: order.customer_name ?? undefined,
      notes: `Webshoporder ${order.order_number} (${order.store_label || order.store_scope})`,
      items,
    }

    const build = await buildInvoiceWriteData({
      supabase,
      companyId,
      customer,
      documentType: 'invoice',
      input,
    })
    if (!build.ok) {
      if ('dbError' in build) {
        log.error('invoice write build failed on a DB lookup', build.dbError as Error)
        return errorResponse(build.dbError, log, { requestId })
      }
      return errorResponseFromCode(build.code, log, { requestId, details: build.details })
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .insert({
        user_id: user.id,
        company_id: companyId,
        invoice_number: null,
        ...build.invoiceFields,
      })
      .select()
      .single()

    if (invoiceError || !invoice) {
      log.error('invoice insert from webshop order failed', invoiceError ?? undefined)
      return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', log, {
        requestId,
        details: { pgCode: invoiceError?.code },
      })
    }

    const itemRows = build.items.map((item) => ({ ...item, invoice_id: invoice.id }))
    const { error: itemsError } = await supabase.from('invoice_items').insert(itemRows)
    if (itemsError) {
      await supabase.from('invoices').delete().eq('id', invoice.id)
      log.error('invoice items insert failed; rolled back draft', itemsError, {
        invoiceId: invoice.id,
      })
      return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, {
        requestId,
        details: { pgCode: itemsError.code },
      })
    }

    // Link back; roll back the draft on failure so no orphan invoice exists
    // without its order marked (unnumbered draft: hard delete leaves no gap).
    const { error: linkError } = await supabase
      .from('webshop_orders')
      .update({ invoice_id: invoice.id })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('invoice_id', null)
    if (linkError) {
      await supabase.from('invoice_items').delete().eq('invoice_id', invoice.id)
      await supabase.from('invoices').delete().eq('id', invoice.id)
      log.error('order link-back failed; rolled back draft invoice', linkError, {
        orderId: id,
        invoiceId: invoice.id,
      })
      return errorResponse(linkError, log, { requestId })
    }

    try {
      await eventBus.emit({
        type: 'invoice.created',
        payload: { invoice: invoice as Invoice, userId: user.id, companyId },
      })
    } catch {
      // Non-critical
    }

    return NextResponse.json({ data: invoice, invoice_id: invoice.id, success: true })
  },
  { requireWrite: true },
)
