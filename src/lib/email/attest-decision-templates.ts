import { getBranding } from '@/lib/branding/service'
import { attestMailHtml, attestMailList, attestMailParagraph, escapeHtml } from '@/lib/email/attest-mail-layout'
import { formatCurrency, formatDate } from '@/lib/utils'

/** The template's name, as the send log speaks of it. */
export const ATTEST_DECISION_TEMPLATE = 'supplier_invoice_attest_decision'

/** One invoice in the mail, with what the attester decided on it. */
export interface AttestDecisionEmailInvoice {
  supplierName: string
  /** The supplier's invoice number, or null (the ankomstnummer is shown instead). */
  invoiceNumber: string | null
  arrivalNumber: number
  total: number
  currency: string
  dueDate: string
  decision: 'approved' | 'rejected'
  /** The attester's comment on a rejection; null when none was given. */
  comment: string | null
}

export interface AttestDecisionEmailData {
  companyName: string
  /** Who decided: the attester's name, else their address. */
  attesterName: string
  /** Every invoice the attester decided in one go, approved and rejected alike. */
  invoices: AttestDecisionEmailInvoice[]
  /** The supplier invoice list, on the Att betala tab when something was approved. */
  listUrl: string
  /** Why the recipient gets it: they registered the invoices, or they keep the company's books in the registrant's place. */
  reason: 'registrant' | 'fallback'
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

function invoiceLabel(invoice: AttestDecisionEmailInvoice): string {
  return invoice.invoiceNumber ? `faktura ${invoice.invoiceNumber}` : `ankomstnummer ${invoice.arrivalNumber}`
}

function invoiceLine(invoice: AttestDecisionEmailInvoice): string {
  return `${invoice.supplierName}, ${invoiceLabel(invoice)}, ${formatCurrency(invoice.total, invoice.currency)}, förfaller ${formatDate(invoice.dueDate)}`
}

function split(data: AttestDecisionEmailData) {
  return {
    approved: data.invoices.filter((i) => i.decision === 'approved'),
    rejected: data.invoices.filter((i) => i.decision === 'rejected'),
  }
}

/**
 * One line that says what happened: one invoice by name and amount, several
 * by count, and a mixed answer as an answer.
 */
export function generateAttestDecisionEmailSubject(data: AttestDecisionEmailData): string {
  const { approved, rejected } = split(data)
  const who = data.attesterName
  if (data.invoices.length === 1) {
    const only = data.invoices[0]
    const verb = only.decision === 'approved' ? 'godkände' : 'nekade'
    return `${who} ${verb} ${only.supplierName} ${formatCurrency(only.total, only.currency)}`
  }
  if (rejected.length === 0) return `${who} godkände ${approved.length} fakturor till ${data.companyName}`
  if (approved.length === 0) return `${who} nekade ${rejected.length} fakturor till ${data.companyName}`
  return `${who} har svarat på ${data.invoices.length} fakturor till ${data.companyName}`
}

function footer(data: AttestDecisionEmailData, appName: string): string {
  const why =
    data.reason === 'registrant'
      ? `Du får mejlet för att du registrerade fakturorna i ${data.companyName}.`
      : `Du får mejlet för att du är ägare eller administratör i ${data.companyName} och den som registrerade fakturorna inte längre är med i bolaget.`
  return `${why} Står du i ett annat bolag i ${appName}, byt till ${data.companyName} först.`
}

/**
 * Plain and short, like the attest request it answers: the decision, the
 * invoices ready to pay, the rejected ones with the attester's comment, and
 * one button to the supplier invoice list. The recipient keeps the books of
 * a Swedish company, so Swedish only, like the other attest surfaces.
 */
export function generateAttestDecisionEmailHtml(data: AttestDecisionEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const { approved, rejected } = split(data)
  const list = (items: AttestDecisionEmailInvoice[], withComment: boolean) =>
    attestMailList(
      items.map(
        (i) =>
          `${escapeHtml(invoiceLine(i))}${withComment && i.comment ? `<br><span style="color: #666;">Kommentar: ${escapeHtml(i.comment)}</span>` : ''}`,
      ),
    )
  const approvedBlock =
    approved.length > 0
      ? `<p style="margin: 0 0 8px 0; font-size: 15px;"><strong>Redo att betala</strong>: attesterade och kan betalas nu.</p>${list(approved, false)}`
      : ''
  const rejectedBlock =
    rejected.length > 0
      ? `<p style="margin: 0 0 8px 0; font-size: 15px;"><strong>Nekade</strong>: betalas inte.</p>${list(rejected, true)}`
      : ''
  return attestMailHtml({
    title: generateAttestDecisionEmailSubject(data),
    bodyHtml: `${attestMailParagraph(`${data.attesterName} har svarat på attesten för ${data.companyName}.`)}
      ${approvedBlock}
      ${rejectedBlock}`,
    button: { label: 'Öppna leverantörsfakturorna', url: data.listUrl },
    footer: footer(data, appName),
    appName,
  })
}

export function generateAttestDecisionEmailText(data: AttestDecisionEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const { approved, rejected } = split(data)
  const lines = [`${data.attesterName} har svarat på attesten för ${data.companyName}.`, '']
  if (approved.length > 0) {
    lines.push('Redo att betala: attesterade och kan betalas nu.', ...approved.map((i) => `- ${invoiceLine(i)}`), '')
  }
  if (rejected.length > 0) {
    lines.push('Nekade: betalas inte.')
    for (const i of rejected) {
      lines.push(`- ${invoiceLine(i)}`)
      if (i.comment) lines.push(`  Kommentar: ${i.comment}`)
    }
    lines.push('')
  }
  lines.push(`Öppna leverantörsfakturorna: ${data.listUrl}`, '', footer(data, appName))
  return lines.join('\n')
}
