'use client'

import { useTranslations } from 'next-intl'
import { ApiKeysPanel } from '@/components/settings/ApiKeysPanel'
import { OAuthClientsPanel } from '@/components/settings/OAuthClientsPanel'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'

export function ApiSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  return (
    <div>
      <SettingsSectionHeader title={tNav('api')} intro={tIntro('api')} />
      <ApiKeysPanel />
      <OAuthClientsPanel />
    </div>
  )
}
