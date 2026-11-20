import { getBranding } from '@/lib/branding/service'
import { formatCurrency, formatDate } from '@/lib/utils'

/** The template's name, as the send log speaks of it. */
export const ATTEST_REQUEST_TEMPLATE = 'supplier_invoice_attest_request'

export interface AttestRequestEmailData {
  companyName: string
  supplierName: string
  /** The supplier's invoice number, or null (the ankomstnummer is shown instead). */
  invoiceNumber: string | null
  arrivalNumber: number
  total: number
  currency: string
  dueDate: string
  /** Who registered the invoice, when known. */
  registeredBy: string | null
  approveUrl: string
  rejectUrl: string
  /** ISO instant the links run out. */
  expiresAt: string
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function invoiceLabel(data: AttestRequestEmailData): string {
  return data.invoiceNumber ? `faktura ${data.invoiceNumber}` : `ankomstnummer ${data.arrivalNumber}`
}

export function generateAttestRequestEmailSubject(data: AttestRequestEmailData): string {
  return `Attestera ${data.supplierName} ${formatCurrency(data.total, data.currency)}`
}

/**
 * Plain and short: which invoice, how much, when it falls due and who
 * registered it, then the two buttons with their URLs in clear text beside
 * them (so the mail does not pattern-match phishing). Both open the
 * invoice's page, which shows the PDF and asks for nothing but the decision
 * and an optional comment. The recipient is a member of a Swedish company
 * acting in its books, so Swedish only, like the other attest surfaces.
 */
export function generateAttestRequestEmailHtml(data: AttestRequestEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const company = escapeHtml(data.companyName)
  const supplier = escapeHtml(data.supplierName)
  const amount = escapeHtml(formatCurrency(data.total, data.currency))
  const label = escapeHtml(invoiceLabel(data))
  const approve = escapeHtml(data.approveUrl)
  const reject = escapeHtml(data.rejectUrl)
  const registered = data.registeredBy ? ` ${escapeHtml(data.registeredBy)} har registrerat den.` : ''

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attestera ${supplier} ${amount}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${escapeHtml(appName.toUpperCase())}</p>
      <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #111;">Attestera ${supplier} ${amount}</h1>
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        En leverantörsfaktura till ${company} väntar på din attest: ${label} från <strong>${supplier}</strong> på <strong>${amount}</strong>, förfaller ${escapeHtml(formatDate(data.dueDate))}.${registered}
      </p>
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        Fakturan betalas inte förrän den är attesterad. Länkarna öppnar fakturan, där du ser underlaget och svarar. Du behöver inte logga in.
      </p>
      <div style="margin: 28px 0;">
        <a href="${approve}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500; margin-right: 8px;">Godkänn</a>
        <a href="${reject}" style="display: inline-block; background: #fff; color: #111; text-decoration: none; padding: 11px 27px; border-radius: 8px; font-size: 14px; font-weight: 500; border: 1px solid #d4d4d4;">Neka</a>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 13px; color: #666; word-break: break-all;">
        Länken går till: <a href="${approve}" style="color: #666;">${approve}</a>
      </p>
      <p style="margin: 0; font-size: 13px; color: #999;">
        Länken är personlig, gäller i sju dagar och kan användas en gång. Om du inte väntade dig det här mejlet kan du bortse från det. Du kan stänga av mejlen under Inställningar, Attest.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateAttestRequestEmailText(data: AttestRequestEmailData): string {
  const amount = formatCurrency(data.total, data.currency)
  const registered = data.registeredBy ? ` ${data.registeredBy} har registrerat den.` : ''
  return [
    `En leverantörsfaktura till ${data.companyName} väntar på din attest: ${invoiceLabel(data)} från ${data.supplierName} på ${amount}, förfaller ${formatDate(data.dueDate)}.${registered}`,
    '',
    'Fakturan betalas inte förrän den är attesterad. Länkarna öppnar fakturan, där du ser underlaget och svarar. Du behöver inte logga in.',
    '',
    `Godkänn: ${data.approveUrl}`,
    `Neka: ${data.rejectUrl}`,
    '',
    'Länken är personlig, gäller i sju dagar och kan användas en gång. Om du inte väntade dig det här mejlet kan du bortse från det. Du kan stänga av mejlen under Inställningar, Attest.',
  ].join('\n')
}
