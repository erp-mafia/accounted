import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateCustomerSchema } from '@/lib/api/schemas'
import { validateVatNumber } from '@/lib/vat/vies-client'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Customer } from '@/types'
import { encryptCustomerPersonalNumber, maskCustomerRow } from '@/lib/customers/protect-personal-number'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveDefaultPaymentTerms } from '@/lib/customers/default-payment-terms'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const GET = withRouteContext(
  'customer.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    // Paginated: PostgREST caps an unranged select at 1000 rows, which would
    // hand the roster page a silently truncated customer list. Ordered on the
    // PK because paging is only stable under a unique total order; the
    // name sort callers expect is re-applied below.
    //
    // Archived rows (soft-deleted via the v1 API) stay in the table for BFL
    // retention but are not part of the roster: same canonical
    // `archived_at IS NULL` filter as the v1 list route.
    let rows: Customer[]
    try {
      rows = await fetchAllRows<Customer>(
        ({ from, to }) =>
          supabase
            .from('customers')
            .select('*')
            .eq('company_id', companyId)
            .is('archived_at', null)
            .order('id', { ascending: true })
            .range(from, to),
        { dedupeBy: (row) => row.id },
      )
    } catch (error) {
      log.error('customer list failed', error as Error)
      return errorResponse(error, log, { requestId })
    }

    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'sv'))

    return NextResponse.json({ data: rows.map(maskCustomerRow) })
  },
)

export const POST = withRouteContext(
  'customer.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, CreateCustomerSchema, {
      log,
      operation: 'customer.create',
    })
    if (!result.success) return result.response
    const body = result.data

    // Unset payment terms follow the company's own default, not a hardcoded 30.
    const defaultPaymentTerms = await resolveDefaultPaymentTerms(
      supabase,
      companyId!,
      body.default_payment_terms,
    )

    const { data, error } = await supabase
      .from('customers')
      .insert({
        user_id: user.id,
        company_id: companyId,
        name: body.name,
        customer_type: body.customer_type,
        customer_number: body.customer_number || null,
        contact_person: body.contact_person ?? null,
        email: body.email,
        phone: body.phone,
        invoice_email_cc_addresses: body.invoice_email_cc_addresses ?? null,
        invoice_email_bcc_addresses: body.invoice_email_bcc_addresses ?? null,
        address_line1: body.address_line1,
        address_line2: body.address_line2,
        postal_code: body.postal_code,
        city: body.city,
        country: body.country ?? 'SE',
        org_number: body.org_number,
        vat_number: body.vat_number,
        personal_number: encryptCustomerPersonalNumber(body.personal_number),
        language: body.language || 'sv',
        default_payment_terms: defaultPaymentTerms,
        notes: body.notes,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('CUSTOMER_DUPLICATE_ORG_NUMBER', log, {
          requestId,
          details: { orgNumber: body.org_number },
        })
      }
      log.error('customer insert failed', error)
      return errorResponseFromCode('CUSTOMER_CREATE_FAILED', log, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    // Auto-validate VAT number for EU business customers (non-blocking).
    if (body.customer_type === 'eu_business' && body.vat_number) {
      try {
        const vatResult = await validateVatNumber(body.vat_number)
        if (vatResult.valid) {
          await supabase
            .from('customers')
            .update({
              vat_number_validated: true,
              vat_number_validated_at: new Date().toISOString(),
            })
            .eq('id', data.id)
            .eq('company_id', companyId)

          data.vat_number_validated = true
          data.vat_number_validated_at = new Date().toISOString()
        }
      } catch (err) {
        log.warn('auto-VIES validation failed on customer create', err as Error, {
          customerId: data.id,
        })
      }
    }

    const safeCustomer = maskCustomerRow(data)
    await eventBus.emit({
      type: 'customer.created',
      payload: { customer: safeCustomer as Customer, companyId: companyId!, userId: user.id },
    })

    return NextResponse.json({ data: safeCustomer })
  },
  { requireWrite: true },
)
