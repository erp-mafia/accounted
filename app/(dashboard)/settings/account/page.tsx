'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Sun, Moon, Monitor, LogOut, Languages } from 'lucide-react'
import { useTheme } from 'next-themes'
import { createClient } from '@/lib/supabase/client'
import { SecuritySettings } from '@/components/settings/SecuritySettings'
import { CalendarFeedSettings } from '@/components/settings/CalendarFeedSettings'
import { AccountDangerZone } from '@/components/settings/AccountDangerZone'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useSettings } from '@/components/settings/useSettings'
import { clearRecaptIdentity } from '@/lib/recapt'
import { useToast } from '@/components/ui/use-toast'
import { SUPPORTED_LOCALES, type Locale } from '@/i18n/config'

export default function AccountSettingsPage() {
  const router = useRouter()
  const supabase = createClient()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const hasCalendarExtension = ENABLED_EXTENSION_IDS.has('calendar')
  const { settings } = useSettings()
  const { toast } = useToast()
  const activeLocale = useLocale() as Locale
  const tCommon = useTranslations('common')
  const tSettings = useTranslations('settings')
  const [savingLocale, setSavingLocale] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  async function handleLogout() {
    clearRecaptIdentity()
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

  return (
    <div className="space-y-8">
      {/* Appearance */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {tSettings('section_appearance')}
        </h2>
        {mounted && (
          <div className="flex gap-3">
            {([
              { value: 'light', labelKey: 'theme_light', icon: Sun },
              { value: 'dark', labelKey: 'theme_dark', icon: Moon },
              { value: 'system', labelKey: 'theme_system', icon: Monitor },
            ] as const).map(({ value, labelKey, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={`flex items-center gap-2 rounded-lg border-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  theme === value
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/40'
                }`}
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                {tCommon(labelKey)}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Language */}
      <section className="space-y-4 border-t border-border/8 pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {tSettings('section_language')}
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          {tSettings('language_description')}
        </p>
        <div className="flex gap-3">
          {SUPPORTED_LOCALES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => handleLocaleChange(value)}
              disabled={savingLocale}
              className={`flex items-center gap-2 rounded-lg border-2 px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                activeLocale === value
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/40'
              }`}
            >
              <Languages className="h-4 w-4 text-muted-foreground" />
              {localeLabels[value]}
            </button>
          ))}
        </div>
      </section>

      {/* Security */}
      <div className="border-t border-border/8 pt-8">
        <SecuritySettings />
      </div>

      {/* Calendar feed */}
      {hasCalendarExtension && (
        <div className="border-t border-border/8 pt-8">
          <CalendarFeedSettings />
        </div>
      )}

      {/* Logout */}
      <section className="border-t border-border/8 pt-8">
        <Card>
          <CardHeader>
            <CardTitle>{tCommon('account_settings')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">{tCommon('logout')}</p>
                <p className="text-sm text-muted-foreground">{tCommon('logout_description')}</p>
              </div>
              <Button variant="outline" onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" />
                {tCommon('logout')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Delete account — only for non-sandbox */}
      {!settings?.is_sandbox && <AccountDangerZone />}
    </div>
  )
}
