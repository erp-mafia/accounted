import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listSupplierPayeeAlerts } from '@/lib/payments/payee-alerts'

/**
 * GET /api/supplier-invoices/payee-alerts: the unpaid supplier invoices whose
 * stated bank details hold their payment back (unconfirmed or rejected), for
 * the "Nya bankuppgifter" marker on the invoice and payment lists.
 */
export const GET = withRouteContext('supplier_invoice.payee_alerts', async (_request, { supabase, companyId }) => {
  const rows = await listSupplierPayeeAlerts(supabase, companyId)
  return NextResponse.json({
    data: rows.map((row) => ({ supplier_invoice_id: row.supplier_invoice_id, alert: row.alert, hold: row.hold })),
  })
})
