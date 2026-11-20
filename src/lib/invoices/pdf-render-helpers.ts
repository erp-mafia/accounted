/**
 * Shared helpers for invoice PDF render call sites.
 *
 * Two responsibilities:
 *   1. Build the branding object from company settings.
 *   2. Resolve the company logo into a format @react-pdf/renderer can draw
 *      (lib/pdf/logo.ts, shared with the self-billing invoice), and hand the
 *      template a company whose `logo_url` is that data URL.
 *
 * The payment QR code is resolved and drawn by the render entry point,
 * lib/invoices/render-invoice-pdf.ts, which every invoice render goes
 * through.
 */

import type { CompanySettings, Currency, InvoicePaymentAccount } from '@/types'
import { brandingFromCompanySettings, type InvoiceBranding } from '@/lib/invoices/pdf-template'
import { embeddableLogoUrl } from '@/lib/pdf/logo'
import { prepareInvoiceFont } from '@/lib/invoices/pdf-fonts'
import {
  assertInvoicePaymentAccountForRender,
  companyWithInvoicePaymentAccount,
} from '@/lib/cash-accounts/invoice-payment-accounts'

export interface InvoicePdfRenderExtras {
  branding: InvoiceBranding
  /**
   * The company settings to pass to InvoicePDF. Identical to the input except
   * `logo_url` is replaced by an embedded PNG data URL when the stored logo
   * could be fetched and re-encoded, or set to null when the stored URL was
   * refused by the outbound URL guard (the invoice then renders without a
   * logo). A transient failure keeps the original URL only when it points at
   * the deployment's own storage origin; @react-pdf must never be handed an
   * arbitrary remote URL to fetch unguarded.
   */
  company: CompanySettings
}

export interface InvoicePdfRenderOptions {
  paymentAccountRequired?: boolean
  /**
   * The invoice's own frozen payee (invoices.payment_details) when it chose
   * a bank account. Null/undefined = the company's default for the currency.
   */
  payee?: Partial<InvoicePaymentAccount> | null
}

export async function prepareInvoicePdfRender(
  company: CompanySettings,
  currency?: Currency,
  options: InvoicePdfRenderOptions = {},
): Promise<InvoicePdfRenderExtras> {
  if (currency && options.paymentAccountRequired !== false) {
    assertInvoicePaymentAccountForRender(company, currency, options.payee ?? null)
  }
  const branding = await prepareInvoiceFont(
    company,
    brandingFromCompanySettings(company),
  )
  const paymentCompany = currency
    ? companyWithInvoicePaymentAccount(company, currency, options.payee ?? null)
    : company
  if (!paymentCompany.logo_url) return { branding, company: paymentCompany }

  const logoUrl = await embeddableLogoUrl(paymentCompany.logo_url)
  return {
    branding,
    company: logoUrl === paymentCompany.logo_url ? paymentCompany : { ...paymentCompany, logo_url: logoUrl },
  }
}
