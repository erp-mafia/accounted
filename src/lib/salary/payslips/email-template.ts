/**
 * Payslip link email - Swedish-only (employee-facing, same rationale as
 * customer emails).
 *
 * The email deliberately carries NO salary data and NO attachment: just the
 * secure link. Names are user-authored input and get escaped.
 */
import { escapeHtml, sanitizeSubjectLine } from '@/lib/email/user-text'
import { PAYSLIP_LINK_TTL_DAYS } from '@/lib/salary/payslips/links'
import { swedishMonthName } from '@/lib/dates/swedish-months'

export function buildPayslipLinkEmail(params: {
  employeeFirstName: string
  companyName: string
  periodYear: number
  periodMonth: number
  paymentDate: string
  url: string
}): { subject: string; html: string; text: string } {
  const monthName = swedishMonthName(params.periodMonth)
  const subject = sanitizeSubjectLine(
    `Lönespecifikation ${monthName} ${params.periodYear} — ${params.companyName}`,
  )

  const firstName = escapeHtml(params.employeeFirstName)
  const companyName = escapeHtml(params.companyName)
  const url = escapeHtml(params.url)

  const html = `<p>Hej ${firstName},</p>
<p>Din lönespecifikation för ${monthName} ${params.periodYear} finns att hämta via länken nedan.</p>
<p><a href="${url}">Visa lönespecifikation</a></p>
<p>Utbetalningsdag: ${escapeHtml(params.paymentDate)}<br>
Länken är personlig och giltig i ${PAYSLIP_LINK_TTL_DAYS} dagar.</p>
<p>Med vänliga hälsningar,<br>${companyName}</p>`

  const text = `Hej ${params.employeeFirstName},

Din lönespecifikation för ${monthName} ${params.periodYear} finns att hämta här:
${params.url}

Utbetalningsdag: ${params.paymentDate}
Länken är personlig och giltig i ${PAYSLIP_LINK_TTL_DAYS} dagar.

Med vänliga hälsningar,
${params.companyName}`

  return { subject, html, text }
}
