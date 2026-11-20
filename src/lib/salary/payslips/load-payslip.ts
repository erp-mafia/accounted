/**
 * The one payslip render path: what the dashboard PDF route, the v1 PDF route,
 * the public token PDF route and the token page all load and print.
 *
 * Each door used to load the run, the roster row and the company itself, and
 * they drifted: the token page showed the frozen onboarding company name and
 * computed its own net, the dashboard read the roster row without the company
 * filter, and none of them read the employee's F-skatt status, so an avgifter
 * override on an F-skatt row reached the payslip although the booking and the
 * AGI ignore it. The door now decides only who reads (auth or token) and
 * whether the reader may issue the run's sections; loading, the audience and
 * the PDF are here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildPayslipData,
  payslipFileName,
  type PayslipAudience,
  type PayslipEmployeeSource,
  type PayslipSectionSettings,
} from '@/lib/salary/payslips/build-payslip-data'
import { effectiveOrgNumber } from '@/lib/company/org-number'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'
import type { PayslipData } from '@/lib/salary/pdf/payslip-template'

export interface LoadedPayslip {
  run: Record<string, unknown> & { id: string; status: string; period_year: number; period_month: number; payment_date: string }
  sre: Record<string, unknown> & { line_items?: Array<Record<string, unknown>> | null }
  employee: PayslipEmployeeSource
  /** The employer as printed: company_settings.company_name, else the onboarding name. */
  company: { name: string; org_number: string | null }
  /** The employee-copy switches; null without a settings row (column defaults). */
  settings: PayslipSectionSettings | null
  /** A failed settings read: the employee copy must not fall back to defaults. */
  settingsError: unknown
}

export type PayslipLoadResult =
  | { ok: true; payslip: LoadedPayslip }
  | { ok: false; reason: 'run_not_found' | 'employee_not_found' | 'company_not_found' }
  | { ok: false; reason: 'db_error'; error: unknown }

export async function loadPayslip(
  supabase: SupabaseClient,
  args: { companyId: string; salaryRunId: string; employeeId: string },
): Promise<PayslipLoadResult> {
  const [runRes, sreRes, companyRes, settingsRes] = await Promise.all([
    supabase.from('salary_runs').select('*').eq('id', args.salaryRunId).eq('company_id', args.companyId).maybeSingle(),
    supabase
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, personnummer, employment_type, tax_table_number, tax_column, clearing_number, bank_account_number, f_skatt_status), line_items:salary_line_items(*)')
      .eq('salary_run_id', args.salaryRunId)
      .eq('employee_id', args.employeeId)
      .eq('company_id', args.companyId)
      .maybeSingle(),
    supabase.from('companies').select('name, org_number').eq('id', args.companyId).maybeSingle(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, salary_payslip_show_employer_cost, salary_payslip_show_breakdown')
      .eq('company_id', args.companyId)
      .maybeSingle(),
  ])
  // A malformed id (22P02) reads as not found, like a missing row.
  for (const res of [runRes, sreRes, companyRes]) {
    if (res.error && (res.error as { code?: string }).code !== '22P02') {
      return { ok: false, reason: 'db_error', error: res.error }
    }
  }
  if (!runRes.data) return { ok: false, reason: 'run_not_found' }
  if (!sreRes.data) return { ok: false, reason: 'employee_not_found' }
  if (!companyRes.data) return { ok: false, reason: 'company_not_found' }

  const sre = sreRes.data as unknown as LoadedPayslip['sre'] & { employee: PayslipEmployeeSource }
  const company = companyRes.data as { name: string; org_number: string | null }
  const settings = (settingsRes.data ?? null) as (PayslipSectionSettings & { company_name?: string | null; org_number?: string | null }) | null
  return {
    ok: true,
    payslip: {
      run: runRes.data as LoadedPayslip['run'],
      sre,
      employee: sre.employee,
      // Truthiness, so an empty company_name falls through to the onboarding
      // name (getCompanyDisplayName's rule).
      company: { name: settings?.company_name || company.name, org_number: effectiveOrgNumber(settings?.org_number, company.org_number) },
      settings,
      settingsError: settingsRes.error ?? null,
    },
  }
}

export type PreparedPayslip =
  | { ok: true; data: PayslipData; fileName: string }
  | { ok: false; reason: 'sections_unavailable'; error: unknown }

/**
 * The payslip for one reader. The employer view prints every section. The
 * employee copy follows the company's switches, fail closed: a failed
 * settings read refuses rather than print sections hidden from employees.
 * `mayIssue` (a member or key that may write the run, or the employee's own
 * link) hands the copy out: the first employee copy of an approved run fixes
 * its sections on the run, and every later copy prints those. Without it the
 * copy renders from the run as stored and nothing is written.
 */
export async function preparePayslip(
  supabase: SupabaseClient,
  payslip: LoadedPayslip,
  options: { companyId: string; audience: 'employer' | 'employee'; mayIssue: boolean },
): Promise<PreparedPayslip> {
  let audience: PayslipAudience = { kind: 'employer' }
  let run = payslip.run
  if (options.audience === 'employee') {
    if (payslip.settingsError) return { ok: false, reason: 'sections_unavailable', error: payslip.settingsError }
    audience = { kind: 'employee', settings: payslip.settings }
    if (options.mayIssue) {
      const issued = await issuePayslipSections(supabase, {
        companyId: options.companyId,
        run: payslip.run,
        settings: payslip.settings,
      })
      if (!issued.ok) return { ok: false, reason: 'sections_unavailable', error: issued.error }
      run = { ...payslip.run, ...issued.snapshot }
    }
  }
  const data = buildPayslipData({
    run,
    sre: payslip.sre,
    employee: payslip.employee,
    company: payslip.company,
    audience,
  })
  return { ok: true, data, fileName: payslipFileName(payslip.run, payslip.employee) }
}

/** The PDF of a prepared payslip (the renderer loads on first use). */
export async function renderPayslipPdf(data: PayslipData): Promise<Buffer> {
  const [{ renderToBuffer }, { PayslipPDF }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/salary/pdf/payslip-template'),
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return renderToBuffer(PayslipPDF({ data }) as any)
}
