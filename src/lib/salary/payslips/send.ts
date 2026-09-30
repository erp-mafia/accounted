/**
 * Send lönebesked to every employee on a salary run, as secure LINKS, never
 * PDF attachments (salary data and personnummer must not sit in inboxes).
 * Each send rotates the employee's link, so a previously emailed link stops
 * resolving.
 *
 * One implementation behind the dashboard route
 * (POST /api/salary/runs/[id]/payslips/send), the v1 operation
 * salary-runs.send-payslips and gnubok_send_payslips
 * (lib/operations/salary-run-lifecycle.ts), so every door applies the same
 * rules:
 *
 *   - never from the sandbox company (it would reach the live mail provider
 *     for an anonymous demo visitor);
 *   - only with the email_send capability (the paid chokepoint the invoice
 *     send has on every door);
 *   - only once the run is approved (approved, paid or booked);
 *   - every attempt, sent, failed or skipped for a missing address, lands in
 *     salary_payslip_deliveries: the delivery log (BFL 7 kap.).
 *
 * A dry run reads and checks and answers who would get a link and who lacks
 * an email address. It sends nothing, rotates no link and logs no delivery
 * (it is also the MCP staging preview). No personnummer is read here, so none
 * can reach a staged payload or a preview.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany, getBaseUrlForBrand } from '@/lib/email/brand-sender'
import { rotateLinkForEmployee } from '@/lib/salary/payslips/links'
import { buildPayslipLinkEmail } from '@/lib/salary/payslips/email-template'
import { getCompanyDisplayName } from '@/lib/company/context'
import { hasCapability, capabilityBlockedError } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isSandboxCompany } from '@/lib/sandbox/guard'

/** Run statuses from which lönebesked may be sent. */
export const PAYSLIP_SENDABLE_STATUSES = ['approved', 'paid', 'booked'] as const

export type PayslipDeliveryStatus = 'sent' | 'failed' | 'skipped'

export interface PayslipDeliveryResult {
  employee_id: string
  employee_name: string
  status: PayslipDeliveryStatus
  error: string | null
}

export interface SendPayslipsResult {
  sent: number
  skipped: number
  failed: number
  total: number
  /** "<name>: <reason>" per failed send, as the dashboard has always shown them. */
  errors: string[]
  deliveries: PayslipDeliveryResult[]
}

interface RunEmployeeRow {
  employee_id: string
  employee: { first_name: string; last_name: string; email: string | null } | null
}

function nameOf(row: RunEmployeeRow): string {
  const emp = row.employee
  return emp ? `${emp.first_name} ${emp.last_name}`.trim() : ''
}

