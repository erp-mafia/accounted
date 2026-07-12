import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getEmailService } from '@/lib/email/service'
import { getBranding } from '@/lib/branding/service'
import { rotateLinkForEmployee } from '@/lib/salary/payslips/links'
import { buildPayslipLinkEmail } from '@/lib/salary/payslips/email-template'
import { getCompanyDisplayName } from '@/lib/company/context'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

ensureInitialized()

/**
 * Send payslips to all employees with email addresses — as secure LINKS,
 * never PDF attachments (salary data + personnummer must not sit in
 * inboxes). Each send rotates the employee's link: previously emailed links
 * stop resolving.
 *
 * Per BFL 7 kap.: every attempt (sent/failed/skipped) is persisted to
 * salary_payslip_deliveries as the audit trail.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary_run.payslips_send',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const blocked = await requireCapability(supabase, companyId, CAPABILITY.email_send)
    if (blocked) return blocked

    const emailService = getEmailService()

    const { data: run } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) {
      return errorResponseFromCode('SALARY_RUN_NOT_FOUND', log, { requestId })
    }
    if (!['approved', 'paid', 'booked'].includes(run.status)) {
      return errorResponseFromCode('SALARY_PAYSLIPS_SEND_INVALID_STATUS', log, { requestId })
    }

    const { data: company } = await supabase
      .from('companies')
      .select('name, org_number')
      .eq('id', companyId)
      .single()

    if (!company) {
      return errorResponseFromCode('COMPANY_NOT_FOUND', log, { requestId })
    }

    // Email employer name follows the current company name
    // (company_settings.company_name), not the frozen onboarding companies.name.
    const displayName = await getCompanyDisplayName(supabase, companyId)

    const { data: runEmployees } = await supabase
      .from('salary_run_employees')
      .select('employee_id, employee:employees(first_name, last_name, email)')
      .eq('salary_run_id', id)

    if (!runEmployees || runEmployees.length === 0) {
      return errorResponseFromCode('SALARY_PAYSLIPS_NO_EMPLOYEES', log, { requestId })
    }

    const appUrl = getBranding().appUrl

    let sent = 0
    let skipped = 0
    const errors: string[] = []

    for (const sre of runEmployees) {
      const emp = sre.employee as unknown as {
        first_name: string
        last_name: string
        email: string | null
      } | null

      if (!emp?.email) {
        skipped++
        // Persist a 'skipped' record so the audit trail is complete
        // (BFL 7 kap.). Placeholder address — the column is NOT NULL.
        await supabase.from('salary_payslip_deliveries').insert({
          company_id: companyId,
          salary_run_id: id,
          employee_id: sre.employee_id,
          user_id: user.id,
          email_address: '(saknas)',
          status: 'skipped',
          error_message: 'Anställd saknar e-postadress',
        })
        continue
      }

      try {
        const { token } = await rotateLinkForEmployee(supabase, {
          companyId,
          salaryRunId: id,
          employeeId: sre.employee_id,
          userId: user.id,
        })

        const email = buildPayslipLinkEmail({
          employeeFirstName: emp.first_name,
          companyName: displayName ?? company.name,
          periodYear: run.period_year,
          periodMonth: run.period_month,
          paymentDate: run.payment_date,
          url: `${appUrl}/payslip/${token}`,
        })

        const sendResult = await emailService.sendEmail({
          to: emp.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
        })

        if (!sendResult.success) {
          const msg = sendResult.error || 'E-postleverantör returnerade ett fel'
          errors.push(`${emp.first_name} ${emp.last_name}: ${msg}`)
          await supabase.from('salary_payslip_deliveries').insert({
            company_id: companyId,
            salary_run_id: id,
            employee_id: sre.employee_id,
            user_id: user.id,
            email_address: emp.email,
            status: 'failed',
            provider: 'resend',
            error_message: msg.slice(0, 500),
          })
          continue
        }

        await supabase.from('salary_payslip_deliveries').insert({
          company_id: companyId,
          salary_run_id: id,
          employee_id: sre.employee_id,
          user_id: user.id,
          email_address: emp.email,
          status: 'sent',
          provider: 'resend',
          provider_message_id: sendResult.messageId ?? null,
        })

        sent++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Okänt fel'
        errors.push(`${emp.first_name} ${emp.last_name}: ${msg}`)

        await supabase.from('salary_payslip_deliveries').insert({
          company_id: companyId,
          salary_run_id: id,
          employee_id: sre.employee_id,
          user_id: user.id,
          email_address: emp.email,
          status: 'failed',
          provider: 'resend',
          error_message: msg.slice(0, 500),
        })
      }
    }

    return NextResponse.json({
      data: {
        sent,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
        total: runEmployees.length,
      },
    })
  },
  { requireWrite: true },
)
