'use client'

import { usePwaWorklistBadge } from '@/lib/hooks/use-pwa-worklist-badge'

/** Mount once under CompanyProvider so the installed PWA icon tracks Att göra. */
export function PwaWorklistBadge() {
  usePwaWorklistBadge()
  return null
}
