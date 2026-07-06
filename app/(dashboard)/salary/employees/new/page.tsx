import { redirect } from 'next/navigation'

// Employee creation now happens in a modal on the employee list (matching the
// verifikat pattern): the form itself lives in
// components/salary/NewEmployeeDialog.tsx. This route survives as a redirect
// so old links, bookmarks, and agent intents keep working.
export default function NewEmployeePage() {
  redirect('/salary/employees?new=1')
}
