'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
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

interface PeppolSettingsPayload {
  transport: { available: boolean }
  receiving_supported: boolean
  registration: PeppolRegistrationView | null
}

/**
 * Receiving e-invoices via Peppol: publishes the company's 0007:orgnr through
 * the contracted Access Point. One switch, the truth about its state next to
 * it. Sending needs no registration, so this row is only about receiving.
 */
export function PeppolReceiveSettings() {
  const t = useTranslations('settings_peppol')
  const locale = useLocale()
  const { toast } = useToast()
  const canWrite = useCanWrite()
  const [state, setState] = useState<PeppolSettingsPayload | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

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

  const registration = state?.registration ?? null
  const isOn = registration?.status === 'registered' || registration?.status === 'pending'
  const available = !!state?.transport.available && !!state?.receiving_supported

  const toggle = useCallback(async (next: boolean) => {
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
        description: getUserErrorMessage(error, { locale: locale.startsWith('sv') ? 'sv' : 'en' }),
        variant: 'destructive',
      })
      await load()
    } finally {
      setIsSaving(false)
    }
  }, [load, locale, t, toast])

  const statusLabel = (() => {
    if (!registration || registration.status === 'deregistered') return t('status_off')
    return t(`status_${registration.status}`)
  })()

  return (
    <SettingsGroup label={t('heading')}>
      <SettingsRow label={t('enable_label')} help={t('enable_help')}>
        <SettingsRowEnd>
          <Switch
            checked={isOn}
            onCheckedChange={(value) => void toggle(value)}
            disabled={isSaving || !canWrite || !available || state === null}
            aria-label={t('enable_label')}
          />
        </SettingsRowEnd>
      </SettingsRow>
      <SettingsRow label={t('status_label')} borderless>
        <div className="min-w-0 space-y-1 text-sm">
          {loadFailed ? (
            <SettingsRowNote>{t('load_failed')}</SettingsRowNote>
          ) : state === null ? (
            <SettingsRowNote>{t('loading')}</SettingsRowNote>
          ) : !available ? (
            <SettingsRowNote>{t('provider_required')}</SettingsRowNote>
          ) : (
            <>
              <span>{statusLabel}</span>
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
