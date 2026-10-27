import type { CompanySettings, Customer, Invoice, ReminderTextOverride } from '@/types'
import { companyWithInvoicePaymentAccount } from '@/lib/cash-accounts/invoice-payment-accounts'
import { formatCurrencyForCustomer, invoiceEmailPaymentRows, type EmailLang } from '@/lib/email/invoice-templates'
import { applyPlaceholders, escapeHtml, sanitizeSubjectLine, userTextToHtml } from '@/lib/email/user-text'
import { roundOre } from '@/lib/money'
import { customerGreetingName } from '@/lib/invoices/customer-greeting-name'
import { formatDate, getCompanyDisplayName } from '@/lib/utils'
import type { ReminderLevel } from './policy'

/**
 * The reminder email, per level, in the customer's language (customers.language,
 * Swedish unless 'en'). It shows what is left to pay, not the original total,
 * and the payment rows of the invoice email and the PDF, so the customer sees
 * one way to pay everywhere.
 *
 * No fee and no interest in v1 (decided 2026-10-26, accounted#104): nothing
 * here adds to what is owed. Level 3 is a final reminder, not an
 * inkassovarning: a company reminding by mail without a collections
 * connection has no inkasso to hand the claim to.
 *
 * A company's own texts (company_settings.reminder_text_overrides) replace the
 * Swedish stock texts per level and field; they go through the same
 * placeholder pass and escaping as the stock texts. English mail keeps the
 * stock English texts, since the company's texts are written in Swedish.
 */

/** Placeholders a reminder text may use; the settings legend lists them. */
export const REMINDER_EMAIL_PLACEHOLDER_KEYS = [
  'fakturanummer',
  'kundnamn',
  'förnamn',
  'företag',
  'fakturadatum',
  'förfallodatum',
  'belopp',
  'dagar',
  'betala_senast',
] as const

/** The final reminder asks for payment within this many days of its send date, shown as a date. */
export const FINAL_REMINDER_PAY_WITHIN_DAYS = 8

export const REMINDER_EMAIL_DEFAULT_TEXTS: Record<EmailLang, Record<ReminderLevel, { subject: string; body: string }>> = {
  sv: {
    1: {
      subject: 'Vänlig påminnelse: Faktura {fakturanummer} - {belopp}',
      body:
        'Vi vill påminna dig om att faktura {fakturanummer} förföll till betalning den {förfallodatum}. '
        + 'Om du redan har betalat kan du bortse från den här påminnelsen.',
    },
    2: {
      subject: 'Andra påminnelsen: Faktura {fakturanummer} - {belopp}',
      body:
        'Trots vår tidigare påminnelse har vi ännu inte fått betalt för faktura {fakturanummer}, '
        + 'som förföll den {förfallodatum}. Vi ber dig betala det som återstår så snart som möjligt.',
    },
    3: {
      subject: 'Slutlig påminnelse: Faktura {fakturanummer} - {belopp}',
      body:
        'Det här är en slutlig påminnelse om faktura {fakturanummer}, som förföll den {förfallodatum}. '
        + 'Vi har trots tidigare påminnelser inte fått din betalning och ber dig betala senast den {betala_senast}.',
    },
  },
  en: {
    1: {
      subject: 'Friendly reminder: Invoice {fakturanummer} - {belopp}',
      body:
        'This is a reminder that invoice {fakturanummer} was due for payment on {förfallodatum}. '
        + 'If you have already paid, please disregard this reminder.',
    },
    2: {
      subject: 'Second reminder: Invoice {fakturanummer} - {belopp}',
      body:
        'Despite our earlier reminder we have not yet received payment for invoice {fakturanummer}, '
        + 'which was due on {förfallodatum}. Please pay the remaining amount as soon as possible.',
    },
    3: {
      subject: 'Final reminder: Invoice {fakturanummer} - {belopp}',
      body:
        'This is a final reminder about invoice {fakturanummer}, which was due on {förfallodatum}. '
        + 'Despite earlier reminders we have not received your payment, and we ask you to pay by {betala_senast}.',
    },
  },
}

