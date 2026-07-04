import type { Invoice, Customer, CompanySettings, InvoiceDocumentType } from '@/types'
import { formatDate, getCompanyDisplayName, getCompanyPrimaryName } from '@/lib/utils'
import { applyPlaceholders, sanitizeSubjectLine, userTextToHtml } from './user-text'

type EmailLang = 'sv' | 'en'

// Customer-facing labels. Statutory chapter references stay intact in both
// locales. lib/utils.ts formatCurrency() keeps the Swedish "kr" symbol for
// in-app financial UI per the accounting standard; here we want the ISO code
// so a non-Swedish recipient understands the unit.
const LABELS = {
  sv: {
    docInvoice: 'Faktura',
    docCreditNote: 'Kreditfaktura',
    docProforma: 'Proformafaktura',
    docDeliveryNote: 'Följesedel',
    htmlLang: 'sv',
    documentFrom: (doc: string, sender: string) => `${doc} från ${sender}`,
    documentNumber: (doc: string) => `${doc}nummer:`,
    documentDate: (doc: string) => `${doc}datum:`,
    dueDate: 'Förfallodatum:',
    greeting: (firstName: string) => `Hej${firstName ? ` ${firstName}` : ''},`,
    bodyCreditNote: 'Bifogat hittar du en kreditfaktura som korrigerar en tidigare faktura.',
    bodyInvoice: 'Tack för ditt förtroende! Bifogat hittar du din faktura.',
    toPay: 'Att betala:',
    paymentHeading: 'Betalningsinformation',
    bank: 'Bank:',
    account: 'Kontonummer:',
    iban: 'IBAN:',
    bic: 'BIC/SWIFT:',
    message: 'Meddelande:',
    questions: 'Har du frågor om fakturan? Svara direkt på detta mejl så hjälper vi dig.',
    sincerely: 'Med vänliga hälsningar,',
    orgNo: 'Org.nr:',
    vat: 'VAT:',
    fSkatt: 'Innehar F-skattsedel',
    documentSummary: (doc: string) => `${doc.toLowerCase()}sammanfattning:`,
    subjectFrom: (doc: string, num: string, sender: string) => `${doc} ${num} från ${sender}`,
  },
  en: {
    docInvoice: 'Invoice',
    docCreditNote: 'Credit note',
    docProforma: 'Proforma invoice',
    docDeliveryNote: 'Delivery note',
    htmlLang: 'en',
    documentFrom: (doc: string, sender: string) => `${doc} from ${sender}`,
    documentNumber: (doc: string) => `${doc} number:`,
    documentDate: (doc: string) => `${doc} date:`,
    dueDate: 'Due date:',
    greeting: (firstName: string) => `Hi${firstName ? ` ${firstName}` : ''},`,
    bodyCreditNote: 'Attached you will find a credit note that corrects an earlier invoice.',
    bodyInvoice: 'Thank you for your business. Attached you will find your invoice.',
    toPay: 'Total due:',
    paymentHeading: 'Payment information',
    bank: 'Bank:',
    account: 'Account number:',
    iban: 'IBAN:',
    bic: 'BIC/SWIFT:',
    message: 'Reference:',
    questions: 'Questions about the invoice? Reply directly to this email and we will help you.',
    sincerely: 'Kind regards,',
    orgNo: 'Reg. no.:',
    vat: 'VAT:',
    // Statutory Swedish phrase: kept verbatim in both locales. F-skatt is a
    // Swedish tax-authority designation; translating it has no legal standing.
    fSkatt: 'Innehar F-skattsedel',
    documentSummary: (doc: string) => `${doc} summary:`,
    subjectFrom: (doc: string, num: string, sender: string) => `${doc} ${num} from ${sender}`,
  },
} as const

// Placeholder keys available in company-editable email texts
// (company_settings.invoice_email_texts). Rendered as a legend in the
// settings UI; kept here rather than in messages/*.json because ICU message
// syntax treats literal braces as interpolation.
export const INVOICE_EMAIL_PLACEHOLDER_KEYS = [
  'fakturanummer',
  'kundnamn',
  'förnamn',
  'företag',
  'förfallodatum',
  'belopp',
] as const

