import { redirect } from 'next/navigation'

type SearchParams = Record<string, string | string[] | undefined>

// Supplier invoice registration now happens in a modal on the list page
// (matching the verifikat pattern): the form itself lives in
// components/supplier-invoices/NewSupplierInvoiceForm.tsx. This route
// survives as a redirect so old links, bookmarks, the /expenses/new alias,
// and inbox deep links (?inbox_item_id=…) keep working.
export default async function NewSupplierInvoicePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  qs.set('new', '1')
  // Allowlist: forward only what the list page actually consumes; arbitrary
  // caller params must not pollute the destination query string.
  const inboxItemId = params.inbox_item_id
  if (typeof inboxItemId === 'string' && inboxItemId) {
    qs.set('inbox_item_id', inboxItemId)
  }
  redirect(`/supplier-invoices?${qs.toString()}`)
}
