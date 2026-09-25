'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { SkatteverketConnectPanel } from '@/components/settings/SkatteverketConnectPanel'
import { SettingsBackLink, SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'

/**
 * Kopplingar → Skatteverket: the connection (ombud, BankID consent) on its own
 * page. It sat at the top of Skatt until 2026-09-24; Moms och skatt keeps a
 * row that links here, so the pages that send users to /settings/tax to
 * (re)connect still find it.
 */
export function SkatteverketSettingsContent() {
  const t = useTranslations('settings_skatteverket')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()

  // Skatteverket OAuth callback: the full-page connect flow returns here with
  // a status query param (returnTo set in SkatteverketConnectPanel).
  useEffect(() => {
    const connected = searchParams.get('skv_connected')
    const error = searchParams.get('skv_error')
    if (connected === 'true') {
      toast({ title: t('connected_title'), description: t('connected_description') })
      router.replace('/settings/skatteverket')
    } else if (error) {
      let msg: string
      try {
        msg = decodeURIComponent(error)
      } catch {
        msg = error
      }
      toast({ title: t('connect_failed_title'), description: msg, variant: 'destructive' })
      router.replace('/settings/skatteverket')
    }
  }, [searchParams, router, toast, t])

  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      <SettingsSectionHeader title={tNav('skatteverket')} intro={tIntro('skatteverket')} />
      <SkatteverketConnectPanel />
    </div>
  )
}
