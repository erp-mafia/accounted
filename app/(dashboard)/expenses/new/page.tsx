import { redirect } from 'next/navigation'

type SearchParams = Record<string, string | string[] | undefined>

export default async function NewExpenseRedirectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v)
    } else {
      qs.set(key, value)
    }
  }
  // Supplier invoice registration lives in a modal on the list page now
  // (?new=1) — go there directly instead of bouncing via /supplier-invoices/new.
  qs.set('new', '1')
  redirect(`/supplier-invoices?${qs.toString()}`)
}
