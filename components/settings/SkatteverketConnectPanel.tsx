'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { CheckCircle2, ExternalLink, ShieldOff, FlaskConical, ShieldAlert } from 'lucide-react'

type Environment = 'test' | 'prod'

type Status =
  | { connected: false; environment?: Environment; disabled?: boolean }
  | {
      connected: true
      expired: boolean
      canRefresh: boolean
      scope: string
      expiresAt: string
      environment?: Environment
      disabled?: boolean
    }

export function SkatteverketConnectPanel() {
  const t = useTranslations('settings_skatteverket_connect')
  const { toast } = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)

  // docs: https://www7.skatteverket.se/portal-wapi/open/apier-och-oppna-data/utvecklarportalen/v1/getFile/tjanstebeskrivning-skattekonto-hamta-huvudmans-saldo-och-transaktioner-v101
  const SCOPE_LABELS: Record<string, string> = {
    momsdeklaration: t('scope_momsdeklaration'),
    inkforetag: t('scope_inkforetag'),
    skahmst: t('scope_skahmst'),
    skattekonto: t('scope_skattekonto'),
    agd: t('scope_agd'),
  }

  async function loadStatus() {
    setLoading(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/status')
      if (res.status === 503) {
        setStatus({ connected: false })
        return
      }
      const data = (await res.json()) as Status
      setStatus(data)
    } catch {
      setStatus({ connected: false })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  function startConnect() {
    const returnTo = encodeURIComponent('/settings/tax')
    window.location.href = `/api/extensions/ext/skatteverket/authorize?return_to=${returnTo}`
  }

  async function disconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/disconnect', {
        method: 'POST',
      })
      if (!res.ok) throw new Error(t('disconnect_failed'))
      toast({ title: t('toast_disconnected') })
      await loadStatus()
    } catch (err) {
      toast({
        title: t('toast_disconnect_failed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setDisconnecting(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          {t('loading_status')}
        </CardContent>
      </Card>
    )
  }

  if (!status?.connected) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('title')}</CardTitle>
            <EnvironmentBadge environment={status?.environment} disabled={status?.disabled} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.disabled && (
            <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <p>{t('disabled_message')}</p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t('connect_intro')}
          </p>
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
            {t.rich('skahmst_note', {
              code: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </div>
          <Button onClick={startConnect} disabled={status?.disabled}>
            <ExternalLink className="mr-2 h-4 w-4" />
            {t('connect_with_bankid')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const scopes = (status.scope || '').split(/\s+/).filter(Boolean)
  const expiresAtDate = new Date(status.expiresAt)
  const expiresInMinutes = Math.round(
    (expiresAtDate.getTime() - Date.now()) / 60_000,
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {t('title')}
            {status.expired ? (
              <Badge variant="destructive">{t('expired')}</Badge>
            ) : (
              <Badge variant="secondary">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                {t('connected')}
              </Badge>
            )}
          </CardTitle>
          <EnvironmentBadge environment={status.environment} disabled={status.disabled} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t('token_expires_label')}</dt>
            <dd className="font-medium tabular-nums">
              {expiresAtDate.toLocaleString('sv-SE')}
              {!status.expired && expiresInMinutes > 0 && (
                <span className="ml-2 text-muted-foreground">
                  {t('expires_in_minutes', { minutes: expiresInMinutes })}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('refresh_label')}</dt>
            <dd className="font-medium">
              {status.canRefresh ? t('refresh_auto') : t('refresh_exhausted')}
            </dd>
          </div>
        </dl>

        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            {t('permissions_label')}
          </p>
          <div className="flex flex-wrap gap-2">
            {scopes.map(s => (
              <Badge key={s} variant="outline">
                {SCOPE_LABELS[s] ?? s}
              </Badge>
            ))}
          </div>
          {!scopes.includes('skahmst') && !scopes.includes('skattekonto') && (
            <p className="mt-3 text-sm text-foreground">
              {t('missing_skattekonto')}
            </p>
          )}
          {!scopes.includes('agd') && (
            <p className="mt-3 text-sm text-foreground">
              {t('missing_agd')}
            </p>
          )}
        </div>

        {status.disabled && (
          <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{t('disabled_filings_message')}</p>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          {(status.expired || !status.canRefresh || !scopes.includes('skattekonto') || !scopes.includes('agd')) && (
            <Button onClick={startConnect} disabled={status.disabled}>
              <ExternalLink className="mr-2 h-4 w-4" />
              {t('reconnect')}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={disconnect}
            disabled={disconnecting}
          >
            <ShieldOff className="mr-2 h-4 w-4" />
            {disconnecting ? t('disconnecting') : t('disconnect')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function EnvironmentBadge({ environment, disabled }: { environment?: Environment; disabled?: boolean }) {
  const t = useTranslations('settings_skatteverket_connect')
  if (disabled) {
    return (
      <Badge variant="destructive">
        <ShieldAlert className="mr-1 h-3 w-3" />
        {t('env_disabled')}
      </Badge>
    )
  }
  if (environment === 'test') {
    return (
      <Badge variant="outline" className="border-amber-400 text-amber-700 dark:border-amber-600 dark:text-amber-400">
        <FlaskConical className="mr-1 h-3 w-3" />
        {t('env_test')}
      </Badge>
    )
  }
  if (environment === 'prod') {
    return (
      <Badge variant="outline" className="border-emerald-400 text-emerald-700 dark:border-emerald-600 dark:text-emerald-400">
        {t('env_prod')}
      </Badge>
    )
  }
  return null
}
