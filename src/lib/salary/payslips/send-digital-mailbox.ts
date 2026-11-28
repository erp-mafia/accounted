/**
 * Lönebesked to employees' digital mailboxes (Kivra, Billo), the mailbox
 * half of sendPayslips' digital channel (send.ts).
 *
 * The payslip goes as its PDF, which is safe here where it is not in email:
 * a Kivra or Billo mailbox opens with BankID. Kivra also takes its figures as
 * data (salaryslip), which names the employer with address, email and phone,
 * so a company without them in its settings cannot send to Kivra. Who it
 * reaches:
 *   - Billo (SendEasy): every employee with a personnummer. A Billo user
 *     gets it in the mailbox; anyone else a BankID or Freja protected link
 *     by email or SMS.
 *   - Kivra: the employees Kivra matches as its users (salaryslip content).
 * Whoever the mailbox does not reach, or whose send fails, is left to the
 * email link that sendPayslips sends next, so nobody goes without a payslip.
 *
 * Each mailbox attempt is a salary_payslip_deliveries row with the provider
 * named, the same delivery log the email sends write (BFL 7 kap.).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getConnection } from '@/lib/digital-mailboxes/connections'
import { isActiveSender, sendingNotActiveRefusal, type SendingNotActiveRefusal } from '@/lib/digital-mailboxes/sending-not-active'
import { payslipEmployerContact, personnummer12, phoneToE164 } from '@/lib/digital-mailboxes/identifiers'
import { getDigitalMailboxProviders } from '@/lib/digital-mailboxes/providers'
import type { DigitalMailboxProviderId, PayslipEmployer, PayslipStatement } from '@/lib/digital-mailboxes/types'
import type { Logger } from '@/lib/logger'
import type { PayslipData } from '@/lib/salary/pdf/payslip-template'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { loadPayslip, preparePayslip, renderPayslipPdf } from '@/lib/salary/payslips/load-payslip'

/** What the email_address column holds for a mailbox delivery to someone without an address on file. */
export const MAILBOX_DELIVERY_ADDRESS_PLACEHOLDER = '(digital brevlåda)'

export interface MailboxPayslipEmployee {
  employee_id: string
  employee: {
    first_name: string
    last_name: string
    email: string | null
    phone?: string | null
    personnummer?: string | null
  } | null
}

export interface MailboxPayslipResult {
  employee_id: string
  status: 'sent' | 'failed'
  error: string | null
}

function employeePersonnummer(stored: string | null | undefined): string | null {
  if (!stored) return null
  try {
    return personnummer12(decryptPersonnummer(stored))
  } catch {
    return null
  }
}

type EmployerContactFields = Omit<PayslipEmployer, 'name' | 'orgNumber'>

const NO_EMPLOYER_CONTACT: EmployerContactFields = {
  streetAddress: null,
  postalCode: null,
  city: null,
  country: null,
  email: null,
  phone: null,
}

/** The company's address, email and phone from its settings, which a Kivra payslip names the employer by. */
async function loadEmployerContact(supabase: SupabaseClient, companyId: string): Promise<EmployerContactFields> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('address_line1, postal_code, city, country, phone, email')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`company settings read failed: ${error.message}`)
  const row = (data ?? {}) as {
    address_line1?: string | null
    postal_code?: string | null
    city?: string | null
    country?: string | null
    phone?: string | null
    email?: string | null
  }
  return {
    streetAddress: row.address_line1 ?? null,
    postalCode: row.postal_code ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
  }
}

