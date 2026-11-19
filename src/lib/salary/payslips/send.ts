/**
 * Send lönebesked to every employee on a salary run (or to the employees the
 * caller names, all of them on the run), as secure LINKS, never
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
 *     salary_payslip_deliveries: the delivery log (BFL 7 kap.);
 *   - before the first email of a run goes out, the payslip sections the
 *     employee copy prints are fixed on the run (section-snapshot), so the
 *     emailed payslip keeps its content when the company's switches change.
 *
 * A dry run reads and checks and answers who would get a link and who lacks
 * an email address. It sends nothing, rotates no link and logs no delivery
 * (it is also the MCP staging preview). No personnummer is read for the
 * email link or a dry run, so none can reach a staged payload or a preview;
 * the digital mailbox channel reads it to address the mailbox, in
 * send-digital-mailbox.ts, and keeps it there.
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
import { createServiceClient } from '@/lib/supabase/server'
import { usageGateRefusal } from '@/lib/usage/gate'
import { billedUsageKinds } from '@/lib/usage/kinds'
import {
  PAYSLIP_ISSUABLE_STATUSES,
  issuePayslipSections,
  type IssuableRun,
} from '@/lib/salary/payslips/section-snapshot'
import { deliverPayslipsToMailbox, payslipMailboxBlock } from '@/lib/salary/payslips/send-digital-mailbox'
import type { DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'

/**
 * How the payslips go out: the email link (default), or a digital mailbox
 * first (Kivra, Billo) with the email link for whoever it does not reach
 * (send-digital-mailbox.ts).
 */
export type PayslipChannel = 'email' | DigitalMailboxProviderId

/** Run statuses from which lönebesked may be sent. */
export const PAYSLIP_SENDABLE_STATUSES = PAYSLIP_ISSUABLE_STATUSES

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
  employee: {
    first_name: string
    last_name: string
    email: string | null
    /** Read only for a digital mailbox channel, never for the email link or a dry run. */
    phone?: string | null
    personnummer?: string | null
  } | null
}

function nameOf(row: RunEmployeeRow): string {
  const emp = row.employee
  return emp ? `${emp.first_name} ${emp.last_name}`.trim() : ''
}

