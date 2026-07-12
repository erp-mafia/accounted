import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { generateAgiDeclaration } from '@/lib/salary/agi/generate-declaration'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * GET /api/salary/runs/{id}/agi/xml
 *
 * Thin wrapper over `generateAgiDeclaration()` from
 * `lib/salary/agi/generate-declaration.ts`. The orchestration was extracted in
 * Phase 5 PR-2 so the v1 public route (`POST /api/v1/.../salary-runs/{id}/generate-agi`)
 * can call the same code. This route's responsibility is now: auth → invoke
 * helper → return the raw XML as a downloadable file (the dashboard's
 * historical contract).
 *
 * Per agi-filing.md:
 *   - FK570 (specifikationsnummer) MUST stay consistent per employee
 *   - Corrections resubmit with same FK570: different number = new record
 *   - XML is räkenskapsinformation, stored for 7-year retention per BFL 7 kap
 *   - Filing deadline: the 12th of the following month (17th in Jan/Aug for
 *     companies ≤ 40 MSEK turnover)
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.agi.xml',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await generateAgiDeclaration({
      supabase,
      companyId,
      userId: user.id,
      userEmail: user.email ?? null,
      salaryRunId: id,
      log,
      requestId,
    })

    if (!result.ok) {
      return errorResponseFromCode(result.code, log, {
        requestId,
        details: result.details,
        status: result.status,
      })
    }

    // OWASP V3.2 / V4 (HTTP response header injection prevention): sanitise
    // header-interpolated values. orgNumber comes from company_settings
    // (user-editable) and period_* from the run's own columns, but defense
    // in depth requires we strip anything that could be construed as a
    // header-injection character before splicing into Content-Disposition.
    const safeOrg = result.orgNumber.replace(/[^0-9A-Za-z-]/g, '')
    const safePeriod = `${result.periodYear}${String(result.periodMonth).padStart(2, '0')}`.replace(
      /[^0-9]/g,
      '',
    )

    return new Response(result.xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="AGI_${safeOrg}_${safePeriod}.xml"`,
      },
    })
  },
)
