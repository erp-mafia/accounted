import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { getEmailService } from '@/lib/email/service'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'
import type { PayslipData, PayslipLineItem } from '@/lib/salary/pdf/payslip-template'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'

ensureInitialized()

/**
 * Send pay slip PDFs to all employees with email addresses.
 *
 * Uses the existing email extension (Resend) for delivery.
 * Per BFL 7 kap: Delivery confirmation retained as part of audit trail.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await params
  return NextResponse.json({ error: 'Funktionen är inaktiverad' }, { status: 503 })
}

// Implementation preserved but unreachable: feature disabled at the export above.
// To re-enable, replace the POST export above with this function body.
async function _sendPayslipsImpl(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const emailService = getEmailService()

  // Load salary run
  const { data: run } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  if (!['approved', 'paid', 'booked'].includes(run.status)) {
    return NextResponse.json({ error: 'Lönespecifikationer kan bara skickas efter godkännande' }, { status: 400 })
  }

  // Load company
  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  if (!company) return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })

  // Load employees with line items
  const { data: runEmployees } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(first_name, last_name, personnummer, personnummer_last4, employment_type, email, tax_table_number, tax_column, clearing_number, bank_account_number), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)

  if (!runEmployees || runEmployees.length === 0) {
    return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const MONTH_NAMES = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december']
  const monthName = MONTH_NAMES[run.period_month - 1]

  let sent = 0
  let skipped = 0
  const errors: string[] = []

  for (const sre of runEmployees) {
    const emp = sre.employee as {
      first_name: string; last_name: string; personnummer: string; personnummer_last4: string;
      employment_type: string; email: string | null; tax_table_number: number | null;
      tax_column: number; clearing_number: string | null; bank_account_number: string | null;
    } | null

    if (!emp?.email) {
      skipped++
      // Persist a 'skipped' record so the audit trail is complete (BFL 7 kap.).
      // Use a placeholder address since the column is NOT NULL.
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
      // Build payslip data
      const lineItems: PayslipLineItem[] = ((sre.line_items || []) as Array<Record<string, unknown>>)
        .sort((a, b) => ((a.sort_order as number) || 0) - ((b.sort_order as number) || 0))
        .map(li => ({
          description: li.description as string,
          quantity: li.quantity as number | undefined,
          unitPrice: li.unit_price as number | undefined,
          amount: li.amount as number,
        }))

      let taxReference = 'Schablon 30%'
      if (emp.tax_table_number) {
        taxReference = `Tabell ${emp.tax_table_number}, kol ${emp.tax_column}`
      }

      const effectiveTax = sre.tax_withheld_override ?? sre.tax_withheld
      const effectiveAvgifter = sre.avgifter_amount_override ?? sre.avgifter_amount
      const effectiveNet = sre.net_salary + (sre.tax_withheld - effectiveTax)

      const data: PayslipData = {
        companyName: company.name,
        companyOrgNumber: company.org_number || '',
        employeeName: `${emp.first_name} ${emp.last_name}`,
        personnummerMasked: maskPersonnummer(decryptPersonnummer(emp.personnummer)),
        employmentType: emp.employment_type,
        periodYear: run.period_year,
        periodMonth: run.period_month,
        paymentDate: run.payment_date,
        lineItems,
        grossSalary: sre.gross_salary,
        taxWithheld: effectiveTax,
        netSalary: effectiveNet,
        taxReference,
        avgifterRate: sre.avgifter_rate,
        avgifterAmount: effectiveAvgifter,
        vacationAccrual: sre.vacation_accrual,
        vacationAccrualAvgifter: sre.vacation_accrual_avgifter,
        totalEmployerCost: sre.gross_salary + effectiveAvgifter + sre.vacation_accrual + sre.vacation_accrual_avgifter,
        ytdGross: sre.ytd_gross,
        ytdTax: sre.ytd_tax,
        ytdNet: sre.ytd_net,
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfBuffer = await renderToBuffer(PayslipPDF({ data }) as any)

      const sendResult = await emailService.sendEmail({
        to: emp.email,
        subject: `Lönespecifikation ${monthName} ${run.period_year}: ${company.name}`,
        html: `<p>Hej ${emp.first_name},</p>
<p>Bifogat finner du din lönespecifikation för ${monthName} ${run.period_year}.</p>
<p>Utbetalningsdag: ${run.payment_date}</p>
<p>Med vänliga hälsningar,<br>${company.name}</p>`,
        text: `Hej ${emp.first_name},\n\nBifogat finner du din lönespecifikation för ${monthName} ${run.period_year}.\n\nUtbetalningsdag: ${run.payment_date}\n\nMed vänliga hälsningar,\n${company.name}`,
        attachments: [{
          filename: `lonespec_${emp.last_name}_${emp.first_name}_${periodLabel}.pdf`,
          content: Buffer.from(pdfBuffer),
        }],
      })

      if (!sendResult.success) {
        const msg = sendResult.error || 'E-postlevereantör returnerade ett fel'
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
}
