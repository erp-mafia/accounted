'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn } from '@/lib/utils'

/**
 * The one lock for a read-only member (role viewer, use-can-write.ts).
 * A write control takes `disabled={!canWrite || ...}` and `title={lockedTitle}`;
 * `lockedTitle` is undefined for a writer, so a writer's button is untouched.
 * The server refuses the write either way (requireWrite): this only keeps a
 * viewer from being offered what they cannot do.
 */
export function useViewerLock(): { canWrite: boolean; lockedTitle: string | undefined } {
  const { canWrite } = useCanWrite()
  const t = useTranslations('common')
  return { canWrite, lockedTitle: canWrite ? undefined : t('viewer_disabled_tooltip') }
}

/**
 * Locks every form control inside (inputs, selects, switches, buttons) for a
 * read-only member, with the reason on hover. For a writer it is an inert
 * wrapper that takes no part in layout. Links and plain text stay live, so
 * keep navigation, exports and view switches OUTSIDE it: a button inside is
 * locked whatever it does.
 */
export function ViewerLock({ children, className }: { children: React.ReactNode; className?: string }) {
  const { canWrite, lockedTitle } = useViewerLock()
  return (
    <fieldset disabled={!canWrite} title={lockedTitle} className={cn('contents', className)}>
      {children}
    </fieldset>
  )
}

/**
 * A create or edit page is not offered to a read-only member: they land on
 * the list instead. Returns canWrite so the page can render nothing meanwhile.
 */
export function useViewerRedirect(listHref: string): boolean {
  const { canWrite } = useCanWrite()
  const router = useRouter()
  useEffect(() => {
    if (!canWrite) router.replace(listHref)
  }, [canWrite, router, listHref])
  return canWrite
}
