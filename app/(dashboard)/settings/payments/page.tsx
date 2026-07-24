import { redirect } from 'next/navigation'

// The Stripe connect/sync surface moved to the import page; this route stays
// as a redirect so old links, bookmarks and OAuth flows in flight keep working.
export default function PaymentsSettingsPage() {
  redirect('/import?mode=stripe')
}
