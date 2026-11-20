import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { checkVacationBasisChange } from '@/lib/company/settings-service'

/**
 * GET /api/settings/vacation-year-basis
 *
 * Whether the semesterår basis (company_settings.salary_vacation_year_basis)
 * may change now, and if not, the settings service's refusal code. The
 * salary settings page reads it to offer the choice or lock it with the
 * reason up front; the save (PUT /api/settings) asks the same function, so
 * the page and the save cannot disagree.
 */
export const GET = withRouteContext('settings.vacation_year_basis', async (_request, { supabase, companyId, log, requestId }) => {
  const check = await checkVacationBasisChange({ supabase, companyId })
  if (check.changeable) return NextResponse.json({ data: { changeable: true, reason: null } })
  if (check.code === 'UNKNOWN_ERROR') return errorResponse(check.error, log, { requestId })
  return NextResponse.json({ data: { changeable: false, reason: check.code } })
})
