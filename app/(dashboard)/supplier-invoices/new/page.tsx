import { redirect } from 'next/navigation'

type SearchParams = Record<string, string | string[] | undefined>

// Supplier invoice registration now happens in a modal on the list page
// (matching the verifikat pattern) — the form itself lives in
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
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v)
    } else {
      qs.set(key, value)
    }
  }
  redirect(`/supplier-invoices?${qs.toString()}`)
}
