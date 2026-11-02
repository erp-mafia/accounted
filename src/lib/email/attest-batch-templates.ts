import { attestMailHtml, attestMailParagraph, escapeHtml } from '@/lib/email/attest-mail-layout'
import { formatCurrency, formatDate } from '@/lib/utils'

/** The template's name, as the send log speaks of it. */
export const ATTEST_BATCH_TEMPLATE = 'supplier_invoice_attest_batch'

/** One invoice the mail asks about. */
export interface AttestBatchEmailInvoice {
  supplierName: string
  /** The supplier's invoice number, or null (the ankomstnummer is shown instead). */
  invoiceNumber: string | null
  arrivalNumber: number
  total: number
  currency: string
  dueDate: string
}

export interface AttestBatchEmailData {
  /** request: the round of newly registered invoices; reminder: the ones due soon, still waiting. */
  kind: 'request' | 'reminder'
  companyName: string
  /** Every invoice waiting on the attester, soonest due first. */
  invoices: AttestBatchEmailInvoice[]
  /** Who registered them, when it is one person. */
  registeredBy: string | null
  /** The page with every invoice: approve them all or reject one. */
  url: string
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

function invoiceLabel(invoice: AttestBatchEmailInvoice): string {
  return invoice.invoiceNumber ? `faktura ${invoice.invoiceNumber}` : `ankomstnummer ${invoice.arrivalNumber}`
}

function invoiceLine(invoice: AttestBatchEmailInvoice): string {
  return `${invoice.supplierName}, ${invoiceLabel(invoice)}, ${formatCurrency(invoice.total, invoice.currency)}, förfaller ${formatDate(invoice.dueDate)}`
}

/** One invoice by supplier and amount, several by count. */
export function generateAttestBatchEmailSubject(data: AttestBatchEmailData): string {
  const only = data.invoices.length === 1 ? data.invoices[0] : undefined
  if (only) {
    const what = `${only.supplierName} ${formatCurrency(only.total, only.currency)}`
    return data.kind === 'reminder' ? `Påminnelse: attestera ${what}, förfaller ${formatDate(only.dueDate)}` : `Attestera ${what}`
  }
  const count = `${data.invoices.length} leverantörsfakturor väntar på din attest`
  return data.kind === 'reminder' ? `Påminnelse: ${count}` : count
}

function intro(data: AttestBatchEmailData): string {
  const one = data.invoices.length === 1
  const registered = data.registeredBy ? ` ${data.registeredBy} har registrerat ${one ? 'den' : 'dem'}.` : ''
  if (data.kind === 'reminder') {
    return one
      ? `En leverantörsfaktura till ${data.companyName} förfaller snart och väntar fortfarande på din attest.${registered}`
      : `De här leverantörsfakturorna till ${data.companyName} förfaller snart och väntar fortfarande på din attest.${registered}`
  }
  return one
    ? `En leverantörsfaktura till ${data.companyName} väntar på din attest.${registered}`
    : `${data.invoices.length} leverantörsfakturor till ${data.companyName} väntar på din attest.${registered}`
}

function how(data: AttestBatchEmailData): string {
  return data.invoices.length === 1
    ? 'Den betalas inte förrän den är attesterad. Knappen öppnar en sida med underlaget, där du godkänner eller nekar den. Du behöver inte logga in.'
    : 'De betalas inte förrän de är attesterade. Knappen öppnar en sida med underlagen, där du godkänner alla på en gång eller nekar en enskild. Du behöver inte logga in.'
}
const FOOTER =
  'Länken är personlig och gäller i sju dagar. Om du inte väntade dig det här mejlet kan du bortse från det. Du kan stänga av mejlen under Inställningar, Attest.'

/**
 * Plain and short, like the single invoice's attest mail it replaces: the
 * invoices waiting, one button to the page with all of them and the URL in
 * clear text beside it (so the mail does not pattern-match phishing). No
 * button decides anything by itself: a mail scanner that follows links
 * approves nothing. Swedish only, like the other attest surfaces.
 */
export function generateAttestBatchEmailHtml(data: AttestBatchEmailData): string {
  const rows = data.invoices
    .map(
      (i) => `<tr>
          <td style="padding: 8px 0; border-top: 1px solid #eee; font-size: 14px;"><strong>${escapeHtml(i.supplierName)}</strong><br><span style="color: #666;">${escapeHtml(invoiceLabel(i))}, förfaller ${escapeHtml(formatDate(i.dueDate))}</span></td>
          <td style="padding: 8px 0 8px 16px; border-top: 1px solid #eee; font-size: 14px; text-align: right; white-space: nowrap;">${escapeHtml(formatCurrency(i.total, i.currency))}</td>
        </tr>`,
    )
    .join('')
  return attestMailHtml({
    title: generateAttestBatchEmailSubject(data),
    bodyHtml: `${attestMailParagraph(intro(data))}
      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 16px 0;">${rows}</table>
      ${attestMailParagraph(how(data))}`,
    button: { label: 'Granska och attestera', url: data.url },
    showUrl: true,
    footer: FOOTER,
    appName: data.appName,
  })
}

export function generateAttestBatchEmailText(data: AttestBatchEmailData): string {
  return [
    intro(data),
    '',
    ...data.invoices.map((i) => `- ${invoiceLine(i)}`),
    '',
    how(data),
    '',
    `Granska och attestera: ${data.url}`,
    '',
    FOOTER,
  ].join('\n')
}
