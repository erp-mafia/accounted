'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRightStartOnRectangleIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { reloadTo, signOut, signOutAndNavigate } from '@/lib/auth/session-client'
import { SIGN_OUT_EVERYWHERE_UNCONFIRMED_REASON } from '@/lib/auth/session-timeout-shared'
import { SecuritySettings } from '@/components/settings/SecuritySettings'
import { AccountDangerZone } from '@/components/settings/AccountDangerZone'
import { DeletedCompaniesExport } from '@/components/settings/DeletedCompaniesExport'
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
 *
 * Two ways out: "Logga ut" ends this browser's session, like every other
 * sign-out button; "Logga ut från alla enheter" ends every session of the
 * user, this one included, after a confirm that says so.
 */
export function SecuritySettingsContent() {
  const { settings } = useSettings()
  const tCommon = useTranslations('common')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const [confirmEverywhere, setConfirmEverywhere] = useState(false)

  async function handleLogout() {
    // Server revokes the session and deletes the HttpOnly cookie; the helper
    // clears the browser's copies (token, storage, analytics identity).
    await signOutAndNavigate('/login')
  }

  async function handleLogoutEverywhere() {
    // Every session of the user at the auth server, this one included. The
    // other devices find out on their next request and land on /login with
    // the "ended" reason. This browser is signed out either way; when the
    // auth server did not confirm the rest (refused, rate limited, not
    // reached), /login says the other devices may still be signed in, since
    // this is the button people press after losing a device.
    const { error, revoked } = await signOut({ scope: 'global' })
    reloadTo(
      error || revoked === false
        ? `/login?reason=${SIGN_OUT_EVERYWHERE_UNCONFIRMED_REASON}`
        : '/login',
    )
  }

  return (
    <div>
      <SettingsSectionHeader title={tNav('security')} intro={tIntro('security')} />

      {/* BankID, password, 2FA, automatic sign-out (renders its own group) */}
      <SecuritySettings />

      <SettingsGroup label={tNav('group_session')}>
        <SettingsRow label={tCommon('logout')} help={tCommon('logout_description')}>
          <SettingsRowEnd>
            <Button variant="outline" onClick={handleLogout}>
              <ArrowRightStartOnRectangleIcon className="h-3.5 w-3.5" />
              {tCommon('logout')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
        <SettingsRow label={tCommon('logout_everywhere')} help={tCommon('logout_everywhere_description')}>
          <SettingsRowEnd>
            <Button variant="outline" onClick={() => setConfirmEverywhere(true)}>
              {tCommon('logout_everywhere')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmDialog
        open={confirmEverywhere}
        onOpenChange={setConfirmEverywhere}
        title={tCommon('logout_everywhere_confirm_title')}
        description={tCommon('logout_everywhere_confirm_body')}
        confirmLabel={tCommon('logout_everywhere_confirm')}
        onConfirm={handleLogoutEverywhere}
      />

      {/* Deleted companies still in their 18-month export window (terms
          9.3): here, above the account deletion that ends access to them. */}
      <DeletedCompaniesExport />

      {/* Delete account: only for non-sandbox */}
      {!settings?.is_sandbox && <AccountDangerZone />}
    </div>
  )
}
