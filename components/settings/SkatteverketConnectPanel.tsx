'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { CheckCircle2, ExternalLink, ShieldOff, FlaskConical, ShieldAlert } from 'lucide-react'

type Environment = 'test' | 'prod'

type Status =
  | { connected: false; environment?: Environment; disabled?: boolean }
  | {
      connected: true
      expired: boolean
      canRefresh: boolean
      needsReconsent?: boolean
      lastErrorCode?: string | null
      scope: string
      expiresAt: string
      environment?: Environment
      disabled?: boolean
    }

export function SkatteverketConnectPanel() {
  return (
    <div className="space-y-4">
      <SkatteverketPersonalConnectionCard />
      <SkatteverketSystemConnectionCard />
    </div>
  )
}

function SkatteverketPersonalConnectionCard() {
  const t = useTranslations('settings_skatteverket_connect')
  const { toast } = useToast()
  const hasSkatteverket = useCapability(CAPABILITY.skatteverket)
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
            <CardTitle className="text-base">{t('title')}</CardTitle>
            <EnvironmentBadge environment={status?.environment} disabled={status?.disabled} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.disabled && (
            <div className="flex gap-2 rounded-md border border-border bg-secondary/40 p-3 text-sm text-foreground">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <p>{t('disabled_message')}</p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t('connect_intro')}
          </p>
          {/* The skahmst consent-page note only matters when the user can
              actually reach that page: hidden while the feature is gated. */}
          {hasSkatteverket && (
            <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
              {t.rich('skahmst_note', {
                code: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </div>
          )}
          {!hasSkatteverket && (
            <UpgradeNote>Anslutning till Skatteverket kräver ett abonnemang.</UpgradeNote>
          )}
          <Button
            onClick={startConnect}
            disabled={status?.disabled || !hasSkatteverket}
            title={!hasSkatteverket ? 'Anslutning till Skatteverket kräver ett abonnemang' : undefined}
          >
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
          <CardTitle className="flex items-center gap-2 text-base">
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
        {status.needsReconsent && (
          <div className="flex gap-2 rounded-md border border-border bg-secondary/40 p-3 text-sm text-foreground">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{t('needs_reconsent_message')}</p>
          </div>
        )}
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
          <div className="flex gap-2 rounded-md border border-border bg-secondary/40 p-3 text-sm text-foreground">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{t('disabled_filings_message')}</p>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          {(status.expired || status.needsReconsent || !status.canRefresh || !scopes.includes('skattekonto') || !scopes.includes('agd')) && (
            <Button
              onClick={startConnect}
              disabled={status.disabled || !hasSkatteverket}
              title={!hasSkatteverket ? 'Anslutning till Skatteverket kräver ett abonnemang' : undefined}
            >
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

type GrantStatus = 'unknown' | 'granted' | 'denied' | 'error'

interface SystemConnectionState {
  available: boolean
  mode?: string
  environment?: string
  ombud_org_number?: string | null
  grant_url?: string
  cert?: { notAfter: string; daysUntilExpiry: number; expiresSoon: boolean } | null
  connection?: {
    status: string
    lasombud_status: GrantStatus
    moms_ombud_status: GrantStatus
    verified_at: string | null
    last_probe_at: string | null
  } | null
}

/**
 * The system (ombud + organization certificate) connection: the one-time
 * grant that lets background syncs run without a personal BankID session.
 * Renders nothing until SKATTEVERKET_SYSTEM_AUTH_MODE is switched on
 * server-side, so the whole section is invisible during Phase 1.
 */
function SkatteverketSystemConnectionCard() {
  const t = useTranslations('settings_skatteverket_connect')
  const { toast } = useToast()
  const [state, setState] = useState<SystemConnectionState | null>(null)
  const [verifying, setVerifying] = useState(false)

  async function loadState() {
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/system-connection')
      if (!res.ok) {
        setState({ available: false })
        return
      }
      setState((await res.json()) as SystemConnectionState)
    } catch {
      setState({ available: false })
    }
  }

  useEffect(() => {
    loadState()
  }, [])

  async function verify() {
    setVerifying(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/system-connection/verify', {
        method: 'POST',
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 429) {
        toast({ title: t('system_verify_rate_limited') })
        return
      }
      if (!res.ok) {
        toast({
          title: t('system_verify_failed'),
          description: typeof body?.error === 'string' ? body.error : undefined,
          variant: 'destructive',
        })
        return
      }
      await loadState()
    } catch {
      toast({ title: t('system_verify_failed'), variant: 'destructive' })
    } finally {
      setVerifying(false)
    }
  }

  if (!state?.available) return null

  const grantBadge = (status: GrantStatus | undefined) => {
    switch (status) {
      case 'granted':
        return (
          <Badge variant="success">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            {t('system_status_granted')}
          </Badge>
        )
      case 'denied':
        return <Badge variant="destructive">{t('system_status_denied')}</Badge>
      case 'error':
        return <Badge variant="warning">{t('system_status_error')}</Badge>
      default:
        return <Badge variant="outline">{t('system_status_unknown')}</Badge>
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('system_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('system_intro')}</p>

        {state.ombud_org_number && (
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <p className="text-muted-foreground">{t('system_org_label')}</p>
            <p className="font-mono font-medium tabular-nums">{state.ombud_org_number}</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border p-3">
            <span>{t('system_behorighet_lasombud')}</span>
            {grantBadge(state.connection?.lasombud_status)}
          </div>
          <div className="flex items-center justify-between gap-2 rounded-md border border-border p-3">
            <span>{t('system_behorighet_moms')}</span>
            {grantBadge(state.connection?.moms_ombud_status)}
          </div>
        </div>

        {state.cert?.expiresSoon && (
          <div className="flex gap-2 rounded-md border border-border bg-secondary/40 p-3 text-sm text-foreground">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{t('system_cert_expires_soon', { days: state.cert.daysUntilExpiry })}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {state.grant_url && (
            <Button variant="outline" asChild>
              <a href={state.grant_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                {t('system_open_ombud')}
              </a>
            </Button>
          )}
          <Button onClick={verify} disabled={verifying}>
            {verifying ? t('system_verifying') : t('system_verify')}
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
      <Badge variant="warning">
        <FlaskConical className="mr-1 h-3 w-3" />
        {t('env_test')}
      </Badge>
    )
  }
  if (environment === 'prod') {
    return (
      <Badge variant="success">
        {t('env_prod')}
      </Badge>
    )
  }
  return null
}
