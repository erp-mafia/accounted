import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { UpdateCustomerSchema } from '@/lib/api/schemas'
import { validateVatNumber } from '@/lib/vat/vies-client'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  encryptCustomerPersonalNumber,
  maskCustomerIdentifiers,
} from '@/lib/customers/protect-personal-number'
import { resolveCustomerIdentifiers } from '@/lib/customers/identifiers'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext(
  'customer.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('customer fetch failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, due_date, status, total, currency')
      .eq('customer_id', id)
      .eq('company_id', companyId)
      .order('invoice_date', { ascending: false })

    return NextResponse.json({
      data: { ...maskCustomerIdentifiers(data), invoices: invoices || [] },
    })
  },
)

export const PATCH = withRouteContext(
  'customer.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const result = await validateBody(request, UpdateCustomerSchema, {
      log: opLog,
      operation: 'customer.update',
    })
    if (!result.success) return result.response
    const body = result.data

    const { data: existing, error: existingError } = await supabase
      .from('customers')
      .select('id, customer_type')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (existingError || !existing) {
      if (existingError?.code === 'PGRST116') {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('customer lookup before update failed', existingError)
      return errorResponseFromCode('CUSTOMER_UPDATE_FAILED', opLog, { requestId })
    }

    const identifiers = resolveCustomerIdentifiers(body, {
      currentCustomerType: existing.customer_type,
    })
    if (!identifiers.ok) {
      if (identifiers.error.message.includes('only allowed')) {
        return errorResponseFromCode('CUSTOMER_PERSONAL_NUMBER_NOT_ALLOWED', opLog, { requestId })
      }
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: { issues: [identifiers.error] },
      })
    }

    const updateData: Record<string, unknown> = {}
    if (body.name !== undefined) updateData.name = body.name
    if (body.customer_type !== undefined) updateData.customer_type = body.customer_type
    // Empty string clears the customer number, same as an explicit null.
    if (body.customer_number !== undefined) updateData.customer_number = body.customer_number || null
    if (body.contact_person !== undefined) updateData.contact_person = body.contact_person
    if (body.email !== undefined) updateData.email = body.email
    if (body.phone !== undefined) updateData.phone = body.phone
    if (body.invoice_email_cc_addresses !== undefined) {
      updateData.invoice_email_cc_addresses = body.invoice_email_cc_addresses
    }
    if (body.invoice_email_bcc_addresses !== undefined) {
      updateData.invoice_email_bcc_addresses = body.invoice_email_bcc_addresses
    }
    if (body.address_line1 !== undefined) updateData.address_line1 = body.address_line1
    if (body.address_line2 !== undefined) updateData.address_line2 = body.address_line2
    if (body.postal_code !== undefined) updateData.postal_code = body.postal_code
    if (body.city !== undefined) updateData.city = body.city
    if (body.country !== undefined) updateData.country = body.country
    if (identifiers.data.orgNumber !== undefined) {
      updateData.org_number = identifiers.data.orgNumber
    }
    if (body.vat_number !== undefined) updateData.vat_number = body.vat_number
    if (identifiers.data.personalNumber !== undefined) {
      // Stored as ciphertext; customers_personal_number_check accepts that
      // shape only (20260726110000).
      updateData.personal_number = encryptCustomerPersonalNumber(
        identifiers.data.personalNumber,
      )
    }
    if (body.language !== undefined) updateData.language = body.language
    if (body.default_payment_terms !== undefined) updateData.default_payment_terms = body.default_payment_terms
    if (body.notes !== undefined) updateData.notes = body.notes

    const { data, error } = await supabase
      .from('customers')
      .update(updateData)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
      }
      if (error.code === '23505') {
        return errorResponseFromCode('CUSTOMER_DUPLICATE_ORG_NUMBER', opLog, {
          requestId,
          details: { field: 'org_number' },
        })
      }
      opLog.error('customer update failed', error)
      return errorResponseFromCode('CUSTOMER_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    // Re-run VIES validation when the VAT number changes on an EU business
    // customer (non-blocking).
    const isEuBusiness = (body.customer_type || data.customer_type) === 'eu_business'
    if (body.vat_number !== undefined && isEuBusiness) {
      try {
        if (body.vat_number) {
          const vatResult = await validateVatNumber(body.vat_number)
          const validatedAt = vatResult.valid ? new Date().toISOString() : null
          await supabase
            .from('customers')
            .update({
              vat_number_validated: vatResult.valid,
              vat_number_validated_at: validatedAt,
            })
            .eq('id', id)
            .eq('company_id', companyId)
          data.vat_number_validated = vatResult.valid
          data.vat_number_validated_at = validatedAt
        } else {
          await supabase
            .from('customers')
            .update({ vat_number_validated: false, vat_number_validated_at: null })
            .eq('id', id)
            .eq('company_id', companyId)
          data.vat_number_validated = false
          data.vat_number_validated_at = null
        }
      } catch (err) {
        opLog.warn('auto-VIES validation failed on customer update', err as Error)
      }
    }

    return NextResponse.json({ data: maskCustomerIdentifiers(data) })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'customer.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const { error, count } = await supabase
      .from('customers')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      if (error.code === '23503') {
        return errorResponseFromCode('CUSTOMER_HAS_INVOICES', opLog, { requestId })
      }
      opLog.error('customer delete failed', error)
      return errorResponseFromCode('CUSTOMER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    if (count === 0) {
      return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
