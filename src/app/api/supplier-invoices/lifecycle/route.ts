import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { UUID_RE } from '@/lib/invariants/uuid'
import { computeSupplierInvoiceLifecycle } from '@/lib/supplier-invoices/lifecycle-stages'
import { countByStage } from '@/lib/supplier-invoices/stages'

/**
 * GET /api/supplier-invoices/lifecycle[?ids=a,b,c]
 * Derived lifecycle stage per invoice (Inkommen → Avstämd) plus counts per
 * stage. Feeds the Inköp pipeline bar and the invoice page's flow strip.
 */
export const GET = withRouteContext('supplier_invoice.lifecycle', async (request, { supabase, companyId }) => {
  const raw = new URL(request.url).searchParams.get('ids')
  let ids: string[] | undefined
  if (raw) {
    ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0 || ids.length > 150 || ids.some((id) => !UUID_RE.test(id))) {
      return NextResponse.json({ error: 'Ogiltiga id' }, { status: 400 })
    }
  }
  try {
    const stages = await computeSupplierInvoiceLifecycle(supabase, companyId, ids)
    return NextResponse.json({ data: { stages, counts: countByStage(Object.values(stages)) } })
  } catch (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }
})
