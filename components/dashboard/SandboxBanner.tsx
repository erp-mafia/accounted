'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export function SandboxBanner() {
  const [dismissed, setDismissed] = useState(false)
  const router = useRouter()

  if (dismissed) return null

  async function handleCreateAccount() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/register')
  }

  return (
    <div className="relative z-50 flex items-center justify-center gap-x-3 gap-y-1 bg-warning px-10 py-2 text-sm text-warning-foreground sm:px-4 flex-wrap">
      <span className="font-medium text-center text-xs sm:text-sm">
        Sandlådemiljö: AI och externa tjänster är avstängda. Data raderas efter 24h.
      </span>
      <button
        onClick={handleCreateAccount}
        className="shrink-0 rounded-md bg-warning-foreground/15 px-3 py-0.5 text-xs font-semibold hover:bg-warning-foreground/25 transition-colors"
      >
        Skapa konto
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-warning-foreground/15 transition-colors"
        aria-label="Stäng"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