const WORDS = {
  sv: {
    heading: { 1: 'Vänlig påminnelse', 2: 'Andra påminnelsen', 3: 'Slutlig påminnelse' } as Record<ReminderLevel, string>,
    from: (company: string) => `från ${company}`,
    greeting: (firstName: string) => `Hej${firstName ? ` ${firstName}` : ''},`,
    invoiceNumber: 'Fakturanummer:',
    invoiceDate: 'Fakturadatum:',
    dueDate: 'Förfallodatum:',
    invoiceAmount: 'Fakturabelopp:',
    paid: 'Betalt:',
    remaining: 'Att betala:',
    paymentHeading: 'Betalningsinformation',
    actionLead: 'Har du redan betalat, eller stämmer något inte med fakturan?',
    actionLink: 'Meddela oss här',
    questions: 'Har du frågor? Svara direkt på det här mejlet.',
    sincerely: 'Med vänliga hälsningar,',
    orgNo: 'Org.nr:',
    vat: 'VAT:',
  },
  en: {
    heading: { 1: 'Friendly reminder', 2: 'Second reminder', 3: 'Final reminder' } as Record<ReminderLevel, string>,
    from: (company: string) => `from ${company}`,
    greeting: (firstName: string) => `Hi${firstName ? ` ${firstName}` : ''},`,
    invoiceNumber: 'Invoice number:',
    invoiceDate: 'Invoice date:',
    dueDate: 'Due date:',
    invoiceAmount: 'Invoice amount:',
    paid: 'Paid:',
    remaining: 'Amount due:',
    paymentHeading: 'Payment information',
    actionLead: 'Already paid, or is something wrong with the invoice?',
    actionLink: 'Let us know here',
    questions: 'Questions? Reply directly to this email.',
    sincerely: 'Kind regards,',
    orgNo: 'Reg. no.:',
    vat: 'VAT:',
  },
} as const

// Statutory Swedish phrase, kept verbatim in both languages (as on the invoice email).
const F_SKATT = 'Innehar F-skattsedel'

export interface ReminderEmailData {
  level: ReminderLevel
  invoice: Invoice
  customer: Customer
  company: CompanySettings
  /** What the invoice asked for (collectionClaim().amount), in the invoice currency. */
  amount: number
  /** What is left to pay (collectionClaim().remaining), in the invoice currency. */
  remaining: number
  /** The date the final reminder asks payment by (ISO): its send date plus FINAL_REMINDER_PAY_WITHIN_DAYS. */
  payBy: string
  /** Whole days past the due date today. */
  overdueDays: number
  /** The customer's page to answer "already paid" or "disputed"; null leaves the line out. */
  actionUrl: string | null
  /** The Reply-To the mail goes with; without one the "reply to this mail" line is left out. */
  replyTo?: string | null
}

export interface RenderedReminderEmail {
  subject: string
  html: string
  text: string
}

function langOf(customer: Customer): EmailLang {
  return customer.language === 'en' ? 'en' : 'sv'
}

