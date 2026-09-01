'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { isSelfHosted } from '@/lib/env/public-flags'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

type UpstreamMode = 'connector' | 'own_credentials' | 'unconfigured'

interface ConnectorStatus {
  configured: boolean
  key_prefix: string | null
  upstreams: { bank: UpstreamMode; skatteverket: UpstreamMode }
  granted_capabilities: string[]
}

interface SyncResult {
  outcome: 'not_configured' | 'synced' | 'revoked' | 'network_error' | 'server_error'
  grantsUpserted: number
  scopes?: string[]
}

/**
 * Settings -> Abonnemang, self-host only: is the connector wired, per
 * upstream, and a "Synka nu" that runs the entitlement sync on demand
 * instead of waiting for the hourly cron (PR6b-3). Renders nothing on
 * hosted; the status endpoint's self_hosted:false answer is the backstop.
 *
 * The sync covers every company on the instance; the capability list shown
 * is the active company's (same as the status endpoint reports). That
 * asymmetry lives in the group help, not in the row copy.
 */
export function ConnectorSettingsSection() {
  const t = useTranslations('settings_billing')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [status, setStatus] = useState<ConnectorStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const selfHosted = isSelfHosted()

  useEffect(() => {
    if (!selfHosted) return
    let active = true
    setLoadFailed(false)
    fetch('/api/connector/status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        const body = (await res.json()) as { data?: { self_hosted?: boolean } & ConnectorStatus }
        if (!active) return
        if (!body.data || body.data.self_hosted !== true) {
          setStatus(null)
          return
        }
        setStatus(body.data)
      })
      .catch(() => {
        if (active) setLoadFailed(true)
      })
    return () => {
      active = false
    }
  }, [selfHosted, reloadKey])

  const runSync = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/connector/sync', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as
        | { data?: SyncResult; error?: unknown }
        | null
      if (!res.ok || !body?.data) {
        toast({
          title: t('connector_sync_failed'),
          description: getErrorMessage(body, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      const result = body.data
      if (result.outcome === 'synced') {
        toast({
          title: t('connector_sync_done'),
          description:
            (result.scopes?.length ?? 0) > 0
              ? t('connector_sync_done_desc', { count: result.grantsUpserted })
              : t('connector_sync_done_empty'),
        })
      } else if (result.outcome === 'revoked') {
        // The grants were just deleted: this must not read as a generic error.
        toast({
          title: t('connector_sync_failed'),
          description: t('connector_sync_revoked_desc'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('connector_sync_failed'),
          description: t('connector_sync_unreachable_desc'),
          variant: 'destructive',
        })
      }
      setReloadKey((k) => k + 1)
    } finally {
      setSyncing(false)
    }
  }, [t, errorLocale, toast])

  if (!selfHosted) return null
  if (!status && !loadFailed) return null

  const modeLabel: Record<UpstreamMode, string> = {
    connector: t('connector_mode_connector'),
    own_credentials: t('connector_mode_own'),
    unconfigured: t('connector_mode_unconfigured'),
  }

  return (
    <SettingsGroup label={t('connector_group')} help={t('connector_help')}>
      {loadFailed || !status ? (
        <SettingsRow label={t('connector_row_status')} borderless>
          <SettingsRowNote>{t('connector_load_failed')}</SettingsRowNote>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t('load_retry')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow label={t('connector_row_status')}>
            {status.configured ? (
              <>
                <span className="font-medium">{t('connector_status_configured')}</span>
                {status.key_prefix ? (
                  <span className="font-mono text-xs text-muted-foreground">{status.key_prefix}…</span>
                ) : null}
              </>
            ) : (
              <>
                <span>{t('connector_status_unconfigured')}</span>
                <SettingsRowNote>{t('connector_status_unconfigured_note')}</SettingsRowNote>
              </>
            )}
            {status.configured ? (
              <SettingsRowEnd>
                <Button variant="outline" size="sm" disabled={syncing} onClick={runSync}>
                  {syncing ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  <span>{syncing ? t('connector_sync_button_busy') : t('connector_sync_button')}</span>
                </Button>
              </SettingsRowEnd>
            ) : null}
          </SettingsRow>
          <SettingsRow label={t('connector_row_bank')}>
            <span className={status.upstreams.bank === 'unconfigured' ? 'text-muted-foreground' : undefined}>
              {modeLabel[status.upstreams.bank]}
            </span>
          </SettingsRow>
          <SettingsRow label={t('connector_row_skv')}>
            <span className={status.upstreams.skatteverket === 'unconfigured' ? 'text-muted-foreground' : undefined}>
              {modeLabel[status.upstreams.skatteverket]}
            </span>
          </SettingsRow>
          <SettingsRow label={t('connector_row_capabilities')} borderless>
            {status.granted_capabilities.length > 0 ? (
              <span className="font-mono text-xs text-muted-foreground">
                {status.granted_capabilities.join(', ')}
              </span>
            ) : (
              <SettingsRowNote>
                {status.configured ? t('connector_caps_none') : t('connector_caps_unconfigured')}
              </SettingsRowNote>
            )}
          </SettingsRow>
        </>
      )}
    </SettingsGroup>
  )
}
