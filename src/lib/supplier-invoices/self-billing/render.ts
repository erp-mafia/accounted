import type { SelfBillingBranding } from './branding'
import type { SelfBillingPdfInvoice, SelfBillingPdfItem } from './pdf-template'
import type { SelfBillingSnapshot } from './snapshot'

export interface RenderSelfBillingPdfInput {
  invoice: SelfBillingPdfInvoice
  items: SelfBillingPdfItem[]
  snapshot: SelfBillingSnapshot
  branding?: SelfBillingBranding
}

/**
 * Render a self-billing invoice (or its credit note) to PDF bytes. react-pdf
 * and the template load here, when a document is made, not with every route
 * that reaches the supplier-invoice service.
 */
export async function renderSelfBillingPdfBuffer(input: RenderSelfBillingPdfInput): Promise<Buffer> {
  const [{ renderToBuffer }, { SelfBillingPDF }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./pdf-template'),
  ])
  return renderToBuffer(SelfBillingPDF(input))
}

/** "Självfaktura SF-007 Leverantör AB.pdf", "Kreditfaktura SF-008 ...". */
export function selfBillingPdfFilename(input: {
  number: string | null
  isCreditNote: boolean
  sellerName: string | null
}): string {
  const kind = input.isCreditNote ? 'Kreditfaktura' : 'Självfaktura'
  const seller = (input.sellerName ?? '').replace(/[^\p{L}\p{N} &.-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return [kind, input.number, seller].filter((part) => part && part.length > 0).join(' ') + '.pdf'
}
