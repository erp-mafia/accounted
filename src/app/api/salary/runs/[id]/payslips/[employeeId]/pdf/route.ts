import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parsePayslipAudienceParam } from '@/lib/salary/payslips/build-payslip-data'
import { loadPayslip, preparePayslip, renderPayslipPdf } from '@/lib/salary/payslips/load-payslip'
import { requireWritePermission } from '@/lib/auth/require-write'
import { contentDisposition } from '@/lib/api/content-disposition'
import { dbError } from '@/lib/errors/db-error'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * Generate pay slip PDF for a specific employee in a salary run.
 *
 * Per BFL: Pay slips are räkenskapsinformation/underlag linked to
 * posted journal entries. Subject to 7-year retention per BFL 7 kap.
 *
 * Loading and rendering are shared with the v1 route and the public token
 * surface (lib/salary/payslips/load-payslip.ts): all render identical PDFs.
 *
 * Without a query this is the employer's own view: every section printed.
 * `?audience=employee` renders the copy the employer hands out (the bulk ZIP
 * on the run page), which follows the company's payslip section switches
 * exactly like the emailed link does. When a member who may write the run
 * (requireWritePermission) downloads it, that hands the copy out and issues
 * the run: the first employee copy of an approved run fixes its sections on
 * the run (section-snapshot), and every later employee copy prints those,
 * whatever the switches say by then. A read-only member (viewer) only reads:
 * the copy renders from the run's stored snapshot when it has one, else from
 * the switches, and nothing is written, because the database keeps a
 * snapshot forever and a read must never cause a permanent write.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string; employeeId: string }> }>(
  'salary.run.payslip.pdf',
  async (request, ctx, { params }) => {
    const { id, employeeId } = await params
    const { supabase, companyId } = ctx
    // The section switches (or the run's issued snapshot) could not be read.
    // Answered in the canonical envelope at 500 with the route's own sentence;
    // the cause goes to the log only, never to the body.
    const sectionsUnavailable = (cause: unknown) =>
      errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        messageSv: 'Kunde inte läsa lönespecifikationens inställningar',
        messageEn: 'Could not read the payslip section settings.',
        reason: dbError(cause, 'payslip sections unavailable').message,
      })

    const audienceKind = parsePayslipAudienceParam(new URL(request.url).searchParams.get('audience'))
    if (!audienceKind) {
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        messageSv: 'Ogiltig mottagare för lönespecifikationen',
        messageEn: 'Invalid payslip audience: use employer or employee.',
        details: { field: 'audience' },
      })
    }

    // Loading, the audience and the PDF are the one payslip render path
    // (lib/salary/payslips/load-payslip.ts), shared with v1 and the token link.
    const loaded = await loadPayslip(supabase, { companyId: companyId!, salaryRunId: id, employeeId })
    if (!loaded.ok) {
      if (loaded.reason === 'db_error') {
        return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
          requestId: ctx.requestId,
          reason: dbError(loaded.error, 'payslip load failed').message,
        })
      }
      const message =
        loaded.reason === 'run_not_found'
          ? 'Lönekörning hittades inte'
          : loaded.reason === 'employee_not_found'
            ? 'Anställd hittades inte i lönekörningen'
            : 'Företag hittades inte'
      return NextResponse.json({ error: message }, { status: 404 })
    }

    // Only a member who may write the run issues it, through the caller's own
    // RLS-scoped client (the same write gate and client as the payslip send).
    // A viewer renders from the run as stored and writes nothing.
    const mayIssue =
      audienceKind === 'employee' && (await requireWritePermission(supabase, ctx.user.id, { companyId, role: ctx.role })).ok
    const prepared = await preparePayslip(supabase, loaded.payslip, {
      companyId: companyId!,
      audience: audienceKind,
      mayIssue,
    })
    if (!prepared.ok) return sectionsUnavailable(prepared.error)

    const buffer = await renderPayslipPdf(prepared.data)
    const fileName = prepared.fileName

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        // RFC 5987 dual form: employee names with non-Latin-1 characters
        // (e.g. NFD combining marks) would otherwise make undici reject
        // the header value and crash the response.
        'Content-Disposition': contentDisposition('inline', fileName),
      },
    })
  },
)
