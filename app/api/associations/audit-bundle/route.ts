import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { auditBundleCsv, buildAuditBundle } from '@/lib/associations/auditors'
import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/associations/audit-bundle?fiscal_period_id=...[&format=csv]
 *
 * What the revisor asks the board for (EFL 8 kap. 7 §: the board gives the
 * revisor the information needed for the audit): the roster, the archived
 * revisionsberättelse facts for the period, the medlemsförteckning (5 kap.),
 * the förteckning over förlagsinsatser (11 kap. 6 §) and the reconciliation
 * of the register against 2083/2087/2084. JSON by default; CSV (semicolon,
 * UTF-8 BOM, one `# heading` per section) on request.
 */
export const GET = withRouteContext('association.audit_bundle', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const url = new URL(request.url)
  const fiscalPeriodId = url.searchParams.get('fiscal_period_id')
  if (!fiscalPeriodId) {
    return errorResponseFromCode('VALIDATION_ERROR', log, {
      requestId,
      details: { fiscal_period_id: 'required' },
    })
  }
  try {
    await requireMemberCapitalForm(supabase, companyId)
    const { data: period, error } = await supabase
      .from('fiscal_periods')
      .select('id, period_end')
      .eq('company_id', companyId)
      .eq('id', fiscalPeriodId)
      .maybeSingle()
    if (error) throw error
    if (!period) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
    const bundle = await buildAuditBundle(
      supabase,
      companyId,
      fiscalPeriodId,
      (period as { period_end: string }).period_end,
    )
    if (url.searchParams.get('format') === 'csv') {
      return new NextResponse('﻿' + auditBundleCsv(bundle), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="revisionsunderlag.csv"',
          'Cache-Control': 'private, no-store',
        },
      })
    }
    return NextResponse.json({ data: bundle })
  } catch (err) {
    return associationErrorResponse(err, log, requestId)
  }
})
