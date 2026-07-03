import { redirect } from 'next/navigation'

// Salary run creation now happens in a modal on the salary overview (matching
// the verifikat pattern) — the form itself lives in
// components/salary/NewSalaryRunDialog.tsx. This route survives as a redirect
// so old links, bookmarks, and agent intents keep working.
export default function NewSalaryRunPage() {
  redirect('/salary?new=1')
}
