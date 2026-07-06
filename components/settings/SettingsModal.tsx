'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { SETTINGS_SECTIONS } from './sections'
import { SettingsShell } from './SettingsShell'

/**
 * The settings popup. Rendered only by the intercepting route
 * (`@settings/(.)settings/[[...section]]`) on in-app soft navigation, so its
 * mere presence means "open". Closing pops the history entry that opened it,
 * returning the user to the page they came from (which stayed mounted in the
 * `children` slot behind the scrim). On hard load / refresh / deep-link the
 * interceptor doesn't fire and the real full-page settings render instead.
 */
export function SettingsModal({ sectionId }: { sectionId?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const { company } = useCompany()
  const t = useTranslations('settings_modal')

  // Bare /settings (or an unknown section) defaults to company, or to account
  // when there is no active company (the no-company escape hatch).
  const resolved =
    sectionId && SETTINGS_SECTIONS[sectionId]
      ? sectionId
      : company
        ? 'company'
        : 'account'

  function onOpenChange(open: boolean) {
    if (!open) router.back()
  }

  // Parallel-route safety net. This modal lives in the @settingsModal slot and
  // should only ever show on /settings/* routes. On a soft navigation to a
  // non-settings route (e.g. a cross-link inside the modal like "Kontoplan"),
  // Next.js can keep this intercepted slot mounted over the new page. Once the
  // URL is no longer a settings route, render nothing so those links actually
  // leave the modal instead of appearing to do nothing.
  if (!pathname.startsWith('/settings')) return null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 md:h-auto md:max-h-[85dvh] md:max-w-4xl md:rounded-lg"
      >
        <div className="flex shrink-0 items-center border-b border-border px-6 py-4">
          <DialogTitle className="font-display text-lg tracking-tight">
            {t('title')}
          </DialogTitle>
        </div>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>
        <SettingsShell variant="modal" activeSection={resolved} />
      </DialogContent>
    </Dialog>
  )
}
