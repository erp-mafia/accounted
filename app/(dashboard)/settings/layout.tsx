'use client'

import { useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { SettingsShell } from '@/components/settings/SettingsShell'

const TAB_TO_ROUTE: Record<string, string> = {
  company: '/settings/company',
  invoicing: '/settings/invoicing',
  bookkeeping: '/settings/bookkeeping',
  tax: '/settings/tax',
  team: '/settings/team',
  banking: '/settings/banking',
  templates: '/settings/templates',
  'agent-memory': '/settings/assistant',
  assistant: '/settings/assistant',
  account: '/settings/account',
  api: '/settings/api',
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const t = useTranslations('settings_nav')

  // Handle legacy ?tab= URLs
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab && TAB_TO_ROUTE[tab]) {
      router.replace(TAB_TO_ROUTE[tab])
    }
  }, [searchParams, router])

  return (
    <div className="space-y-8">
      <h1 className="font-display text-2xl tracking-tight md:text-3xl">{t('aria_label')}</h1>
      <SettingsShell variant="page">{children}</SettingsShell>
    </div>
  )
}
