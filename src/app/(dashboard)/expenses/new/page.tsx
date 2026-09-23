import { redirect } from 'next/navigation'

type SearchParams = Record<string, string | string[] | undefined>

export default async function NewExpenseRedirectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  // Supplier invoice registration lives in a modal on the list page now
  // (?new=1): go there directly instead of bouncing via /supplier-invoices/new.
  // Allowlist: forward only what the list page actually consumes.
  qs.set('new', '1')
  const inboxItemId = params.inbox_item_id
  if (typeof inboxItemId === 'string' && inboxItemId) {
    qs.set('inbox_item_id', inboxItemId)
  }
  redirect(`/supplier-invoices?${qs.toString()}`)
}
