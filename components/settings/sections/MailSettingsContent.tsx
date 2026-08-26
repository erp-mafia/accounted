'use client'

import { useTranslations } from 'next-intl'
import { MailConnectionsPanel } from '@/components/extensions/general/MailConnectionsPanel'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'

export function MailSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  return (
    <div>
      <SettingsSectionHeader title={tNav('mail')} intro={tIntro('mail')} />
      <MailConnectionsPanel />
    </div>
  )
}
