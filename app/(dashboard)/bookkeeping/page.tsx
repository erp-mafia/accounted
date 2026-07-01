import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BokforingWorkspace } from '@/components/bookkeeping/BokforingWorkspace'

/**
 * The unified Bokföring workspace — one home for the accounting loop:
 * Att hantera (bank transactions to book) · Underlag (receipts) · Utkast
 * (drafts) · Bokfört (posted vouchers). Thin server wrapper: it resolves the
 * user id (needed by the Underlag extension pane) and hands off to the client
 * shell. Auth/onboarding are already enforced by the dashboard layout; the
 * redirect here is a safety net.
 */
export default async function BookkeepingPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <Suspense>
      <BokforingWorkspace userId={user.id} />
    </Suspense>
  )
}