/** The company's text for this level and field, Swedish mail only; undefined means the stock text. */
function companyText(company: CompanySettings, level: ReminderLevel, field: keyof ReminderTextOverride, lang: EmailLang): string | undefined {
  if (lang !== 'sv') return undefined
  const overrides = company.reminder_text_overrides
  const levelTexts = overrides && typeof overrides === 'object' ? overrides[`level_${level}`] : undefined
  const value = levelTexts && typeof levelTexts === 'object' ? levelTexts[field] : undefined
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function brandColor(value: string | null | undefined): string {
  return value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : '#111111'
}

export function renderReminderEmail(data: ReminderEmailData): RenderedReminderEmail {
  const { level, invoice, customer } = data
  const company = companyWithInvoicePaymentAccount(data.company, invoice.currency, invoice.payment_details ?? null)
  const lang = langOf(customer)
  const W = WORDS[lang]
  const stock = REMINDER_EMAIL_DEFAULT_TEXTS[lang][level]
  const companyName = getCompanyDisplayName(company)
  const amount = formatCurrencyForCustomer(data.remaining, invoice.currency, lang)

  const values: Record<string, string> = {
    fakturanummer: invoice.invoice_number ?? '',
    kundnamn: (customer.name || '').trim(),
    förnamn: customerGreetingName(customer),
    företag: companyName,
    fakturadatum: formatDate(invoice.invoice_date),
    förfallodatum: formatDate(invoice.due_date),
    belopp: amount,
    dagar: String(data.overdueDays),
    betala_senast: formatDate(data.payBy),
  }
  const subject = sanitizeSubjectLine(applyPlaceholders(companyText(data.company, level, 'subject', lang) ?? stock.subject, values))
  const body = applyPlaceholders(companyText(data.company, level, 'body', lang) ?? stock.body, values)

  const summary: Array<[string, string]> = [
    [W.invoiceNumber, invoice.invoice_number ?? ''],
    [W.invoiceDate, formatDate(invoice.invoice_date)],
    [W.dueDate, formatDate(invoice.due_date)],
  ]
  // A part payment shows what the invoice asked for and what came in, so the
  // smaller amount asked for is not a surprise.
  const paid = roundOre(data.amount - data.remaining)
  if (paid > 0) {
    summary.push(
      [W.invoiceAmount, formatCurrencyForCustomer(data.amount, invoice.currency, lang)],
      [W.paid, formatCurrencyForCustomer(paid, invoice.currency, lang)],
    )
  }
  const payment = invoiceEmailPaymentRows(company, invoice, lang)
  const footer = company.org_number
    ? [`${W.orgNo} ${company.org_number}`, company.vat_number ? `${W.vat} ${company.vat_number}` : null, company.f_skatt ? F_SKATT : null]
        .filter((part): part is string => part !== null)
        .join(' | ')
    : null

  return {
    subject,
    html: reminderHtml({ data, lang, body, summary, amount, payment, footer, companyName }),
    text: reminderText({ data, lang, body, summary, amount, payment, footer, companyName }),
  }
}

interface Parts {
  data: ReminderEmailData
  lang: EmailLang
  body: string
  summary: Array<[string, string]>
  amount: string
  payment: Array<{ label: string; value: string; emphasis?: boolean }>
  footer: string | null
  companyName: string
}

const MUTED = 'color: #666; font-size: 14px;'

function cellRow(label: string, value: string, valueStyle = ''): string {
  return `<tr><td style="padding: 6px 0; ${MUTED}">${escapeHtml(label)}</td><td style="padding: 6px 0; text-align: right;${valueStyle}">${escapeHtml(value)}</td></tr>`
}

function reminderHtml({ data, lang, body, summary, amount, payment, footer, companyName }: Parts): string {
  const W = WORDS[lang]
  const color = brandColor(data.company.invoice_primary_color)
  const heading = `${W.heading[data.level]} ${W.from(companyName)}`
  const paymentRows = payment.map((row) => cellRow(row.label, row.value, row.emphasis ? ' font-weight: 500;' : '')).join('')
  const action = data.actionUrl
    ? `<p style="margin: 0 0 20px 0;">${escapeHtml(W.actionLead)} <a href="${escapeHtml(data.actionUrl)}" style="color: ${color};">${escapeHtml(W.actionLink)}</a></p>`
    : ''
  const questions = data.replyTo ? `<p style="margin: 0 0 10px 0; ${MUTED}">${escapeHtml(W.questions)}</p>` : ''
  const legal = footer ? `<p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">${escapeHtml(footer)}</p>` : ''

  return [
    '<!DOCTYPE html>',
    `<html lang="${lang}">`,
    `<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(heading)}</title></head>`,
    `<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333;">`,
    `<div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">`,
    `<h1 style="margin: 0 0 24px 0; padding-bottom: 16px; border-bottom: 2px solid ${color}; font-size: 22px; font-weight: 600; color: ${color};">${escapeHtml(heading)}</h1>`,
    `<p style="margin: 0 0 15px 0;">${escapeHtml(W.greeting(customerGreetingName(data.customer)))}</p>`,
    `<p style="margin: 0 0 25px 0;">${userTextToHtml(body)}</p>`,
    `<table style="width: 100%; border-collapse: collapse; background: #f8f9fa; border-radius: 8px; margin-bottom: 25px;">`,
    summary.map(([label, value]) => cellRow(label, value)).join(''),
    cellRow(W.remaining, amount, ` font-size: 18px; font-weight: 600; color: ${color};`),
    '</table>',
    `<h2 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600; color: ${color};">${escapeHtml(W.paymentHeading)}</h2>`,
    `<table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">${paymentRows}</table>`,
    action,
    `<div style="padding-top: 20px; border-top: 1px solid #e5e7eb;">`,
    questions,
    `<p style="margin: 0; ${MUTED}">${escapeHtml(W.sincerely)}<br><strong style="color: ${color};">${escapeHtml(companyName)}</strong></p>`,
    legal,
    '</div>',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}

function reminderText({ data, lang, body, summary, amount, payment, footer, companyName }: Parts): string {
  const W = WORDS[lang]
  const lines = [
    `${W.heading[data.level]} ${W.from(companyName)}`,
    '',
    W.greeting(customerGreetingName(data.customer)),
    '',
    body,
    '',
    ...summary.map(([label, value]) => `${label} ${value}`),
    `${W.remaining} ${amount}`,
    '',
    `${W.paymentHeading}:`,
    ...payment.map((row) => `${row.label} ${row.value}`),
    '',
  ]
  if (data.actionUrl) lines.push(`${W.actionLead} ${W.actionLink}: ${data.actionUrl}`, '')
  if (data.replyTo) lines.push(W.questions, '')
  lines.push(W.sincerely, companyName)
  if (footer) lines.push('', footer)
  return `${lines.join('\n')}\n`
}
