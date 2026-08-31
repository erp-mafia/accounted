'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import NoticeLines from '@/components/dashboard/NoticeLines'
import type { Notice } from '@/lib/notices/types'

/**
 * Hem's notice line with the one action that needs client state: the
 * wrong-account hint signs the user out so they can come back in with their
 * other login (same flow as SandboxBanner). Rendered by the streamed notices
 * section, so the shell above it never waits for the notice detectors.
 */
export function HemNotices({ notices }: { notices: Notice[] }) {
  const router = useRouter()

  async function handleSwitchAccount() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return <NoticeLines notices={notices} actionOverrides={{ other_account_hint: handleSwitchAccount }} />
}
