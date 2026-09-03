import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Supplier } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const GET = withRouteContext(
  'supplier.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    // Archived rows (soft-deleted via the v1 API: archived_at + is_active=false)
    // stay in the table for BFL retention but are not part of the roster.
    // Same canonical "active" filter as the v1 list route.
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('company_id', companyId)
      .is('archived_at', null)
      .order('name', { ascending: true })

    if (error) {
      log.error('supplier list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'supplier.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, CreateSupplierSchema, {
      log,
      operation: 'supplier.create',
    })
    if (!result.success) return result.response
    const body = result.data

    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        user_id: user.id,
        company_id: companyId,
        name: body.name,
        supplier_type: body.supplier_type,
        email: body.email,
        phone: body.phone,
        address_line1: body.address_line1,
        address_line2: body.address_line2,
        postal_code: body.postal_code,
        city: body.city,
        country: body.country ?? 'SE',
        org_number: body.org_number,
        vat_number: body.vat_number,
        bankgiro: body.bankgiro,
        plusgiro: body.plusgiro,
        bank_account: body.bank_account,
        iban: body.iban,
        bic: body.bic,
        clearing_number: body.clearing_number,
        account_number: body.account_number,
        default_expense_account: body.default_expense_account,
        default_payment_terms: body.default_payment_terms || 30,
        default_currency: body.default_currency || 'SEK',
        notes: body.notes,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('SUPPLIER_DUPLICATE_ORG_NUMBER', log, {
          requestId,
          details: { orgNumber: body.org_number },
        })
      }
      log.error('supplier insert failed', error)
      return errorResponseFromCode('SUPPLIER_CREATE_FAILED', log, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    await eventBus.emit({
      type: 'supplier.created',
      payload: { supplier: data as Supplier, companyId, userId: user.id },
    })

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
