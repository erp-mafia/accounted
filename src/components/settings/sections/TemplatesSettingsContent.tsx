'use client'

import { useTranslations } from 'next-intl'
import { BookingTemplatesPanel } from '@/components/settings/BookingTemplatesPanel'
import { CounterpartyTemplatesPanel } from '@/components/settings/CounterpartyTemplatesPanel'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'

export function TemplatesSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  return (
    <div>
      <SettingsSectionHeader title={tNav('templates')} intro={tIntro('templates')} />
      <BookingTemplatesPanel />
      <CounterpartyTemplatesPanel />
    </div>
  )
}