// Display strings for the settings UI's input placeholder attributes.
// subject and greeting are functions in LABELS, so their pattern form is
// hand-written here; body/signoff reference LABELS directly so they cannot
// drift from the actual defaults.
export const INVOICE_EMAIL_DEFAULT_TEXTS = {
  sv: {
    subject: 'Faktura {fakturanummer} från {företag}',
    greeting: 'Hej {förnamn},',
    body: LABELS.sv.bodyInvoice,
    signoff: LABELS.sv.sincerely,
  },
  en: {
    subject: 'Invoice {fakturanummer} from {företag}',
    greeting: 'Hi {förnamn},',
    body: LABELS.en.bodyInvoice,
    signoff: LABELS.en.sincerely,
  },
} as const

function resolveLang(customer: Customer): EmailLang {
  return customer.language === 'en' ? 'en' : 'sv'
}

// Custom texts apply ONLY to standard invoices. Credit notes, proforma and
// delivery notes always use the stock texts: a custom "Tack för ditt
// förtroende..." body or "Faktura..." subject would be wrong on those.
function isStandardInvoice(invoice: Invoice): boolean {
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  return docType === 'invoice' && !invoice.credited_invoice_id
}

function getDocumentLabel(invoice: Invoice, lang: EmailLang): string {
  const L = LABELS[lang]
  if (invoice.credited_invoice_id) return L.docCreditNote
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  if (docType === 'proforma') return L.docProforma
  if (docType === 'delivery_note') return L.docDeliveryNote
  return L.docInvoice
}

