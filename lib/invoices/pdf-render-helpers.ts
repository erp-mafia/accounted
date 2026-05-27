/**
 * Shared helpers for invoice PDF render call sites.
 *
 * Wraps `brandingFromCompanySettings` so every PDF-rendering route gets a
 * consistent branding object.
 */

import type { CompanySettings } from '@/types'
import { brandingFromCompanySettings, type InvoiceBranding } from '@/lib/invoices/pdf-template'

export interface InvoicePdfRenderExtras {
  branding: InvoiceBranding
}

export function prepareInvoicePdfRender(company: CompanySettings): InvoicePdfRenderExtras {
  return { branding: brandingFromCompanySettings(company) }
}
