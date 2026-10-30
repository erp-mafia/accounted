'use client'

import { createContext, useContext } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { activeBolagetTab, bolagetTabs, type BolagetHubAccess } from '@/lib/bolaget/hub'

const BolagetHubContext = createContext<BolagetHubAccess | null>(null)

/** Which tabs the company has, resolved once by the /bolaget layout. */
export function BolagetHubProvider({ access, children }: { access: BolagetHubAccess; children: React.ReactNode }) {
  return <BolagetHubContext.Provider value={access}>{children}</BolagetHubContext.Provider>
}

/**
 * The tab bar every Bolaget page shares, right under its top bar: Översikt,
 * the registers where the form keeps an aktiebok, and Avtal. Plain text tabs
 * with an underline on the current one (no pills, founder call 2026-10-29).
 * Renders nothing outside the /bolaget layout.
 */
export function BolagetTabs() {
  const access = useContext(BolagetHubContext)
  const pathname = usePathname()
  const t = useTranslations('bolaget_hub')
  if (!access) return null
  const tabs = bolagetTabs(access)
  if (tabs.length === 0) return null
  const active = activeBolagetTab(pathname)
  return (
    <nav aria-label={t('tabs_label')} className="-mt-2 flex min-w-0 gap-6 overflow-x-auto border-b border-border scrollbar-hide">
      {tabs.map((tab) => {
        const current = tab.key === active
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={current ? 'page' : undefined}
            data-ph-unmask=""
            className={cn(
              '-mb-px inline-flex shrink-0 items-center whitespace-nowrap border-b-2 py-2 text-[13px] transition-colors duration-150 pointer-coarse:min-h-10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              current ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tab.${tab.key}`)}
          </Link>
        )
      })}
    </nav>
  )
}
