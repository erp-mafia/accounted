'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { useLocale } from 'next-intl'

interface PeppolRegistrationView {
  participant_scheme: string
  participant_identifier: string
  status: 'pending' | 'registered' | 'failed' | 'deregistered'
  registered_at: string | null
  last_error: string | null
}

interface PeppolAccessView {
  status: 'none' | 'requested' | 'enabled' | 'disabled'
  send_enabled: boolean
  receive_enabled: boolean
  max_sends: number | null
  sent_count: number
  remaining_sends: number | null
}

interface PeppolSettingsPayload {
  transport: { available: boolean }
  receiving_supported: boolean
  access: PeppolAccessView
  registration: PeppolRegistrationView | null
}

/**
 * E-invoicing via Peppol for one company. Access is granted per company by
 * the operators (it costs per document and receiving consumes a contracted
 * slot), so the first row is the grant itself: ask, wait, see what you got.
 * Receiving is a second, separate grant and its switch publishes the
 * company's 0007:orgnr through the Access Point.
 */
export function PeppolReceiveSettings() {
  const t = useTranslations('settings_peppol')
  const locale = useLocale()
  const { toast } = useToast()
  const canWrite = useCanWrite()
  const [state, setState] = useState<PeppolSettingsPayload | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isRequesting, setIsRequesting] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/peppol')
      if (!response.ok) throw new Error()
      const payload = (await response.json()) as { data?: PeppolSettingsPayload }
      if (!payload.data) throw new Error()
      setState(payload.data)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const localeKey = locale.startsWith('sv') ? 'sv' : 'en'
  const access = state?.access ?? null
  const registration = state?.registration ?? null
  const isOn = registration?.status === 'registered' || registration?.status === 'pending'
  const transportAvailable = !!state?.transport.available
  const receivingAvailable = transportAvailable && !!state?.receiving_supported && !!access?.receive_enabled

  const requestAccess = useCallback(async () => {
    setIsRequesting(true)
    try {
      const response = await fetch('/api/settings/peppol/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await response.json().catch(() => null) as {
        error?: { code?: string; message?: string; message_en?: string }
      } | null
      if (!response.ok) throw body?.error ?? new Error()
      toast({ title: t('request_sent_title'), description: t('request_sent_description') })
      await load()
    } catch (error) {
      toast({
        title: t('request_failed_title'),
        description: getUserErrorMessage(error, { locale: localeKey }),
        variant: 'destructive',
      })
    } finally {
      setIsRequesting(false)
    }
  }, [load, localeKey, t, toast])

  const toggleReceiving = useCallback(async (next: boolean) => {
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings/peppol', { method: next ? 'POST' : 'DELETE' })
      const body = await response.json().catch(() => null) as {
        error?: { code?: string; message?: string; message_en?: string }
      } | null
      if (!response.ok) throw body?.error ?? new Error()
      toast({
        title: next ? t('toast_registered_title') : t('toast_deregistered_title'),
        description: next ? t('toast_registered_description') : t('toast_deregistered_description'),
      })
      await load()
    } catch (error) {
      toast({
        title: t('toast_failed_title'),
        description: getUserErrorMessage(error, { locale: localeKey }),
        variant: 'destructive',
      })
      await load()
    } finally {
      setIsSaving(false)
    }
  }, [load, localeKey, t, toast])

  const accessLine = (() => {
    if (!access) return null
    switch (access.status) {
      case 'enabled': return t('access_enabled')
      case 'requested': return t('access_requested')
      case 'disabled': return t('access_disabled')
      default: return t('access_none')
    }
  })()
  const sendsLine = access?.send_enabled
    ? access.max_sends === null
      ? t('sends_unlimited', { used: access.sent_count })
      : t('sends_used', { used: access.sent_count, max: access.max_sends })
    : null
  const registrationStatusLabel = !registration || registration.status === 'deregistered'
    ? t('status_off')
    : t(`status_${registration.status}`)

  return (
    <SettingsGroup label={t('heading')}>
      <SettingsRow label={t('access_label')} align="start">
        <div className="min-w-0 flex-1 space-y-1 text-sm">
          {loadFailed ? (
            <SettingsRowNote>{t('load_failed')}</SettingsRowNote>
          ) : state === null ? (
            <SettingsRowNote>{t('loading')}</SettingsRowNote>
          ) : !transportAvailable ? (
            <SettingsRowNote>{t('provider_required')}</SettingsRowNote>
          ) : (
            <>
              <span>{accessLine}</span>
              {sendsLine && <SettingsRowNote className="block tabular-nums">{sendsLine}</SettingsRowNote>}
            </>
          )}
        </div>
        {state !== null && transportAvailable && (access?.status === 'none' || access?.status === 'disabled') && (
          <SettingsRowEnd>
            <Button
              type="button"
              variant="outline"
              onClick={() => void requestAccess()}
              disabled={isRequesting || !canWrite}
            >
              {isRequesting ? t('request_sending') : t('request_button')}
            </Button>
          </SettingsRowEnd>
        )}
      </SettingsRow>

      <SettingsRow label={t('enable_label')} help={t('enable_help')}>
        <SettingsRowEnd>
          <Switch
            checked={isOn}
            onCheckedChange={(value) => void toggleReceiving(value)}
            disabled={isSaving || !canWrite || !receivingAvailable || state === null}
            aria-label={t('enable_label')}
          />
        </SettingsRowEnd>
      </SettingsRow>
      <SettingsRow label={t('status_label')} borderless>
        <div className="min-w-0 space-y-1 text-sm">
          {state === null || loadFailed ? (
            <SettingsRowNote>{loadFailed ? t('load_failed') : t('loading')}</SettingsRowNote>
          ) : !transportAvailable ? (
            <SettingsRowNote>{t('provider_required')}</SettingsRowNote>
          ) : !receivingAvailable && !isOn ? (
            <SettingsRowNote>{t('receive_not_enabled')}</SettingsRowNote>
          ) : (
            <>
              <span>{registrationStatusLabel}</span>
              {registration && registration.status !== 'deregistered' && (
                <SettingsRowNote className="block tabular-nums">
                  {t('peppol_id_label')} {registration.participant_scheme}:{registration.participant_identifier}
                </SettingsRowNote>
              )}
              {registration?.status === 'failed' && registration.last_error && (
                <SettingsRowNote className="block">{registration.last_error}</SettingsRowNote>
              )}
            </>
          )}
        </div>
      </SettingsRow>
    </SettingsGroup>
  )
}
