import { redirect } from 'next/navigation'

// Recurring-schedule creation now happens in a modal on the schedule list
// (matching the verifikat pattern) — the form itself lives in
// components/invoices/NewRecurringScheduleDialog.tsx. This route survives as
// a redirect so old links, bookmarks, and agent intents keep working.
export default function NewRecurringSchedulePage() {
  redirect('/invoices/recurring?new=1')
}
