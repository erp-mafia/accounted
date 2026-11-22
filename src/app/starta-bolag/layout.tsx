import type { ReactNode } from 'react'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'
import { SessionTimeoutController } from '@/components/auth/SessionTimeoutController'
import { LegalAcceptanceGate } from '@/components/legal/LegalAcceptanceGate'
import { readAcceptanceState } from '@/lib/legal/acceptance'
import { createClient } from '@/lib/supabase/server'

/**
 * "Starta aktiebolag" sits outside the app shell: a founder may have no
 * company yet (the middleware lets this path through, lib/company/
 * no-company-routes.ts). Like onboarding, a new signup meets the terms here
 * before the first company exists, and the page reads the full catalog.
 */
export default async function StartaBolagLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const acceptance = user && !user.is_anonymous ? await readAcceptanceState(supabase, user.id) : null
  return (
    <AllMessagesProvider>
      {user && <SessionTimeoutController />}
      {children}
      {acceptance && <LegalAcceptanceGate state={acceptance} pathname="/starta-bolag" company={null} role={null} />}
    </AllMessagesProvider>
  )
}
