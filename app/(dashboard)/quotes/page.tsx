'use client'

import InvoicesPage from '@/app/(dashboard)/invoices/page'
import { InvoiceListVariantProvider } from '@/lib/invoices/list-variant'

/**
 * Offerter: the invoice list component in its quotes variant. Reached from
 * the nav row that company_settings.quotes_enabled shows or hides; the URL
 * keeps working either way, so switching quotes off never hides the rows.
 */
export default function QuotesPage() {
  return (
    <InvoiceListVariantProvider variant="quotes">
      <InvoicesPage />
    </InvoiceListVariantProvider>
  )
}
