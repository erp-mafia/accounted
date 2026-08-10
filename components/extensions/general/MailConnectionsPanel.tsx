'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { GoogleMark, MicrosoftMark } from '@/components/ui/provider-marks'
import { formatDateLong } from '@/lib/utils'

interface HuntResult {
  searched: number
  fetched: number
  proposed: number
  remaining: number
  failed?: boolean
}

interface MailConnection {
  id: string
  provider: 'gmail' | 'microsoft'
  emailAddress: string
  scopeLabel: string | null
  status: 'active' | 'needs_reconsent' | 'revoked'
  lastSearchedAt: string | null
  lastErrorCode: string | null
}

const BASE = '/api/extensions/ext/mail'

export function MailConnectionsPanel() {
  const t = useTranslations('mail')
  const [connections, setConnections] = useState<MailConnection[]>([])
  const [configured, setConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [pendingDisconnect, setPendingDisconnect] = useState<MailConnection | null>(null)
  const [hunting, setHunting] = useState(false)
  const [huntResult, setHuntResult] = useState<HuntResult | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BASE}/connections`)
      if (!response.ok) return
      const body = (await response.json()) as {
        data: { connections: MailConnection[]; configured: boolean }
      }
      setConnections(body.data.connections)
      setConfigured(body.data.configured)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function connect() {
    setConnecting(true)
    try {
      // The consent screen must open from the user's own gesture, so the tab is
      // opened first and its location set once the URL is known: opening it
      // after the await is what popup blockers stop.
      const tab = window.open('', '_blank')
      const response = await fetch(`${BASE}/oauth/start`, { method: 'POST' })
      if (!response.ok) {
        tab?.close()
        return
      }
      const body = (await response.json()) as { url: string }
      if (tab) tab.location.href = body.url
      else window.location.href = body.url
    } finally {
      setConnecting(false)
    }
  }

  /**
   * One bounded pass, on request.
   *
   * Deliberately not a background job: a sweep of a real mailbox runs longer
   * than a serverless function may live, so the honest shape is a pass that
   * ends, says what it found and what is left, and can be pressed again.
   */
  async function hunt() {
    setHunting(true)
    setHuntResult(null)
    try {
      const response = await fetch('/api/receipt-hunt/run', { method: 'POST' })
      if (!response.ok) {
        setHuntResult({ searched: 0, fetched: 0, proposed: 0, remaining: 0, failed: true })
        return
      }
      const body = (await response.json()) as { data: HuntResult }
      setHuntResult(body.data)
      void load()
    } catch {
      setHuntResult({ searched: 0, fetched: 0, proposed: 0, remaining: 0, failed: true })
    } finally {
      setHunting(false)
    }
  }

  async function disconnect(connection: MailConnection) {
    await fetch(`${BASE}/connections?id=${encodeURIComponent(connection.id)}`, { method: 'DELETE' })
    setPendingDisconnect(null)
    void load()
  }

  if (loading) return null

  return (
    <div className="space-y-8">
      <SettingsGroup label={t('connected')} help={t('help')}>
        {connections.length === 0 ? (
          <SettingsRow label={t('none_label')} borderless>
            <SettingsRowNote>{t('none')}</SettingsRowNote>
          </SettingsRow>
        ) : (
          connections.map((connection) => (
            <SettingsRow
              key={connection.id}
              label={
                <span className="flex items-center gap-2">
                  {connection.provider === 'gmail' ? (
                    <GoogleMark className="h-3.5 w-3.5" />
                  ) : (
                    <MicrosoftMark className="h-3.5 w-3.5" />
                  )}
                  {connection.provider === 'gmail' ? 'Gmail' : 'Microsoft 365'}
                </span>
              }
            >
              <span className="truncate">{connection.emailAddress}</span>
              {connection.status === 'needs_reconsent' ? (
                <Badge variant="warning">{t('needs_reconsent')}</Badge>
              ) : null}
              <SettingsRowEnd>
                {connection.lastSearchedAt ? (
                  <SettingsRowNote>
                    {t('last_searched', { date: formatDateLong(connection.lastSearchedAt, 'sv') })}
                  </SettingsRowNote>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setPendingDisconnect(connection)}>
                  {t('disconnect')}
                </Button>
              </SettingsRowEnd>
            </SettingsRow>
          ))
        )}
      </SettingsGroup>

      {connections.length > 0 ? (
        <SettingsGroup label={t('hunt_title')} help={t('hunt_help')}>
          <SettingsRow label={t('hunt_row')} borderless>
            <SettingsRowEnd>
              {huntResult ? (
                <SettingsRowNote>
                  {huntResult.failed
                    ? t('hunt_failed')
                    : huntResult.fetched > 0
                      ? t('hunt_found', { count: huntResult.fetched, left: huntResult.remaining })
                      : t('hunt_none', { left: huntResult.remaining })}
                </SettingsRowNote>
              ) : null}
              <Button variant="secondary" size="sm" onClick={hunt} disabled={hunting}>
                {hunting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {hunting ? t('hunt_running') : t('hunt_action')}
              </Button>
            </SettingsRowEnd>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={connect} disabled={connecting || !configured}>
          {connecting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <GoogleMark className="mr-2 h-4 w-4" />
          )}
          {t('connect')}
        </Button>
        {!configured ? <SettingsRowNote>{t('not_configured')}</SettingsRowNote> : null}
      </div>

      <p className="max-w-[62ch] text-xs text-muted-foreground">{t('promise')}</p>

      <ConfirmDialog
        open={pendingDisconnect !== null}
        onOpenChange={(open) => !open && setPendingDisconnect(null)}
        title={t('disconnect_title')}
        description={t('disconnect_body', { address: pendingDisconnect?.emailAddress ?? '' })}
        confirmLabel={t('disconnect')}
        onConfirm={async () => {
          if (pendingDisconnect) await disconnect(pendingDisconnect)
        }}
      />
    </div>
  )
}
