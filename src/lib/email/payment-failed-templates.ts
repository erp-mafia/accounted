import { getBranding } from '@/lib/branding/service'
import { escapeHtml, sanitizeSubjectLine } from '@/lib/email/user-text'
import { formatCurrency, formatDate } from '@/lib/utils'

/** The template's name, as the send log speaks of it. */
export const PAYMENT_FAILED_TEMPLATE = 'payment_failed'

/** One payment the bank did not carry out. */
export interface PaymentFailedEmailLine {
  /** Who the payment was to. */
  payee: string
  /** "faktura 1042" for a supplier invoice; null for anything else. */
  invoiceLabel: string | null
  amount: number
  currency: string
  /** The day the payment was to be made (ISO date). */
  executionDate: string
  /** Why, one or two sentences: the bank's reason in words when it is known. */
  reason: string
}

export interface PaymentFailedEmailData {
  /** The company the payments were to leave from. */
  companyName: string
  payments: PaymentFailedEmailLine[]
  /** Betalningar on the company's brand host. */
  paymentsUrl: string
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

export function generatePaymentFailedEmailSubject(data: PaymentFailedEmailData): string {
  const [only] = data.payments
  return sanitizeSubjectLine(
    data.payments.length === 1 && only
      ? `Betalningen till ${only.payee} gick inte igenom`
      : `${data.payments.length} betalningar från ${data.companyName} gick inte igenom`,
  )
}

function lineFacts(line: PaymentFailedEmailLine): string {
  return [formatCurrency(line.amount, line.currency), line.invoiceLabel, `betalningsdag ${formatDate(line.executionDate)}`]
    .filter(Boolean)
    .join(', ')
}

function lead(data: PaymentFailedEmailData): string {
  return data.payments.length === 1
    ? `Banken har inte genomfört den här betalningen från ${data.companyName}, så mottagaren har inte fått pengarna.`
    : `Banken har inte genomfört de här betalningarna från ${data.companyName}, så mottagarna har inte fått pengarna.`
}

function nextStep(appName: string): string {
  return `Åtgärda orsaken och gör en ny betalning, i ${appName} eller i internetbanken.`
}

function whyYou(appName: string): string {
  return `Du får det här mejlet för att du skapade, godkände eller signerade betalningen i ${appName}.`
}

/**
 * Plain and calm, the tone of the signing request: what did not happen, each
 * payment with its reason, what to do, and the way to Betalningar with its
 * URL in clear text beside the button. No link per invoice: a person in
 * several companies lands in the active one, and Betalningar exists in every
 * company. The recipients made the payments, so Swedish only, like every
 * payment mail.
 */
export function generatePaymentFailedEmailHtml(data: PaymentFailedEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const url = escapeHtml(data.paymentsUrl)
  const title = data.payments.length === 1 ? 'Betalningen gick inte igenom' : `${data.payments.length} betalningar gick inte igenom`
  const items = data.payments
    .map(
      (line) => `
        <li style="margin: 0 0 12px 0;">
          <strong>${escapeHtml(line.payee)}</strong>, ${escapeHtml(lineFacts(line))}<br>
          <span style="color: #666;">${escapeHtml(line.reason)}</span>
        </li>`,
    )
    .join('')

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${escapeHtml(appName.toUpperCase())}</p>
      <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #111;">${escapeHtml(title)}</h1>
      <p style="margin: 0 0 16px 0; font-size: 15px;">${escapeHtml(lead(data))}</p>
      <ul style="margin: 0 0 16px 0; padding-left: 20px; font-size: 15px;">${items}
      </ul>
      <p style="margin: 0 0 16px 0; font-size: 15px;">${escapeHtml(nextStep(appName))}</p>
      <div style="margin: 28px 0;">
        <a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">Öppna Betalningar</a>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 13px; color: #666; word-break: break-all;">
        Länken går till: <a href="${url}" style="color: #666;">${url}</a>
      </p>
      <p style="margin: 0; font-size: 13px; color: #999;">${escapeHtml(whyYou(appName))}</p>
    </div>
  </div>
</body>
</html>`
}

export function generatePaymentFailedEmailText(data: PaymentFailedEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const lines = [lead(data), '']
  for (const line of data.payments) {
    lines.push(`- ${line.payee}, ${lineFacts(line)}`, `  ${line.reason}`)
  }
  lines.push('', nextStep(appName), '', `Öppna Betalningar: ${data.paymentsUrl}`, '', whyYou(appName))
  return lines.join('\n')
}
