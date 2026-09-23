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
import { useByraSettingsScope } from './useSettingsNavItems'

/**
 * The settings popup. Rendered only by the intercepting route
 * (`@settings/(.)settings/[[...section]]`) on in-app soft navigation, so its
 * mere presence means "open". Closing pops the history entry that opened it,
 * returning the user to the page they came from (which stayed mounted in the
 * `children` slot behind the scrim). On hard load / refresh / deep-link the
 * interceptor doesn't fire and the real full-page settings render instead.
 *
 * Chrome follows the Fönster concept: company kicker over a serif title,
 * fixed-height window so the rail never jumps between sections.
 */
export function SettingsModal({ sectionId }: { sectionId?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const { company } = useCompany()
  const t = useTranslations('settings_modal')

  // Tab clicks inside the modal update the URL shallowly (see SettingsRail),
  // so the pathname is the live source of truth for the active section; the
  // sectionId route param only covers the very first intercepted render.
  // Bare /settings (or an unknown section) defaults to company, or to account
  // when there is no active company (the no-company escape hatch).
  // Byrå scope (?ctx=byra, settings opened from the cockpit): account-level
  // sections only, no company kicker, and the fallback section is Konto: the
  // cockpit is above the companies, so no company may read as "the" company.
  const byraScope = useByraSettingsScope()
  const urlSection = pathname.split('/')[2] ?? sectionId
  const resolved =
    urlSection && SETTINGS_SECTIONS[urlSection]
      ? urlSection
      : company && !byraScope
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
      {/* Escape with an open "?" help popover closes the popover (its own
          listener), not the whole settings window. */}
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 md:h-[min(680px,88dvh)] md:max-h-[88dvh] md:max-w-[920px] md:rounded-xl"
        onEscapeKeyDown={(e) => {
          if (document.querySelector('[data-help-popover]')) e.preventDefault()
        }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3">
          <div className="min-w-0">
            {/* The modal covers the sidebar's CompanySwitcher, so the active
                company must stay visible here as the kicker over the title.
                Not in byrå scope: the cockpit has no active company. */}
            {company && !byraScope ? (
              <p className="truncate text-xs text-muted-foreground">{company.name}</p>
            ) : null}
            <DialogTitle className="font-display text-lg tracking-tight">
              {t('title')}
            </DialogTitle>
          </div>
        </div>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>
        <SettingsShell variant="modal" activeSection={resolved} />
      </DialogContent>
    </Dialog>
  )
}