export async function sendPayslips(
  ctx: OperationContext,
  salaryRunId: string,
  options: {
    dryRun?: boolean
    channel?: PayslipChannel
    /**
     * Only these employees (employees.id) get their payslip: a company that
     * pays groups on different days sends each group on its own payout day
     * (crm#1658). Omitted means everyone on the run, as before. An id that
     * is not on the run refuses the whole send, so a typo never silently
     * drops someone.
     */
    employeeIds?: readonly string[]
  } = {},
): Promise<OperationOutcome<SendPayslipsResult>> {
  const { supabase, companyId, userId, log } = ctx
  const mailbox = options.channel && options.channel !== 'email' ? options.channel : null

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
    .select('id, status, period_year, period_month, payment_date, payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  const runRow = run as IssuableRun & { period_year: number; period_month: number; payment_date: string }
  if (!(PAYSLIP_SENDABLE_STATUSES as readonly string[]).includes(runRow.status)) {
    return {
      ok: false,
      code: 'SALARY_PAYSLIPS_SEND_INVALID_STATUS',
      details: { current_status: runRow.status },
    }
  }

  if (mailbox) {
    const blocked = await payslipMailboxBlock(supabase, companyId, mailbox)
    if (blocked) return { ok: false, code: blocked, details: { channel: mailbox } }
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

  const { data: runEmployeesData } = mailbox && !options.dryRun
    ? await supabase
        .from('salary_run_employees')
        .select('employee_id, employee:employees(first_name, last_name, email, phone, personnummer)')
        .eq('salary_run_id', salaryRunId)
        .eq('company_id', companyId)
    : await supabase
        .from('salary_run_employees')
        .select('employee_id, employee:employees(first_name, last_name, email)')
        .eq('salary_run_id', salaryRunId)
        .eq('company_id', companyId)

  const roster = (runEmployeesData ?? []) as unknown as RunEmployeeRow[]
  if (roster.length === 0) {
    return { ok: false, code: 'SALARY_PAYSLIPS_NO_EMPLOYEES' }
  }
  let runEmployees = roster
  if (options.employeeIds) {
    const wanted = new Set(options.employeeIds)
    const onRun = new Set(roster.map((row) => row.employee_id))
    const notOnRun = [...wanted].filter((id) => !onRun.has(id))
    if (notOnRun.length > 0) {
      return { ok: false, code: 'SALARY_PAYSLIPS_EMPLOYEE_NOT_ON_RUN', details: { employee_ids: notOnRun } }
    }
    runEmployees = roster.filter((row) => wanted.has(row.employee_id))
    if (runEmployees.length === 0) {
      return { ok: false, code: 'SALARY_PAYSLIPS_NO_EMPLOYEES' }
    }
  }

  // Each payslip the mailbox takes is a unit it prices: past what the month
  // includes the run waits, dry run too, for a subscription and an admin's
  // acceptance. Counted as if the mailbox reaches everyone on the run.
  if (mailbox && billedUsageKinds().has(`${mailbox}_send`)) {
    const usageGate = await usageGateRefusal(createServiceClient(), companyId, `${mailbox}_send`, { requested: runEmployees.length })
    if (usageGate) return usageGate
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
        delivery: mailbox
          ? `The payslip PDF to each employee's ${mailbox === 'kivra' ? 'Kivra' : 'Billo'} mailbox where it reaches them, a secure link by email for the rest.`
          : 'A secure link per employee (no attachment); any earlier link for the run stops working.',
        channel: mailbox ?? 'email',
      },
    }
  }

  // Fix the sections the employee copy prints before the first link goes
  // out; a run already issued keeps what it was issued with. Only when an
  // email will actually be sent: a run where nobody has an address reaches
  // no employee. Fail closed: without the switches nothing is sent, so no
  // employee receives a payslip whose content is not on record.
  if (mailbox || runEmployees.some((row) => Boolean(row.employee?.email))) {
    const { data: sectionSettings, error: settingsError } = await supabase
      .from('company_settings')
      .select('salary_payslip_show_employer_cost, salary_payslip_show_breakdown')
      .eq('company_id', companyId)
      .maybeSingle()
    const issued = settingsError
      ? ({ ok: false, error: settingsError } as const)
      : await issuePayslipSections(supabase, { companyId, run: runRow, settings: sectionSettings })
    if (!issued.ok) {
      log.warn('payslip sections could not be fixed; nothing sent', { salaryRunId })
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        messageSv: 'Kunde inte läsa lönespecifikationens inställningar. Inga lönebesked skickades. Försök igen.',
      }
    }
  }

  const emailService = await getEmailService()
  // Brand mail (WL-13): payslip links and the sender identity follow the
  // company's brand; no brand = canonical URL and platform sender as before.
  const sender = await getSenderForCompany(companyId)
  const appUrl = getBaseUrlForBrand(sender.brand)
  const companyName = displayName ?? (company as { name: string }).name

  const result: SendPayslipsResult = { sent: 0, skipped: 0, failed: 0, total: runEmployees.length, errors: [], deliveries: [] }
  const record = (row: RunEmployeeRow, status: PayslipDeliveryStatus, error: string | null) =>
    result.deliveries.push({ employee_id: row.employee_id, employee_name: nameOf(row), status, error })

  // Digital mailbox first: whoever it reaches is done; the rest get the
  // email link below, as without the channel.
  const reachedByMailbox = new Set<string>()
  if (mailbox) {
    const mailboxResults = await deliverPayslipsToMailbox(
      { supabase, companyId, userId, log },
      {
        provider: mailbox,
        salaryRunId,
        period: { year: runRow.period_year, month: runRow.period_month, paymentDate: runRow.payment_date },
        employees: runEmployees,
      },
    )
    for (const delivered of mailboxResults) {
      if (delivered.status !== 'sent') continue
      reachedByMailbox.add(delivered.employee_id)
      const row = runEmployees.find((r) => r.employee_id === delivered.employee_id)
      if (!row) continue
      result.sent++
      record(row, 'sent', null)
    }
  }

  for (const sre of runEmployees) {
    if (reachedByMailbox.has(sre.employee_id)) continue
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