// Currency for the customer-facing total: explicit ISO code so a non-Swedish
// recipient reads "1 234,56 SEK" instead of the Swedish symbol "kr". Use the
// English locale for digit grouping when the email is in English so the comma
// thousands separator matches reader expectation.
function formatCurrencyForCustomer(amount: number, currency: string, lang: EmailLang): string {
  const formatted = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'sv-SE', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${formatted} ${currency}`
}

export interface InvoiceEmailData {
  invoice: Invoice
  customer: Customer
  company: CompanySettings
}

function buildPlaceholderValues(data: InvoiceEmailData, lang: EmailLang): Record<string, string> {
  const { invoice, customer, company } = data
  const fullName = (customer.name || '').trim()
  return {
    fakturanummer: invoice.invoice_number ?? '',
    kundnamn: fullName,
    förnamn: fullName ? fullName.split(' ')[0] : '',
    företag: getCompanyPrimaryName(company),
    förfallodatum: formatDate(invoice.due_date),
    belopp: formatCurrencyForCustomer(invoice.total, invoice.currency, lang),
  }
}

interface ResolvedCustomTexts {
  subject?: string
  greeting?: string
  body?: string
  signoff?: string
}

// Resolves the company's custom email texts for one language. Per-field
// fallback: missing / non-string / whitespace-only values return undefined
// and the caller uses the stock text. Returns RAW substituted strings:
// escaping is the caller's job per output variant (HTML vs text vs subject).
// Defensive typeof checks: rows can be written outside Zod (scripts, SQL).
function resolveCustomTexts(data: InvoiceEmailData, lang: EmailLang): ResolvedCustomTexts {
  if (!isStandardInvoice(data.invoice)) return {}
  const texts = data.company.invoice_email_texts
  const langTexts = texts && typeof texts === 'object' ? texts[lang] : undefined
  if (!langTexts || typeof langTexts !== 'object') return {}
  const values = buildPlaceholderValues(data, lang)
  const pick = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? applyPlaceholders(v.trim(), values) : undefined
  return {
    subject: pick(langTexts.subject),
    greeting: pick(langTexts.greeting),
    body: pick(langTexts.body),
    signoff: pick(langTexts.signoff),
  }
}

// Minimal hex validator: guards against branding values that bypass the
// settings UI and could inject CSS via crafted strings. Anything malformed
// falls back to the legacy default.
function safeBrandingColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  return /^#[0-9A-Fa-f]{6}$/.test(value) ? value : fallback
}

/**
 * Generate HTML email for sending an invoice
 */
export function generateInvoiceEmailHtml(data: InvoiceEmailData): string {
  const { invoice, customer, company } = data

  const lang = resolveLang(customer)
  const L = LABELS[lang]
  const documentType = getDocumentLabel(invoice, lang)
  const isCreditNote = !!invoice.credited_invoice_id
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'
  const isProforma = docType === 'proforma'
  const hidePayment = isCreditNote || isDeliveryNote || isProforma
  const firstName = customer.name ? customer.name.split(' ')[0] : ''
  const custom = resolveCustomTexts(data, lang)

  // Primary color drives the heading accent and the highlighted total. The
  // accent is sanitized to a strict hex pattern: anything else falls back
  // to the legacy dark neutral. Credit notes intentionally use the success
  // green for the total regardless of branding, because the customer's brain
  // is wired to expect "money coming back = green".
  const primaryColor = safeBrandingColor(company.invoice_primary_color, '#111111')

  return `
<!DOCTYPE html>
<html lang="${L.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${documentType} ${invoice.invoice_number}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <!-- Header -->
    <div style="margin-bottom: 30px; border-bottom: 2px solid ${primaryColor}; padding-bottom: 16px;">
      <h1 style="margin: 0 0 10px 0; font-size: 24px; font-weight: 600; color: ${primaryColor};">
        ${L.documentFrom(documentType, getCompanyPrimaryName(company))}
      </h1>
      <p style="margin: 0; color: #666; font-size: 14px;">
        ${L.documentNumber(documentType)} ${invoice.invoice_number}
      </p>
    </div>

    <!-- Greeting -->
    <div style="margin-bottom: 30px;">
      <p style="margin: 0 0 15px 0;">
        ${custom.greeting !== undefined ? userTextToHtml(custom.greeting) : L.greeting(firstName)}
      </p>
      <p style="margin: 0;">
        ${custom.body !== undefined ? userTextToHtml(custom.body) : (isCreditNote ? L.bodyCreditNote : L.bodyInvoice)}
      </p>
    </div>

    <!-- Summary Box -->
    <div style="background: #f8f9fa; border-radius: 8px; padding: 25px; margin-bottom: 30px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">${L.documentNumber(documentType)}</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${invoice.invoice_number}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">${L.documentDate(documentType)}</td>
          <td style="padding: 8px 0; text-align: right;">${formatDate(invoice.invoice_date)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">${L.dueDate}</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500; color: ${isCreditNote ? '#333' : '#e11d48'};">
            ${formatDate(invoice.due_date)}
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding: 15px 0 8px 0; border-top: 1px solid #e5e7eb;"></td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 18px; font-weight: 600;">${L.toPay}</td>
          <td style="padding: 8px 0; text-align: right; font-size: 18px; font-weight: 600; color: ${isCreditNote ? '#059669' : primaryColor};">
            ${formatCurrencyForCustomer(invoice.total, invoice.currency, lang)}
          </td>
        </tr>
      </table>
    </div>

    <!-- Payment Details -->
    ${!hidePayment ? `
    <div style="margin-bottom: 30px;">
      <h2 style="margin: 0 0 15px 0; font-size: 16px; font-weight: 600; color: ${primaryColor};">
        ${L.paymentHeading}
      </h2>
      <table style="width: 100%; border-collapse: collapse;">
        ${company.bank_name ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px; width: 140px;">${L.bank}</td>
          <td style="padding: 6px 0;">${company.bank_name}</td>
        </tr>
        ` : ''}
        ${company.clearing_number && company.account_number ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">${L.account}</td>
          <td style="padding: 6px 0;">${company.clearing_number}-${company.account_number}</td>
        </tr>
        ` : ''}
        ${company.iban ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">${L.iban}</td>
          <td style="padding: 6px 0;">${company.iban}</td>
        </tr>
        ` : ''}
        ${company.bic ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">${L.bic}</td>
          <td style="padding: 6px 0;">${company.bic}</td>
        </tr>
        ` : ''}
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">${L.message}</td>
          <td style="padding: 6px 0; font-weight: 500;">${invoice.invoice_number}</td>
        </tr>
      </table>
    </div>
    ` : ''}

    <!-- Footer -->
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
      <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
        ${L.questions}
      </p>
      <p style="margin: 0; color: #666; font-size: 14px;">
        ${custom.signoff !== undefined ? userTextToHtml(custom.signoff) : L.sincerely}<br>
        <strong style="color: ${primaryColor};">${getCompanyPrimaryName(company)}</strong>
      </p>
      ${company.org_number ? `
      <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">
        ${L.orgNo} ${company.org_number}
        ${company.vat_number ? ` | ${L.vat} ${company.vat_number}` : ''}
        ${company.f_skatt ? ` | ${L.fSkatt}` : ''}
      </p>
      ` : ''}
    </div>
  </div>
</body>
</html>
`
}

/**
 * Generate plain text email for sending an invoice
 */
export function generateInvoiceEmailText(data: InvoiceEmailData): string {
  const { invoice, customer, company } = data

  const lang = resolveLang(customer)
  const L = LABELS[lang]
  const documentType = getDocumentLabel(invoice, lang)
  const isCreditNote = !!invoice.credited_invoice_id
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'
  const isProforma = docType === 'proforma'
  const hidePayment = isCreditNote || isDeliveryNote || isProforma
  const firstName = customer.name ? customer.name.split(' ')[0] : ''
  const custom = resolveCustomTexts(data, lang)

  let text = `${L.documentFrom(documentType, getCompanyPrimaryName(company))}\n`
  text += `${L.documentNumber(documentType)} ${invoice.invoice_number}\n\n`

  text += `${custom.greeting ?? L.greeting(firstName)}\n\n`

  text += `${custom.body ?? (isCreditNote ? L.bodyCreditNote : L.bodyInvoice)}\n\n`

  text += `${L.documentSummary(documentType)}\n`
  text += `---\n`
  text += `${L.documentNumber(documentType)} ${invoice.invoice_number}\n`
  text += `${L.documentDate(documentType)} ${formatDate(invoice.invoice_date)}\n`
  text += `${L.dueDate} ${formatDate(invoice.due_date)}\n`
  text += `${L.toPay} ${formatCurrencyForCustomer(invoice.total, invoice.currency, lang)}\n`
  text += `---\n\n`

  if (!hidePayment) {
    text += `${L.paymentHeading}:\n`
    if (company.bank_name) text += `${L.bank} ${company.bank_name}\n`
    if (company.clearing_number && company.account_number) {
      text += `${L.account} ${company.clearing_number}-${company.account_number}\n`
    }
    if (company.iban) text += `${L.iban} ${company.iban}\n`
    if (company.bic) text += `${L.bic} ${company.bic}\n`
    text += `${L.message} ${invoice.invoice_number}\n\n`
  }

  text += `${L.questions}\n\n`
  text += `${custom.signoff ?? L.sincerely}\n`
  text += `${getCompanyDisplayName(company)}\n`

  if (company.org_number) {
    text += `\n${L.orgNo} ${company.org_number}`
    if (company.vat_number) text += ` | ${L.vat} ${company.vat_number}`
    if (company.f_skatt) text += ` | ${L.fSkatt}`
    text += `\n`
  }

  return text
}

/**
 * Generate email subject for an invoice
 */
export function generateInvoiceEmailSubject(data: InvoiceEmailData): string {
  const { invoice, customer, company } = data
  const lang = resolveLang(customer)
  const L = LABELS[lang]

  // Sanitization runs after substitution, so a pathological placeholder
  // value containing a newline is also flattened to a single header line.
  const custom = resolveCustomTexts(data, lang)
  if (custom.subject !== undefined) return sanitizeSubjectLine(custom.subject)

  const documentType = getDocumentLabel(invoice, lang)
  return L.subjectFrom(documentType, invoice.invoice_number ?? '', getCompanyPrimaryName(company))
}
