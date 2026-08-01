'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Sun, Moon, Monitor, LogOut, ExternalLink } from 'lucide-react'
import { useTheme } from 'next-themes'
import { createClient } from '@/lib/supabase/client'
import { SecuritySettings } from '@/components/settings/SecuritySettings'
import { InstallAppSection } from '@/components/settings/InstallAppSection'
import { CalendarFeedSettings } from '@/components/settings/CalendarFeedSettings'
import { AccountDangerZone } from '@/components/settings/AccountDangerZone'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsSectionHeader,
  SettingsSeg,
} from '@/components/settings/SettingsRows'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useSettings } from '@/components/settings/useSettings'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import { useToast } from '@/components/ui/use-toast'
import { SUPPORTED_LOCALES, type Locale } from '@/i18n/config'
import { PalettePicker } from '@/components/settings/PalettePicker'
import { usePalette } from '@/components/providers/PaletteProvider'
import type { Palette } from '@/lib/theme/palettes'

export function AccountSettingsContent() {
  const router = useRouter()
  const supabase = createClient()
  const { theme, setTheme } = useTheme()
  const { palette, setPalette } = usePalette()
  const [mounted, setMounted] = useState(false)
  const hasCalendarExtension = ENABLED_EXTENSION_IDS.has('calendar')
  const { settings } = useSettings()
  const { toast } = useToast()
  const activeLocale = useLocale() as Locale
  const tCommon = useTranslations('common')
  const tSettings = useTranslations('settings')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const [savingLocale, setSavingLocale] = useState(false)
  const [fullName, setFullName] = useState('')
  const [initialName, setInitialName] = useState('')
  const [nameLoading, setNameLoading] = useState(true)
  const [savingName, setSavingName] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // Pre-fill the name field from profiles.full_name. Self-contained client
  // fetch: mirrors BankIdSettings.
  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setNameLoading(false); return }
      const { data } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .maybeSingle()
      if (!active) return
      setFullName(data?.full_name ?? '')
      setInitialName(data?.full_name ?? '')
      setNameLoading(false)
    })()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSaveName() {
    const trimmed = fullName.trim()
    if (!trimmed || trimmed === initialName || savingName) return
    setSavingName(true)
    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: trimmed }),
      })
      if (!res.ok) throw new Error('Could not save')
      setFullName(trimmed)
      setInitialName(trimmed)
      toast({ title: tSettings('name_saved') })
      router.refresh()
    } catch {
      toast({ title: tSettings('name_save_failed'), variant: 'destructive' })
    } finally {
      setSavingName(false)
    }
  }

  async function handleLogout() {
    resetAnalyticsIdentity()
    await supabase.auth.signOut()
    router.push('/login')
  }

  async function handleLocaleChange(next: Locale) {
    if (next === activeLocale || savingLocale) return
    setSavingLocale(true)
    try {
      const res = await fetch('/api/user/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      })
      if (!res.ok) throw new Error('Could not save')
      toast({ title: tSettings('language_saved') })
      router.refresh()
    } catch {
      toast({
        title: tSettings('language_save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSavingLocale(false)
    }
  }

  const localeLabels: Record<Locale, string> = {
    sv: tCommon('language_swedish'),
    en: tCommon('language_english'),
  }

  const paletteLabels: Record<Palette, string> = {
    neutral: tSettings('palette_neutral'),
    indigo: tSettings('palette_indigo'),
    forest: tSettings('palette_forest'),
    sand: tSettings('palette_sand'),
  }

  const nameUnchanged = !fullName.trim() || fullName.trim() === initialName

  return (
    <div>
      <SettingsSectionHeader title={tNav('account')} intro={tIntro('account')} />

      {/* Profile: name, appearance, language, install-as-app */}
      <SettingsGroup label={tSettings('group_profile')}>
        <SettingsRow
          label={tSettings('name_label')}
          htmlFor="full_name"
          help={tSettings('name_description')}
          align="baseline"
        >
          <SettingsInput
            id="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={tSettings('name_placeholder')}
            disabled={nameLoading || savingName}
            maxLength={100}
          />
          <SettingsRowEnd>
            <Button
              size="sm"
              onClick={handleSaveName}
              disabled={nameLoading || savingName || nameUnchanged}
            >
              {savingName ? tCommon('saving') : tCommon('save')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>

        <SettingsRow label={tSettings('section_appearance')}>
          {mounted && (
            <SettingsSeg
              value={theme ?? 'system'}
              onChange={setTheme}
              aria-label={tSettings('section_appearance')}
              options={[
                {
                  value: 'light',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Sun className="h-3.5 w-3.5" />
                      {tCommon('theme_light')}
                    </span>
                  ),
                },
                {
                  value: 'dark',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Moon className="h-3.5 w-3.5" />
                      {tCommon('theme_dark')}
                    </span>
                  ),
                },
                {
                  value: 'system',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Monitor className="h-3.5 w-3.5" />
                      {tCommon('theme_system')}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </SettingsRow>

        <SettingsRow
          label={tSettings('palette_label')}
          help={tSettings('palette_description')}
          align="baseline"
        >
          {mounted && (
            <PalettePicker
              value={palette}
              onChange={setPalette}
              labels={paletteLabels}
              aria-label={tSettings('palette_label')}
            />
          )}
        </SettingsRow>

        <SettingsRow
          label={tSettings('section_language')}
          help={tSettings('language_description')}
        >
          <SettingsSeg
            value={activeLocale}
            onChange={(next) => void handleLocaleChange(next)}
            disabled={savingLocale}
            aria-label={tSettings('section_language')}
            options={SUPPORTED_LOCALES.map((value) => ({
              value,
              label: localeLabels[value],
            }))}
          />
        </SettingsRow>

        {/* Install as app: renders nothing when already running installed */}
        <InstallAppSection />
      </SettingsGroup>

      {/* Security: BankID, password, 2FA (renders its own group) */}
      <SecuritySettings />

      {/* Calendar feed (extension-gated) */}
      {hasCalendarExtension && <CalendarFeedSettings />}

      {/* Privacy & agreements: surface the otherwise-unlinked DPA + privacy policy */}
      <SettingsGroup label={tSettings('legal_title')}>
        <SettingsRow label={tSettings('legal_privacy')}>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" asChild>
              <Link href="/privacy" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {tCommon('open')}
              </Link>
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
        <SettingsRow label={tSettings('legal_dpa')}>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dpa" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {tCommon('open')}
              </Link>
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>

      {/* Sign out */}
      <SettingsGroup>
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
