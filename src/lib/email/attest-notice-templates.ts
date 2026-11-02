import { getBranding } from '@/lib/branding/service'
import { attestMailHtml, attestMailList, attestMailParagraph, escapeHtml } from '@/lib/email/attest-mail-layout'
import { formatCurrency, formatDate } from '@/lib/utils'

/** The template's name, as the send log speaks of it. */
export const ATTEST_NOTICE_TEMPLATE = 'supplier_invoice_attest_notice'

export interface AttestNoticeEmailInvoice {
  supplierName: string
  /** The supplier's invoice number, or null (the ankomstnummer is shown instead). */
  invoiceNumber: string | null
  arrivalNumber: number
  total: number
  currency: string
  dueDate: string
}

export interface AttestNoticeEmailData {
  /** overdue: the due date passed without attest. blocked: nobody can attest under the current rules. */
  kind: 'overdue' | 'blocked'
  companyName: string
  invoices: AttestNoticeEmailInvoice[]
  /** overdue: the supplier invoice list; blocked: the attest rules. */
  url: string
  /** Why the recipient gets it: they registered the invoices, or they keep the company's books in the registrant's place. */
  reason: 'registrant' | 'fallback'
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

function invoiceLine(invoice: AttestNoticeEmailInvoice): string {
  const label = invoice.invoiceNumber ? `faktura ${invoice.invoiceNumber}` : `ankomstnummer ${invoice.arrivalNumber}`
  return `${invoice.supplierName}, ${label}, ${formatCurrency(invoice.total, invoice.currency)}, förfaller ${formatDate(invoice.dueDate)}`
}

export function generateAttestNoticeEmailSubject(data: AttestNoticeEmailData): string {
  const only = data.invoices.length === 1 ? data.invoices[0] : undefined
  if (data.kind === 'overdue') {
    return only
      ? `${only.supplierName} ${formatCurrency(only.total, only.currency)} har passerat förfallodagen utan attest`
      : `${data.invoices.length} leverantörsfakturor har passerat förfallodagen utan attest`
  }
  return only
    ? `Ingen kan attestera ${only.supplierName} ${formatCurrency(only.total, only.currency)}`
    : `${data.invoices.length} leverantörsfakturor kan inte attesteras`
}

function body(data: AttestNoticeEmailData): string {
  const one = data.invoices.length === 1
  if (data.kind === 'overdue') {
    return one
      ? `Fakturan nedan till ${data.companyName} har passerat förfallodagen och är fortfarande inte attesterad, så den betalas inte. Påminn attestanten, så kan den betalas när attesten är klar.`
      : `Fakturorna nedan till ${data.companyName} har passerat förfallodagen och är fortfarande inte attesterade, så de betalas inte. Påminn attestanten, så kan de betalas när attesten är klar.`
  }
  return one
    ? `Med attestreglerna som gäller i ${data.companyName} kan ingen attestera fakturan nedan, till exempel för att den enda attestanten registrerade den själv. Den betalas inte förrän någon kan attestera den. Lägg till en attestant, eller slå på Den som registrerar får också attestera, under Inställningar, Attest.`
    : `Med attestreglerna som gäller i ${data.companyName} kan ingen attestera fakturorna nedan, till exempel för att den enda attestanten registrerade dem själv. De betalas inte förrän någon kan attestera dem. Lägg till en attestant, eller slå på Den som registrerar får också attestera, under Inställningar, Attest.`
}

function footer(data: AttestNoticeEmailData, appName: string): string {
  const why =
    data.reason === 'registrant'
      ? `Du får mejlet för att du registrerade fakturorna i ${data.companyName}.`
      : `Du får mejlet för att du är ägare eller administratör i ${data.companyName} och den som registrerade fakturorna inte längre är med i bolaget.`
  return `${why} Står du i ett annat bolag i ${appName}, byt till ${data.companyName} först.`
}

function buttonLabel(data: AttestNoticeEmailData): string {
  return data.kind === 'overdue' ? 'Öppna leverantörsfakturorna' : 'Öppna attestreglerna'
}

/**
 * The registrant's side of the batched attest mail: told once when an
 * invoice passes its due date without attest, and once when nobody can
 * attest it under the current rules, so it never waits in silence. Swedish
 * only, like the other attest surfaces.
 */
export function generateAttestNoticeEmailHtml(data: AttestNoticeEmailData): string {
  const appName = data.appName ?? getBranding().appName
  return attestMailHtml({
    title: generateAttestNoticeEmailSubject(data),
    bodyHtml: `${attestMailParagraph(body(data))}
      ${attestMailList(data.invoices.map((i) => escapeHtml(invoiceLine(i))))}`,
    button: { label: buttonLabel(data), url: data.url },
    footer: footer(data, appName),
    appName,
  })
}

export function generateAttestNoticeEmailText(data: AttestNoticeEmailData): string {
  const appName = data.appName ?? getBranding().appName
  return [body(data), '', ...data.invoices.map((i) => `- ${invoiceLine(i)}`), '', `${buttonLabel(data)}: ${data.url}`, '', footer(data, appName)].join('\n')
}
