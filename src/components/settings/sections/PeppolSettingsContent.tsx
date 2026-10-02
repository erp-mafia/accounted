'use client'

import { useTranslations } from 'next-intl'
import { PeppolReceiveSettings } from '@/components/settings/PeppolReceiveSettings'
import { SettingsBackLink, SettingsSectionHeader } from '@/components/settings/SettingsRows'

/** Kopplingar → E-faktura via Peppol (moved out of Fakturering on 2026-09-24). */
export function PeppolSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      <SettingsSectionHeader title={tNav('peppol')} intro={tIntro('peppol')} />
      <PeppolReceiveSettings />
    </div>
  )
}