/** The pay month's first and last day, YYYY-MM-DD. */
function payMonth(year: number, month: number): { start: string; end: string } {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` }
}

/** The figures a mailbox shows next to the payslip PDF, read from the same data the PDF prints. */
export function payslipStatement(
  data: PayslipData,
  period: { year: number; month: number; paymentDate: string },
  contact: EmployerContactFields,
): PayslipStatement {
  const month = payMonth(period.year, period.month)
  return {
    employer: { name: data.companyName, orgNumber: data.companyOrgNumber, ...contact },
    periodStart: month.start,
    periodEnd: month.end,
    payoutDate: period.paymentDate.slice(0, 10),
    grossPay: data.grossSalary,
    taxDeducted: data.taxWithheld,
    netPay: data.netSalary,
    yearToDateGrossPay: data.ytdGross,
    yearToDateTax: data.ytdTax,
  }
}

/**
 * Why the mailbox channel cannot run for this company, or null. Sending that
 * is not active says where it stands (sendingNotActiveRefusal: off, waiting
 * for the provider's approval, or declined), with its own message and next step.
 */
export type PayslipMailboxBlock =
  | { code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' | 'DIGITAL_MAILBOX_EMPLOYER_CONTACT_MISSING' }
  | SendingNotActiveRefusal

export async function payslipMailboxBlock(
  supabase: SupabaseClient,
  companyId: string,
  provider: DigitalMailboxProviderId,
): Promise<PayslipMailboxBlock | null> {
  const sender = getDigitalMailboxProviders()[provider]?.sender
  if (!sender) return { code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' }
  const connection = await getConnection(supabase, companyId, provider)
  if (!isActiveSender(connection)) return sendingNotActiveRefusal(provider, connection)
  if (sender.payslipNeedsEmployerContact) {
    const contact = await loadEmployerContact(supabase, companyId)
    if (!payslipEmployerContact({ name: '', orgNumber: '', ...contact })) return { code: 'DIGITAL_MAILBOX_EMPLOYER_CONTACT_MISSING' }
  }
  return null
}

/**
 * Send each reachable employee's payslip to the mailbox. Answers one result
 * per employee the mailbox was tried for; an employee left out is for the
 * email link.
 */
export async function deliverPayslipsToMailbox(
  ctx: { supabase: SupabaseClient; companyId: string; userId: string; log: Logger },
  args: {
    provider: DigitalMailboxProviderId
    salaryRunId: string
    period: { year: number; month: number; paymentDate: string }
    employees: MailboxPayslipEmployee[]
  },
): Promise<MailboxPayslipResult[]> {
  const { supabase, companyId, userId, log } = ctx
  const sender = getDigitalMailboxProviders()[args.provider]?.sender
  const connection = await getConnection(supabase, companyId, args.provider)
  if (!sender || connection?.send_state !== 'active' || !connection.tenant_ref) return []
  const tenantRef = connection.tenant_ref
  const results: MailboxPayslipResult[] = []
  const subject = `Lönebesked ${args.period.year}-${String(args.period.month).padStart(2, '0')}`
  let contact = NO_EMPLOYER_CONTACT
  if (sender.payslipNeedsEmployerContact) {
    try {
      contact = await loadEmployerContact(supabase, companyId)
    } catch (err) {
      // Each send then refuses for the missing contact, and the email link takes over.
      log.warn('payslip employer contact read failed', {
        salaryRunId: args.salaryRunId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  for (const row of args.employees) {
    const emp = row.employee
    const pnr = employeePersonnummer(emp?.personnummer)
    if (!emp || !pnr) continue

    try {
      if (!sender.payslipReachesNonUsers && !(await sender.isReachable(tenantRef, { kind: 'person', personnummer: pnr }))) {
        continue
      }
    } catch (err) {
      log.warn('payslip mailbox match failed; the email link takes over', {
        salaryRunId: args.salaryRunId,
        employeeId: row.employee_id,
        reason: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    try {
      const loaded = await loadPayslip(supabase, { companyId, salaryRunId: args.salaryRunId, employeeId: row.employee_id })
      if (!loaded.ok) throw new Error(`payslip could not be loaded (${loaded.reason})`)
      const prepared = await preparePayslip(supabase, loaded.payslip, { companyId, audience: 'employee', mayIssue: true })
      if (!prepared.ok) throw new Error('payslip sections could not be read')
      const pdf = await renderPayslipPdf(prepared.data)

      const receipt = await sender.sendPayslip(tenantRef, pnr, {
        subject,
        generatedAt: args.period.paymentDate,
        pdf: { name: prepared.fileName, bytes: new Uint8Array(pdf) },
        statement: payslipStatement(prepared.data, args.period, contact),
        firstName: emp.first_name,
        lastName: emp.last_name,
        email: emp.email,
        phone: phoneToE164(emp.phone),
      })
      await supabase.from('salary_payslip_deliveries').insert({
        company_id: companyId,
        salary_run_id: args.salaryRunId,
        employee_id: row.employee_id,
        user_id: userId,
        email_address: emp.email || MAILBOX_DELIVERY_ADDRESS_PLACEHOLDER,
        status: 'sent',
        provider: args.provider,
        provider_message_id: receipt.providerRef,
      })
      results.push({ employee_id: row.employee_id, status: 'sent', error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Okänt fel'
      log.warn('payslip mailbox send failed; the email link takes over', {
        salaryRunId: args.salaryRunId,
        employeeId: row.employee_id,
        provider: args.provider,
      })
      await supabase.from('salary_payslip_deliveries').insert({
        company_id: companyId,
        salary_run_id: args.salaryRunId,
        employee_id: row.employee_id,
        user_id: userId,
        email_address: emp.email || MAILBOX_DELIVERY_ADDRESS_PLACEHOLDER,
        status: 'failed',
        provider: args.provider,
        error_message: message.slice(0, 500),
      })
      results.push({ employee_id: row.employee_id, status: 'failed', error: message })
    }
  }
  return results
}
