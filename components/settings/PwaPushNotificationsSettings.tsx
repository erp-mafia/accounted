'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsGroup, SettingsRow, SettingsRowEnd } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import {
  fetchPushEventSettings,
  fetchVapidPublicKey,
  getExistingPushSubscription,
  isPushApiSupported,
  savePushEventSetting,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
  type PushEventSettingKey,
  type PushEventSettings,
} from '@/lib/pwa/push-subscribe'

const EVENT_ROWS: Array<{
  key: PushEventSettingKey
  label: 'pwa_push_event_periodLockedEnabled' | 'pwa_push_event_periodYearClosedEnabled' | 'pwa_push_event_invoiceSentEnabled' | 'pwa_push_event_receiptExtractedEnabled' | 'pwa_push_event_receiptMatchedEnabled' | 'pwa_push_event_missingUnderlagEnabled'
  help: 'pwa_push_event_periodLockedEnabled_help' | 'pwa_push_event_periodYearClosedEnabled_help' | 'pwa_push_event_invoiceSentEnabled_help' | 'pwa_push_event_receiptExtractedEnabled_help' | 'pwa_push_event_receiptMatchedEnabled_help' | 'pwa_push_event_missingUnderlagEnabled_help'
}> = [
  { key: 'periodLockedEnabled', label: 'pwa_push_event_periodLockedEnabled', help: 'pwa_push_event_periodLockedEnabled_help' },
  { key: 'periodYearClosedEnabled', label: 'pwa_push_event_periodYearClosedEnabled', help: 'pwa_push_event_periodYearClosedEnabled_help' },
  { key: 'invoiceSentEnabled', label: 'pwa_push_event_invoiceSentEnabled', help: 'pwa_push_event_invoiceSentEnabled_help' },
  { key: 'receiptExtractedEnabled', label: 'pwa_push_event_receiptExtractedEnabled', help: 'pwa_push_event_receiptExtractedEnabled_help' },
  { key: 'receiptMatchedEnabled', label: 'pwa_push_event_receiptMatchedEnabled', help: 'pwa_push_event_receiptMatchedEnabled_help' },
  { key: 'missingUnderlagEnabled', label: 'pwa_push_event_missingUnderlagEnabled', help: 'pwa_push_event_missingUnderlagEnabled_help' },
]

/**
 * Konto: subscribe this browser to Web Push, plus per-event opt-outs.
 * Hidden when the extension is off, VAPID is missing, or the browser
 * cannot receive pushes (typical for a Safari tab that is not installed).
 */
export function PwaPushNotificationsSettings() {
  const t = useTranslations('settings')
  const { toast } = useToast()
  const [available, setAvailable] = useState(false)
  const [vapidKey, setVapidKey] = useState<string | null>(null)
  const [subscribed, setSubscribed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [events, setEvents] = useState<PushEventSettings | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const key = await fetchVapidPublicKey()
        if (!active) return
        if (!key || !isPushApiSupported()) {
          setAvailable(false)
          return
        }
        setVapidKey(key)
        setAvailable(true)
        const [existing, settings] = await Promise.all([
          getExistingPushSubscription(),
          fetchPushEventSettings(),
        ])
        if (!active) return
        setSubscribed(!!existing)
        setEvents(settings)
      } catch {
        if (active) setAvailable(false)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  async function handleSubscribeChange(next: boolean) {
    if (!vapidKey) return
    setSaving(true)
    const previous = subscribed
    setSubscribed(next)
    try {
      if (next) await subscribeToPush(vapidKey)
      else await unsubscribeFromPush()
      toast({
        title: next ? t('pwa_push_enabled_toast') : t('pwa_push_disabled_toast'),
      })
    } catch (error) {
      setSubscribed(previous)
      const reason = error instanceof Error ? error.message : ''
      toast({
        title:
          reason === 'permission-denied'
            ? t('pwa_push_permission_denied')
            : t('pwa_push_save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleTestPush() {
    setTesting(true)
    try {
      const result = await sendTestPush()
      if (result === 'sent') {
        toast({ title: t('pwa_push_test_sent') })
        return
      }
      toast({
        title:
          result === 'no_subscriptions'
            ? t('pwa_push_test_no_subscription')
            : t('pwa_push_test_failed'),
        variant: 'destructive',
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleEventChange(key: PushEventSettingKey, next: boolean) {
    if (!events) return
    const previous = events
    setEvents({ ...events, [key]: next })
    const ok = await savePushEventSetting(key, next)
    if (!ok) {
      setEvents(previous)
      toast({ title: t('pwa_push_save_failed'), variant: 'destructive' })
    }
  }

  if (loading || !available) return null

  return (
    <SettingsGroup label={t('pwa_push_group')}>
      <SettingsRow label={t('pwa_push_label')} help={t('pwa_push_description')}>
        <Switch
          id="pwa-push-subscribe"
          checked={subscribed}
          onCheckedChange={(value) => void handleSubscribeChange(value)}
          disabled={saving}
        />
        <label htmlFor="pwa-push-subscribe" className="cursor-pointer text-sm">
          {t('pwa_push_switch')}
        </label>
      </SettingsRow>
      <SettingsRow label={t('pwa_push_test_label')} help={t('pwa_push_test_help')}>
        <SettingsRowEnd>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleTestPush()}
            disabled={!subscribed || saving || testing}
          >
            {testing ? t('pwa_push_test_sending') : t('pwa_push_test')}
          </Button>
        </SettingsRowEnd>
      </SettingsRow>
      {events
        ? EVENT_ROWS.map((row) => (
            <SettingsRow key={row.key} label={t(row.label)} help={t(row.help)}>
              <Switch
                id={`pwa-push-${row.key}`}
                checked={events[row.key]}
                onCheckedChange={(value) => void handleEventChange(row.key, value)}
                disabled={!subscribed}
              />
            </SettingsRow>
          ))
        : null}
    </SettingsGroup>
  )
}
