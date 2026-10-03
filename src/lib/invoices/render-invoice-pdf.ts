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
 *   4. renderToBuffer(InvoicePDF(...)).
 */
import { renderToBuffer } from '@react-pdf/renderer'
import QRCode from 'qrcode'
import { InvoicePDF, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender } from '@/lib/invoices/pdf-render-helpers'
import {
  resolveInvoicePaymentQr,
  type InvoicePdfPaymentQr,
  type ResolvedInvoicePaymentQr,
} from '@/lib/invoices/payment-qr'
import { BANK_PAYMENT_QR_QUIET_ZONE, bankPaymentQrSymbol } from '@/lib/invoices/bank-payment-qr'
import { invoiceRequiresPaymentAccount } from '@/lib/invoices/payment-accounts'
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
      const symbol = bankPaymentQrSymbol(qr.payload)
      return symbol ? { kind: qr.kind, caption: qr.caption, vector: symbol } : null
    }
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

export async function renderInvoicePdfBuffer(input: RenderInvoicePdfInput): Promise<RenderedInvoicePdf> {
  const { invoice, customer } = input
  const { branding, company } = await prepareInvoicePdfRender(input.company, invoice.currency, {
    paymentAccountRequired: input.paymentAccountRequired ?? invoiceRequiresPaymentAccount(invoice),
    payee: input.payee !== undefined ? input.payee : (invoice.payment_details ?? null),
  })
  // The template's own language rule, so the code's reference matches the page.
  const lang = input.language ?? customer?.language ?? 'sv'
  const paymentQr = resolveInvoicePaymentQr({ invoice, company, customer, lang })
  const buffer = await renderToBuffer(
    InvoicePDF({
      invoice,
      customer,
      items: input.items,
      company,
      originalInvoiceNumber: input.originalInvoiceNumber,
      isPreview: input.isPreview,
      language: input.language,
      branding,
      paymentQr: await buildInvoicePaymentQrImage(paymentQr),
    }),
  )
  return { buffer, paymentQr }
}
