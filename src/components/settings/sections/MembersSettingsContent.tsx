'use client'

import { useTranslations } from 'next-intl'
import { CompanyMembersSection } from '@/components/settings/CompanyMembersSection'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'

/**
 * Företag → Medlemmar: who has access to the active company and with which
 * role. Lived at the bottom of Företag until 2026-09-24, where people did not
 * find it; it is its own section now (/settings/company#members redirects here).
 */
export function MembersSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  return (
    <div>
      <SettingsSectionHeader title={tNav('members')} intro={tIntro('members')} />
      <CompanyMembersSection />
    </div>
  )
}
