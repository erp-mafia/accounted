'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import { SecuritySettings } from '@/components/settings/SecuritySettings'
import { AccountDangerZone } from '@/components/settings/AccountDangerZone'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'

/**
 * Du → Säkerhet: how the user signs in (password, 2FA, BankID, automatic
 * sign-out), signing out, and deleting the account. Split out of Konto on
 * 2026-09-24 so the profile page is only about the person.
 */
export function SecuritySettingsContent() {
  const router = useRouter()
  const supabase = createClient()
  const { settings } = useSettings()
  const tCommon = useTranslations('common')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  async function handleLogout() {
    resetAnalyticsIdentity()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div>
      <SettingsSectionHeader title={tNav('security')} intro={tIntro('security')} />

      {/* BankID, password, 2FA, automatic sign-out (renders its own group) */}
      <SecuritySettings />

      <SettingsGroup label={tNav('group_session')}>
        <SettingsRow label={tCommon('logout')} help={tCommon('logout_description')}>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="mr-2 h-3.5 w-3.5" />
              {tCommon('logout')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>

      {/* Delete account: only for non-sandbox */}
      {!settings?.is_sandbox && <AccountDangerZone />}
    </div>
  )
}