export async function sendPayslips(
  ctx: OperationContext,
  salaryRunId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SendPayslipsResult>> {
  const { supabase, companyId, userId, log } = ctx

  if (await isSandboxCompany(supabase, companyId)) {
    return { ok: false, code: 'SALARY_PAYSLIPS_SEND_SANDBOX' }
  }
  if (!(await hasCapability(supabase, companyId, CAPABILITY.email_send))) {
    // Via capabilityBlockedError so a self-host gets its own remedy, not the
    // hosted upsell.
    return {
      ok: false,
      code: 'SALARY_PAYSLIPS_SEND_CAPABILITY_BLOCKED',
      messageSv: capabilityBlockedError(CAPABILITY.email_send).message_sv,
      details: { capability: CAPABILITY.email_send },
    }
  }

  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, payment_date')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  const runRow = run as { status: string; period_year: number; period_month: number; payment_date: string }
  if (!(PAYSLIP_SENDABLE_STATUSES as readonly string[]).includes(runRow.status)) {
    return {
      ok: false,
      code: 'SALARY_PAYSLIPS_SEND_INVALID_STATUS',
      details: { current_status: runRow.status },
    }
  }

  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()
  if (!company) return { ok: false, code: 'COMPANY_NOT_FOUND' }

  // Email employer name follows the current company name
  // (company_settings.company_name), not the frozen onboarding companies.name.
  const displayName = await getCompanyDisplayName(supabase, companyId)

  const { data: runEmployeesData } = await supabase
    .from('salary_run_employees')
    .select('employee_id, employee:employees(first_name, last_name, email)')
    .eq('salary_run_id', salaryRunId)
    .eq('company_id', companyId)

  const runEmployees = (runEmployeesData ?? []) as unknown as RunEmployeeRow[]
  if (runEmployees.length === 0) {
    return { ok: false, code: 'SALARY_PAYSLIPS_NO_EMPLOYEES' }
  }

  if (options.dryRun) {
    // Names and whether an address is on file: enough for the approver to
    // see who gets a link, never the addresses themselves.
    const recipients = runEmployees.map((row) => ({
      employee_id: row.employee_id,
      employee_name: nameOf(row),
      has_email: Boolean(row.employee?.email),
    }))
    const missing = recipients.filter((r) => !r.has_email)
    return {
      ok: true,
      dryRun: true,
      preview: {
        salary_run_id: salaryRunId,
        period_year: runRow.period_year,
        period_month: runRow.period_month,
        would_email: recipients.length - missing.length,
        would_skip_missing_email: missing.length,
        recipients,
        employees_missing_email: missing.map((r) => r.employee_name),
        delivery: 'A secure link per employee (no attachment); any earlier link for the run stops working.',
      },
    }
  }

  const emailService = getEmailService()
  // Brand mail (WL-13): payslip links and the sender identity follow the
  // company's brand; no brand = canonical URL and platform sender as before.
  const sender = await getSenderForCompany(companyId)
  const appUrl = getBaseUrlForBrand(sender.brand)
  const companyName = displayName ?? (company as { name: string }).name

  const result: SendPayslipsResult = { sent: 0, skipped: 0, failed: 0, total: runEmployees.length, errors: [], deliveries: [] }
  const record = (row: RunEmployeeRow, status: PayslipDeliveryStatus, error: string | null) =>
    result.deliveries.push({ employee_id: row.employee_id, employee_name: nameOf(row), status, error })

  for (const sre of runEmployees) {
    const emp = sre.employee

    if (!emp?.email) {
      result.skipped++
      // Persist a 'skipped' record so the audit trail is complete
      // (BFL 7 kap.). Placeholder address: the column is NOT NULL.
      await supabase.from('salary_payslip_deliveries').insert({
        company_id: companyId,
        salary_run_id: salaryRunId,
        employee_id: sre.employee_id,
        user_id: userId,
        email_address: '(saknas)',
        status: 'skipped',
        error_message: 'Anställd saknar e-postadress',
      })
      record(sre, 'skipped', 'Anställd saknar e-postadress')
      continue
    }

    try {
      const { token } = await rotateLinkForEmployee(supabase, {
        companyId,
        salaryRunId,
        employeeId: sre.employee_id,
        userId,
      })

      const email = buildPayslipLinkEmail({
        employeeFirstName: emp.first_name,
        companyName,
        periodYear: runRow.period_year,
        periodMonth: runRow.period_month,
        paymentDate: runRow.payment_date,
        url: `${appUrl}/payslip/${token}`,
      })

      const sendResult = await emailService.sendEmail({
        to: emp.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        fromName: sender.fromName ?? undefined,
        fromAddress: sender.fromAddress ?? undefined,
        replyTo: sender.replyTo ?? undefined,
      })

      if (!sendResult.success) {
        const msg = sendResult.error || 'E-postleverantör returnerade ett fel'
        result.failed++
        result.errors.push(`${emp.first_name} ${emp.last_name}: ${msg}`)
        await supabase.from('salary_payslip_deliveries').insert({
          company_id: companyId,
          salary_run_id: salaryRunId,
          employee_id: sre.employee_id,
          user_id: userId,
          email_address: emp.email,
          status: 'failed',
          provider: 'resend',
          error_message: msg.slice(0, 500),
        })
        record(sre, 'failed', msg)
        continue
      }

      await supabase.from('salary_payslip_deliveries').insert({
        company_id: companyId,
        salary_run_id: salaryRunId,
        employee_id: sre.employee_id,
        user_id: userId,
        email_address: emp.email,
        status: 'sent',
        provider: 'resend',
        provider_message_id: sendResult.messageId ?? null,
      })

      result.sent++
      record(sre, 'sent', null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Okänt fel'
      result.failed++
      result.errors.push(`${emp.first_name} ${emp.last_name}: ${msg}`)
      log.warn('payslip send failed for one employee', { salaryRunId, employeeId: sre.employee_id })

      await supabase.from('salary_payslip_deliveries').insert({
        company_id: companyId,
        salary_run_id: salaryRunId,
        employee_id: sre.employee_id,
        user_id: userId,
        email_address: emp.email,
        status: 'failed',
        provider: 'resend',
        error_message: msg.slice(0, 500),
      })
      record(sre, 'failed', msg)
    }
  }

  return { ok: true, data: result }
}
