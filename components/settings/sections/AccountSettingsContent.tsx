'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sun, Moon, Monitor, LogOut, Languages, ExternalLink } from 'lucide-react'
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

export function AccountSettingsContent() {
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
  const [fullName, setFullName] = useState('')
  const [initialName, setInitialName] = useState('')
  const [nameLoading, setNameLoading] = useState(true)
  const [savingName, setSavingName] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // Pre-fill the name field from profiles.full_name. Self-contained client
  // fetch — mirrors BankIdSettings.
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
      {/* Name */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {tSettings('section_name')}
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          {tSettings('name_description')}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2 sm:max-w-sm">
            <Label htmlFor="full_name">{tSettings('name_label')}</Label>
            <Input
              id="full_name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={tSettings('name_placeholder')}
              disabled={nameLoading || savingName}
              maxLength={100}
            />
          </div>
          <Button
            onClick={handleSaveName}
            disabled={
              nameLoading || savingName || !fullName.trim() || fullName.trim() === initialName
            }
          >
            {savingName ? tCommon('saving') : tCommon('save')}
          </Button>
        </div>
      </section>

      {/* Appearance */}
      <section className="space-y-4 border-t border-border pt-8">
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
                className={`flex items-center gap-2 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors ${
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
      <section className="space-y-4 border-t border-border pt-8">
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
              className={`flex items-center gap-2 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors disabled:opacity-50 ${
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
      <div className="border-t border-border pt-8">
        <SecuritySettings />
      </div>

      {/* Calendar feed */}
      {hasCalendarExtension && (
        <div className="border-t border-border pt-8">
          <CalendarFeedSettings />
        </div>
      )}

      {/* Logout */}
      <section className="border-t border-border pt-8">
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

      {/* Privacy & agreements — surface the otherwise-unlinked DPA + privacy policy */}
      <section className="border-t border-border pt-8">
        <Card>
          <CardHeader>
            <CardTitle>{tSettings('legal_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:bg-secondary/60"
            >
              <span className="font-medium">{tSettings('legal_privacy')}</span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link
              href="/dpa"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:bg-secondary/60"
            >
              <span className="font-medium">{tSettings('legal_dpa')}</span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </Link>
          </CardContent>
        </Card>
      </section>

      {/* Delete account — only for non-sandbox */}
      {!settings?.is_sandbox && <AccountDangerZone />}
    </div>
  )
}
