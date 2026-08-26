import { NextResponse } from 'next/server'
import { roundOre } from '@/lib/money'
import { validateBody } from '@/lib/api/validate'
import { UpdateSupplierSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext(
  'supplier.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const { data: supplier, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !supplier) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', opLog, { requestId })
    }

    const { data: invoices } = await supabase
      .from('supplier_invoices')
      .select('status, total, remaining_amount, paid_amount, currency')
      .eq('supplier_id', id)
      .eq('company_id', companyId)

    // Amounts are in each invoice's own currency, so a single sum across a
    // mixed-currency supplier would be meaningless: group per currency instead
    // (nearly every supplier has exactly one).
    const perCurrency = new Map<string, { total_outstanding: number; total_paid: number }>()
    if (invoices) {
      for (const inv of invoices) {
        const currency = inv.currency || 'SEK'
        const row = perCurrency.get(currency) ?? { total_outstanding: 0, total_paid: 0 }
        if (inv.status !== 'paid' && inv.status !== 'credited') {
          row.total_outstanding += inv.remaining_amount || 0
        }
        row.total_paid += inv.paid_amount || 0
        perCurrency.set(currency, row)
      }
    }

    const stats = {
      invoice_count: invoices?.length ?? 0,
      by_currency: [...perCurrency.entries()]
        .map(([currency, row]) => ({
          currency,
          total_outstanding: roundOre(row.total_outstanding),
          total_paid: roundOre(row.total_paid),
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    }

    return NextResponse.json({ data: { ...supplier, stats } })
  },
)

export const PUT = withRouteContext(
  'supplier.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const result = await validateBody(request, UpdateSupplierSchema, {
      log: opLog,
      operation: 'supplier.update',
    })
    if (!result.success) return result.response
    const body = result.data

    const { data, error } = await supabase
      .from('suppliers')
      .update({
        name: body.name,
        supplier_type: body.supplier_type,
        email: body.email,
        phone: body.phone,
        address_line1: body.address_line1,
        address_line2: body.address_line2,
        postal_code: body.postal_code,
        city: body.city,
        country: body.country,
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
        default_payment_terms: body.default_payment_terms,
        default_currency: body.default_currency,
        notes: body.notes,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('SUPPLIER_DUPLICATE_ORG_NUMBER', opLog, {
          requestId,
          details: { orgNumber: body.org_number },
        })
      }
      opLog.error('supplier update failed', error)
      return errorResponseFromCode('SUPPLIER_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'supplier.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const { count } = await supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('supplier_id', id)
      .eq('company_id', companyId)

    if (count && count > 0) {
      return errorResponseFromCode('SUPPLIER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: 'has_invoices', invoiceCount: count },
      })
    }

    const { error, count: deleteCount } = await supabase
      .from('suppliers')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      opLog.error('supplier delete failed', error)
      return errorResponseFromCode('SUPPLIER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    if (deleteCount === 0) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
