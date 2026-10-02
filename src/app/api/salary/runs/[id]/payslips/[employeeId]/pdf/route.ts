import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getCompanyDisplayName } from '@/lib/company/context'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'
import {
  buildPayslipData,
  parsePayslipAudienceParam,
  payslipFileName,
  type PayslipAudience,
} from '@/lib/salary/payslips/build-payslip-data'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'
import { requireWritePermission } from '@/lib/auth/require-write'
import { contentDisposition } from '@/lib/api/content-disposition'
import { dbError } from '@/lib/errors/db-error'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * Generate pay slip PDF for a specific employee in a salary run.
 *
 * Per BFL: Pay slips are räkenskapsinformation/underlag linked to
 * posted journal entries. Subject to 7-year retention per BFL 7 kap.
 *
 * Data assembly is shared with the public token surface via
 * lib/salary/payslips/build-payslip-data — both must render identical PDFs.
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

    // Load salary run
    const { data: run } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    // Load salary run employee
    const { data: sre } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, personnummer, personnummer_last4, employment_type, tax_table_number, tax_column, clearing_number, bank_account_number), line_items:salary_line_items(*)')
      .eq('salary_run_id', id)
      .eq('employee_id', employeeId)
      .single()

    if (!sre) {
      return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
    }

    // Load company
    const { data: company } = await supabase
      .from('companies')
      .select('name, org_number')
      .eq('id', companyId)
      .single()

    if (!company) {
      return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
    }

    const emp = sre.employee as {
      first_name: string; last_name: string; personnummer: string; personnummer_last4: string;
      employment_type: string; tax_table_number: number | null; tax_column: number;
      clearing_number: string | null; bank_account_number: string | null;
    }

    // Employer name on the payslip follows the current company name
    // (company_settings.company_name), not the frozen onboarding companies.name.
    const displayName = await getCompanyDisplayName(supabase, companyId)

    let audience: PayslipAudience = { kind: 'employer' }
    let renderRun = run
    if (audienceKind === 'employee') {
      const { data: sectionSettings, error: settingsError } = await supabase
        .from('company_settings')
        .select('salary_payslip_show_employer_cost, salary_payslip_show_breakdown')
        .eq('company_id', companyId)
        .maybeSingle()
      // Fail closed: a failed read must not fall back to the defaults and
      // print sections the company has hidden from its employees.
      if (settingsError) {
        return sectionsUnavailable(settingsError)
      }
      audience = { kind: 'employee', settings: sectionSettings }
      // Only a member who may write the run issues it, through the caller's
      // own RLS-scoped client (the same write gate and client as the payslip
      // send). A viewer renders from the run as stored and writes nothing.
      const writeCheck = await requireWritePermission(supabase, ctx.user.id, { companyId })
      if (writeCheck.ok) {
        const issued = await issuePayslipSections(supabase, { companyId, run, settings: sectionSettings })
        if (!issued.ok) {
          return sectionsUnavailable(issued.error)
        }
        renderRun = { ...run, ...issued.snapshot }
      }
    }

    const data = buildPayslipData({
      run: renderRun,
      sre,
      employee: emp,
      company: { name: displayName ?? company.name, org_number: company.org_number },
      audience,
    })
    const fileName = payslipFileName(run, emp)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await renderToBuffer(PayslipPDF({ data }) as any)

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
