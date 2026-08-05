'use client'

import { useTranslations } from 'next-intl'
import { WhatsAppLinkPanel } from '@/components/extensions/general/WhatsAppLinkPanel'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'

export function WhatsAppSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  return (
    <div>
      <SettingsSectionHeader title={tNav('whatsapp')} intro={tIntro('whatsapp')} />
      <WhatsAppLinkPanel />
    </div>
  )
}
