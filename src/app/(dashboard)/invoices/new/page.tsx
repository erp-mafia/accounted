import { redirect } from 'next/navigation'

// Invoice creation now happens in a modal on the invoice list (issue: match
// the verifikat pattern). This route survives as a redirect so old links,
// bookmarks, and agent intents keep working. Editing drafts still has a full
// page at /invoices/[id]/edit.
export default function NewInvoicePage() {
  redirect('/invoices?new=1')
}
