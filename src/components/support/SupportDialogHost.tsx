'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { SupportLink } from '@/components/ui/support-link'

/**
 * Opens the support dialog from a deep link (`?support=1`). The reply nudge
 * mail from the desk points here, so a customer who left the app lands on
 * the conversation, not on a page with a menu to find. The param is cleared
 * with history.replaceState, never router.replace, so nothing remounts.
 */
export function SupportDialogHost() {
  const params = useSearchParams()
  // Read once at mount: the nudge mail lands on a full page load, and a later
  // in-app navigation carrying the param is not a case worth an effect.
  const [open, setOpen] = useState(() => params.get('support') === '1')

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next && typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      if (url.searchParams.has('support')) {
        url.searchParams.delete('support')
        window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
      }
    }
  }

  return <SupportLink variant="hidden" open={open} onOpenChange={handleOpenChange} />
}
