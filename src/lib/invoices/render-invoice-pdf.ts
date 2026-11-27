/**
 * The one way an invoice PDF is rendered.
 *
 * Every surface that produces an invoice PDF (send, v1 send, mark-sent
 * archive, recurring auto-send, the agent send, the dashboard and v1
 * downloads, the betalningsbekräftelse and the editor preview) calls
 * renderInvoicePdfBuffer, so they cannot disagree on the payee, the branding
 * or the payment QR code:
 *
 *   1. prepareInvoicePdfRender: branding, the invoice's payee applied to the
 *      company, the logo embedded;
 *   2. resolveInvoicePaymentQr: the ONE QR code this invoice prints, from
 *      that same company (so the code pays to the account the page prints);
 *   3. the QR image: a PNG data URL for Swish and the payment link, a vector
 *      path for the bank-app code, each with a quiet zone of 4 modules;
 *   4. renderToBuffer(InvoicePDF(...)), and once more when a long fine
 *      print pushed the payment area off the page the summary ends on (see
 *      renderInvoiceDocument).
 */
import type { InvoicePDFProps, InvoicePdfInvoice, InvoicePdfPlacement } from '@/lib/invoices/pdf-template'
import {
  resolveInvoicePaymentQr,
  type InvoicePdfPaymentQr,
  type ResolvedInvoicePaymentQr,
} from '@/lib/invoices/payment-qr'
import { BANK_PAYMENT_QR_QUIET_ZONE, bankPaymentQrSymbol } from '@/lib/invoices/bank-payment-qr'
import { invoiceRequiresPaymentAccount } from '@/lib/cash-accounts/invoice-payment-accounts'
import { createLogger } from '@/lib/logger'
import type { CompanySettings, Customer, InvoiceItem, InvoicePaymentAccount } from '@/types'

const log = createLogger('invoice.payment-qr')

/** Pixel width of the Swish and payment-link PNGs (drawn at 96pt). */
const PAYMENT_QR_PNG_WIDTH_PX = 300

export interface RenderInvoicePdfInput {
  invoice: InvoicePdfInvoice
  customer: Customer
  items: InvoiceItem[]
  /** The company settings row as stored: the payee and logo are applied here. */
  company: CompanySettings
  originalInvoiceNumber?: string
  isPreview?: boolean
  language?: 'sv' | 'en'
  /**
   * Refuse to render without a usable payee (InvoicePaymentAccountMissingError).
   * Default: whether the document asks for a payment (invoiceRequiresPaymentAccount).
   */
  paymentAccountRequired?: boolean
  /** The payee to print. Default: the invoice's own frozen payee (payment_details). */
  payee?: Partial<InvoicePaymentAccount> | null
}

export interface RenderedInvoicePdf {
  buffer: Buffer
  /** Which QR code the PDF carries, or why none (the preview reports it). */
  paymentQr: ResolvedInvoicePaymentQr
  /** How many pages the PDF has (the editor shows it next to the preview). */
  pageCount: number
}

/**
 * The number of pages of a rendered PDF. The renderer (pdfkit) writes one
 * uncompressed page object, `/Type /Page`, per page; `\b` keeps the
 * `/Type /Pages` tree root out of the count.
 */
export function countPdfPages(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
}

/**
 * Draw the resolved code: a vector path for the bank-app code (crisp at any
 * zoom, no image decoding), a PNG for Swish and the payment link. Null when
 * there is no code or it cannot be encoded; the PDF then prints no QR.
 */
export async function buildInvoicePaymentQrImage(
  qr: ResolvedInvoicePaymentQr,
): Promise<InvoicePdfPaymentQr | null> {
  if (qr.kind === null) return null
  try {
    if (qr.kind === 'bank_app') {
      const symbol = await bankPaymentQrSymbol(qr.payload)
      return symbol ? { kind: qr.kind, caption: qr.caption, vector: symbol } : null
    }
    const { default: QRCode } = await import('qrcode')
    const imageDataUrl = await QRCode.toDataURL(qr.payload, {
      margin: BANK_PAYMENT_QR_QUIET_ZONE,
      width: PAYMENT_QR_PNG_WIDTH_PX,
      errorCorrectionLevel: 'M',
    })
    return { kind: qr.kind, caption: qr.caption, imageDataUrl }
  } catch (err) {
    log.warn('payment QR could not be encoded; rendering without it', {
      kind: qr.kind,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Render the invoice PDF so the payment area stays on the page the summary
 * ends on. A long fine print, such as the statutory information an
 * electricity invoice must carry, follows the summary and the payment area
 * comes after it; when the two do not both fit on that page, the payment area
 * landed on the next one. Then it is rendered once more with the payment area
 * on the summary's page and the fine print starting on the page after. That
 * render is kept only when its payment area really is on the summary's page
 * (the summary ended too low to leave room for it otherwise).
 */
export async function renderInvoiceDocument(
  props: Omit<InvoicePDFProps, 'paymentAreaPage' | 'placement'>,
): Promise<{ buffer: Buffer; paymentAreaPage?: number }> {
  const [{ renderToBuffer }, { InvoicePDF }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/invoices/pdf-template'),
  ])
  const first: InvoicePdfPlacement = {}
  const buffer = await renderToBuffer(InvoicePDF({ ...props, placement: first }))
  const { summaryPage, paymentAreaPage } = first
  if (!first.finePrintCanFollow || summaryPage === undefined || paymentAreaPage === undefined || paymentAreaPage <= summaryPage) {
    return { buffer }
  }
  const second: InvoicePdfPlacement = {}
  const moved = await renderToBuffer(InvoicePDF({ ...props, paymentAreaPage: summaryPage, placement: second }))
  return second.paymentAreaPage === summaryPage ? { buffer: moved, paymentAreaPage: summaryPage } : { buffer }
}

export async function renderInvoicePdfBuffer(input: RenderInvoicePdfInput): Promise<RenderedInvoicePdf> {
  const { invoice, customer } = input
  // react-pdf, the template and its fonts load here, when an invoice PDF is
  // rendered, not with every route that reaches this module (pending
  // operations, the MCP server).
  const { prepareInvoicePdfRender } = await import('@/lib/invoices/pdf-render-helpers')
  const { branding, company } = await prepareInvoicePdfRender(input.company, invoice.currency, {
    paymentAccountRequired: input.paymentAccountRequired ?? invoiceRequiresPaymentAccount(invoice),
    payee: input.payee !== undefined ? input.payee : (invoice.payment_details ?? null),
  })
  // The template's own language rule, so the code's reference matches the page.
  const lang = input.language ?? customer?.language ?? 'sv'
  const paymentQr = resolveInvoicePaymentQr({ invoice, company, customer, lang })
  const { buffer } = await renderInvoiceDocument({
    invoice,
    customer,
    items: input.items,
    company,
    originalInvoiceNumber: input.originalInvoiceNumber,
    isPreview: input.isPreview,
    language: input.language,
    branding,
    paymentQr: await buildInvoicePaymentQrImage(paymentQr),
  })
  return { buffer, paymentQr, pageCount: countPdfPages(buffer) }
}
