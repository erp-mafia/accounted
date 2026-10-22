'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow } from '@/components/settings/SettingsRows'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { stopAnalytics } from '@/lib/analytics/client'

/**
 * Inställningar → Konto: the person's own analytics choice, the same one the
 * acceptance prompt asked. A change reloads the page: saying yes starts
 * PostHog through AnalyticsIdentify, saying no stops it here and the reload
 * keeps it from starting again.
 */
export function AnalyticsConsentRow() {
  const t = useTranslations('settings')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [granted, setGranted] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  // Self-contained client read, like the other rows on this page.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await fetch('/api/user/analytics-consent')
        const body = await res.json().catch(() => null)
        if (active && res.ok) setGranted((body?.data?.granted as boolean | null) ?? null)
      } finally {
        if (active) setLoaded(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  async function change(next: boolean) {
    setSaving(true)
    try {
      const res = await fetch('/api/user/analytics-consent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ granted: next }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: t('analytics_consent_failed'), description: getErrorMessage(body, { statusCode: res.status, locale }), variant: 'destructive' })
        return
      }
      setGranted(next)
      if (!next) stopAnalytics()
      window.location.reload()
    } catch (error) {
      toast({ title: t('analytics_consent_failed'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow label={t('analytics_consent_label')} help={t('analytics_consent_help')}>
      <Switch
        checked={granted !== false}
        disabled={!loaded || saving}
        aria-label={t('analytics_consent_label')}
        onCheckedChange={(next) => void change(next)}
      />
    </SettingsRow>
  )
}
