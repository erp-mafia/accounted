'use client'

import { useTranslations } from 'next-intl'
import { WhatsAppLinkPanel } from '@/components/extensions/general/WhatsAppLinkPanel'
import { WhatsAppMark } from '@/components/extensions/general/WhatsAppMark'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'

export function WhatsAppSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  return (
    <div>
      <SettingsSectionHeader
        title={tNav('whatsapp')}
        intro={tIntro('whatsapp')}
        mark={<WhatsAppMark size={26} />}
      />
      <WhatsAppLinkPanel />
    </div>
  )
}
