'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

/** Sign-out affordance for the paused page: back to login as another user. */
export function PausedSignOutButton({ label }: { label: string }) {
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <Button variant="secondary" onClick={handleSignOut}>
      {label}
    </Button>
  )
}
