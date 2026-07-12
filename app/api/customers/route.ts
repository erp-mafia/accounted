import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateCustomerSchema } from '@/lib/api/schemas'
import { validateVatNumber } from '@/lib/vat/vies-client'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Customer } from '@/types'

ensureInitialized()

export const GET = withRouteContext(
  'customer.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('company_id', companyId)
      .order('name', { ascending: true })

    if (error) {
      log.error('customer list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
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

    const { data, error } = await supabase
      .from('customers')
      .insert({
        user_id: user.id,
        company_id: companyId,
        name: body.name,
        customer_type: body.customer_type,
        customer_number: body.customer_number || null,
        email: body.email,
        phone: body.phone,
        address_line1: body.address_line1,
        address_line2: body.address_line2,
        postal_code: body.postal_code,
        city: body.city,
        country: body.country || 'Sweden',
        org_number: body.org_number,
        vat_number: body.vat_number,
        language: body.language || 'sv',
        default_payment_terms: body.default_payment_terms || 30,
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
        details: { reason: error.message },
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

    await eventBus.emit({
      type: 'customer.created',
      payload: { customer: data as Customer, companyId: companyId!, userId: user.id },
    })

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
