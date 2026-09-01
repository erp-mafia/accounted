'use client'

import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { useCapability } from '@/contexts/CompanyContext'
import { isAllowedSkvPopupOrigin } from '@/lib/skatteverket/popup-origin'
import { isSelfHosted } from '@/lib/env/public-flags'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { CheckCircle2, ExternalLink, Loader2, ShieldOff, FlaskConical, ShieldAlert } from 'lucide-react'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { useBranding } from '@/lib/branding/brand-context'

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

/** Live warning inside a settings group: one warning-tone line, no banner. */
function WarningLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-b border-border px-1 py-3 text-[12.5px] leading-relaxed text-attn">
      {children}
    </p>
  )
}

export function SkatteverketConnectPanel() {
  return (
    <>
      <SkatteverketPersonalConnectionCard />
      <SkatteverketSystemConnectionCard />
    </>
  )
}

function SkatteverketPersonalConnectionCard() {
  const t = useTranslations('settings_skatteverket_connect')
  // Toast strings shared with TaxSettingsContent's query-param fallback path.
  const tOauth = useTranslations('settings_skatteverket')
  const { toast } = useToast()
  const hasSkatteverket = useCapability(CAPABILITY.skatteverket)
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  // True while an OAuth tab opened from this panel is still alive. Disables
  // the connect button so a second click cannot start a parallel flow: each
  // /authorize call overwrites the stored oauth_state + PKCE verifier, so a
  // parallel flow guarantees a CSRF failure for whichever tab finishes last.
  const [connecting, setConnecting] = useState(false)
  // Handle of the OAuth tab opened by startConnect: used to verify the
  // sender identity of incoming postMessages and to detect abandonment.
  const popupRef = useRef<Window | null>(null)
  const watchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const delayedRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopWatchingOauthTab = useCallback(() => {
    if (watchTimerRef.current) {
      clearInterval(watchTimerRef.current)
      watchTimerRef.current = null
    }
    setConnecting(false)
  }, [])

  useEffect(() => {
    return () => {
      if (watchTimerRef.current) clearInterval(watchTimerRef.current)
      if (delayedRefetchRef.current) clearTimeout(delayedRefetchRef.current)
    }
  }, [])

  // docs: https://www7.skatteverket.se/portal-wapi/open/apier-och-oppna-data/utvecklarportalen/v1/getFile/tjanstebeskrivning-skattekonto-hamta-huvudmans-saldo-och-transaktioner-v101
  const SCOPE_LABELS: Record<string, string> = {
    momsdeklaration: t('scope_momsdeklaration'),
    inkforetag: t('scope_inkforetag'),
    ska: t('scope_ska'),
    skahmst: t('scope_skahmst'),
    skattekonto: t('scope_skattekonto'),
    agd: t('scope_agd'),
  }

  // Only the first load blanks the section to the loading state: later
  // refetches (postMessage, closed-tab watcher, delayed sync refetch,
  // visibility) update in the background so the panel doesn't flash on every
  // signal.
  const hasLoadedRef = useRef(false)
  const loadStatus = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true)
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
      hasLoadedRef.current = true
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // Safety net for completion signals that never reach this tab: a mobile
  // BankID app-switch can land the OAuth return in a different browser tab,
  // and a bfcache-restored page shows a pre-connection snapshot. Refetch
  // status whenever the tab regains visibility, throttled so rapid tab
  // toggling doesn't hammer the API.
  const lastVisibilityFetchRef = useRef(0)
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastVisibilityFetchRef.current < 5_000) return
      lastVisibilityFetchRef.current = now
      loadStatus()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadStatus])

  // Listen for OAuth completion from the BankID popup (same pattern as
  // AGIPanel): the callback page posts success/error and closes itself, so
  // the settings page never navigates and we just re-fetch the status.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // The popup runs on the pinned SKV OAuth host, which differs from the
      // app origin after the app.accounted.se cutover.
      if (!isAllowedSkvPopupOrigin(event.origin, window.location.origin)) return
      // Source-identity check: only the popup this component opened can
      // trigger the handler; a window reference cannot be forged by other
      // same-origin scripts.
      if (!popupRef.current || event.source !== popupRef.current) return
      if (event.data?.type === 'skatteverket-oauth-success') {
        stopWatchingOauthTab()
        toast({
          title: tOauth('connected_title'),
          description: tOauth('connected_description'),
        })
        loadStatus()
        // Verified success: rebroadcast as an internal DOM event so passive
        // consumers (e.g. the salary page) can react without trusting raw
        // postMessage.
        window.dispatchEvent(new CustomEvent('skatteverket-connection-updated'))
        // The post-connect refresh (skattekonto sync, AGI settle, token
        // health) now runs server-side AFTER the callback responds, so the
        // status fetched above predates it. Refetch once more when it has
        // plausibly settled so synced data and health flags (e.g.
        // MISSING_SCOPE) show up without a manual reload.
        if (delayedRefetchRef.current) clearTimeout(delayedRefetchRef.current)
        delayedRefetchRef.current = setTimeout(() => {
          loadStatus()
          window.dispatchEvent(new CustomEvent('skatteverket-connection-updated'))
        }, 15_000)
      } else if (event.data?.type === 'skatteverket-oauth-error') {
        stopWatchingOauthTab()
        toast({
          title: tOauth('connect_failed_title'),
          description:
            typeof event.data.reason === 'string' && event.data.reason
              ? event.data.reason
              : undefined,
          variant: 'destructive',
        })
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [loadStatus, stopWatchingOauthTab, toast, tOauth])

  function startConnect() {
    // Open the BankID OAuth flow in a NEW TAB, not a popup. The old 600x750
    // popup could not fit Skatteverket's consent page: the approve button
    // sat below the fold and users got stranded mid-consent. A tab gets the
    // full viewport (and behaves natively on mobile). The callback page
    // detects `window.opener`, posts back a message and closes itself: the
    // settings page never navigates, so browser history stays clean and
    // closing the settings afterwards cannot walk Back into the consumed
    // OAuth chain (the "redirected to Skatteverket again" bug).
    const returnTo = encodeURIComponent('/settings/tax')
    const url = `/api/extensions/ext/skatteverket/authorize?return_to=${returnTo}`
    const tab = window.open(url, '_blank')
    popupRef.current = tab
    if (!tab) {
      // Tab blocked: fall back to the full-page flow. The callback then
      // lands on /settings/tax?skv_connected=true, handled by
      // TaxSettingsContent's query-param effect.
      window.location.href = url
      return
    }
    setConnecting(true)
    // Detect abandonment: if the tab goes away without posting a message
    // (closed manually, stranded on Skatteverket's side), re-enable the
    // button and refresh status. This also fires after a successful
    // self-close; the extra status fetch is harmless.
    if (watchTimerRef.current) clearInterval(watchTimerRef.current)
    watchTimerRef.current = setInterval(() => {
      if (popupRef.current?.closed) {
        stopWatchingOauthTab()
        loadStatus()
      }
    }, 1000)
  }

  async function disconnect() {
    // No disconnect while an OAuth tab is in flight: the callback completing
    // right after the disconnect would silently recreate the tokens.
    if (connecting) return
    setDisconnecting(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/disconnect', {
        method: 'POST',
      })
      if (!res.ok) throw new Error(t('disconnect_failed'))
      toast({ title: t('toast_disconnected') })
      await loadStatus()
      // Connection state changed: notify passive consumers via the same
      // internal event as a verified OAuth success.
      window.dispatchEvent(new CustomEvent('skatteverket-connection-updated'))
    } catch (err) {
      toast({
        title: t('toast_disconnect_failed'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setDisconnecting(false)
    }
  }

  // Static connect guidance lives behind the "?": what the connection is
  // used for, plus the consent-page instructions ("godkänn alla
  // behörigheter", the ska/skahmst explainer). The consent notes only matter
  // when the user can actually reach the consent page: hidden while the
  // feature is entitlement-gated.
  const connectHelp = (
    <div className="space-y-2">
      <p>{t('connect_intro')}</p>
      {hasSkatteverket && (
        <>
          <p>{t('connect_approve_all')}</p>
          <p>
            {t.rich('skahmst_note', {
              code: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
        </>
      )}
    </div>
  )

  if (loading) {
    return (
      <SettingsGroup>
        <SettingsRow label={
          <span className="inline-flex items-center gap-2">
            <Image src="/logos/skatteverket.svg" alt="" aria-hidden="true" width={14} height={14} className="dark:invert" />
            {t('title')}
          </span>
        } help={connectHelp} borderless>
          <SettingsRowNote>{t('loading_status')}</SettingsRowNote>
        </SettingsRow>
      </SettingsGroup>
    )
  }

  if (!status?.connected) {
    return (
      <SettingsGroup>
        {status?.disabled && <WarningLine>{t('disabled_message')}</WarningLine>}
        <SettingsRow label={
          <span className="inline-flex items-center gap-2">
            <Image src="/logos/skatteverket.svg" alt="" aria-hidden="true" width={14} height={14} className="dark:invert" />
            {t('title')}
          </span>
        } help={connectHelp} borderless={!hasSkatteverket}>
          <EnvironmentBadge environment={status?.environment} disabled={status?.disabled} />
          <SettingsRowEnd>
            <Button
              size="sm"
              onClick={startConnect}
              disabled={status?.disabled || !hasSkatteverket || connecting}
              title={
                !hasSkatteverket
                  ? isSelfHosted()
                    ? t('connect_requires_connector_key')
                    : t('connect_requires_subscription')
                  : undefined
              }
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {connecting ? t('connect_waiting') : t('connect_with_bankid')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
        {!hasSkatteverket && (
          <div className="px-1 py-3">
            <UpgradeNote>Anslutning till Skatteverket kräver ett abonnemang.</UpgradeNote>
          </div>
        )}
      </SettingsGroup>
    )
  }

  const scopes = (status.scope || '').split(/\s+/).filter(Boolean)
  const expiresAtDate = new Date(status.expiresAt)
  const expiresInMinutes = Math.round(
    (expiresAtDate.getTime() - Date.now()) / 60_000,
  )

  return (
    <SettingsGroup>
      {status.needsReconsent && (
        <WarningLine>
          {/* MISSING_SCOPE right after a connect means the user skipped a
              behörighet on SKV's consent page; tell them exactly that
              instead of the generic "session expired" prompt. */}
          {status.lastErrorCode === 'MISSING_SCOPE'
            ? t('missing_scope_message')
            : t('needs_reconsent_message')}
        </WarningLine>
      )}

      <SettingsRow label={
          <span className="inline-flex items-center gap-2">
            <Image src="/logos/skatteverket.svg" alt="" aria-hidden="true" width={14} height={14} className="dark:invert" />
            {t('title')}
          </span>
        } help={connectHelp}>
        {status.expired ? (
          <Badge variant="warning">{t('expired')}</Badge>
        ) : (
          <Badge variant="success">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            {t('connected')}
          </Badge>
        )}
        <EnvironmentBadge environment={status.environment} disabled={status.disabled} />
        <SettingsRowEnd>
          {/* `ska` gates the interactive skattekonto API (saldo +
              transaktioner); a grant without it cannot sync, so offer the
              reconnect even while the token is otherwise healthy. */}
          {(status.expired || status.needsReconsent || !status.canRefresh || !scopes.includes('ska') || !scopes.includes('agd')) && (
            <Button
              size="sm"
              onClick={startConnect}
              disabled={status.disabled || !hasSkatteverket || connecting}
              title={
                !hasSkatteverket
                  ? isSelfHosted()
                    ? t('connect_requires_connector_key')
                    : t('connect_requires_subscription')
                  : undefined
              }
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {connecting ? t('connect_waiting') : t('reconnect')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={disconnect}
            disabled={disconnecting || connecting}
          >
            <ShieldOff className="mr-2 h-4 w-4" />
            {disconnecting ? t('disconnecting') : t('disconnect')}
          </Button>
        </SettingsRowEnd>
      </SettingsRow>

      <SettingsRow label={t('token_expires_label')} help={t('session_lifetime_note')}>
        <SettingsRowNote className="tabular-nums">
          {expiresAtDate.toLocaleString('sv-SE')}
          {!status.expired && expiresInMinutes > 0 && (
            <> {t('expires_in_minutes', { minutes: expiresInMinutes })}</>
          )}
        </SettingsRowNote>
      </SettingsRow>

      <SettingsRow label={t('refresh_label')}>
        <SettingsRowNote>
          {status.canRefresh ? t('refresh_auto') : t('refresh_exhausted')}
        </SettingsRowNote>
      </SettingsRow>

      <SettingsRow label={t('permissions_label')}>
        <div className="flex flex-wrap gap-2">
          {scopes.map(s => (
            <Badge key={s} variant="outline">
              {SCOPE_LABELS[s] ?? s}
            </Badge>
          ))}
        </div>
      </SettingsRow>

      {/* `ska` is the scope the interactive skattekonto API enforces;
          skahmst (bulk E-transport service) does not substitute for it.
          Missing scopes are actionable state: keep them visible. */}
      {!scopes.includes('ska') && <WarningLine>{t('missing_skattekonto')}</WarningLine>}
      {!scopes.includes('agd') && <WarningLine>{t('missing_agd')}</WarningLine>}
      {status.disabled && <WarningLine>{t('disabled_filings_message')}</WarningLine>}
    </SettingsGroup>
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
  const { appName } = useBranding()
  const { toast } = useToast()
  const [state, setState] = useState<SystemConnectionState | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [linking, setLinking] = useState(false)

  /**
   * Ombudshantering deep link: Skatteverket's e-service opens with the app
   * pre-filled as ombud and both roles pre-selected, so the company only
   * signs. The tab is opened synchronously on click (popup blockers) and
   * pointed at the link once the server has minted it.
   */
  async function openDeepLink() {
    setLinking(true)
    // No 'noopener' feature here: with it window.open returns null and the
    // pre-opened tab (the popup-blocker mitigation) would never exist. The
    // opener link is cut by hand instead.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/system-connection/deeplink', {
        method: 'POST',
      })
      const body = await res.json().catch(() => ({}))
      const url = typeof body?.data?.djuplank === 'string' ? body.data.djuplank : null
      if (!res.ok || !url) {
        tab?.close()
        toast({
          title: t('system_deeplink_failed'),
          description: typeof body?.error === 'string' ? body.error : undefined,
          variant: 'destructive',
        })
        return
      }
      // A blocked pre-open means a second window.open after the await would
      // be blocked too: navigate this tab instead so the link is never lost.
      if (tab) tab.location.href = url
      else window.location.assign(url)
    } catch {
      tab?.close()
      toast({ title: t('system_deeplink_failed'), variant: 'destructive' })
    } finally {
      setLinking(false)
    }
  }

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
    <SettingsGroup label={t('system_title')} help={t('system_intro', { appName })}>
      {state.ombud_org_number && (
        <SettingsRow label={t('system_org_label')}>
          <span className="font-mono text-sm tabular-nums">{state.ombud_org_number}</span>
        </SettingsRow>
      )}

      <SettingsRow label={t('system_behorighet_lasombud')}>
        {grantBadge(state.connection?.lasombud_status)}
      </SettingsRow>
      <SettingsRow label={t('system_behorighet_moms')}>
        {grantBadge(state.connection?.moms_ombud_status)}
      </SettingsRow>

      {state.cert?.expiresSoon && (
        <WarningLine>
          {t('system_cert_expires_soon', { days: state.cert.daysUntilExpiry, appName })}
        </WarningLine>
      )}

      <div className="flex flex-wrap items-center gap-4 px-1 py-3">
        <Button size="sm" variant="outline" onClick={openDeepLink} disabled={linking} title={t('system_deeplink_hint', { appName })}>
          {linking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
          {linking ? t('system_deeplink_loading') : t('system_deeplink', { appName })}
        </Button>
        {state.grant_url && (
          <a
            href={state.grant_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('system_open_ombud')}
          </a>
        )}
        <Button size="sm" onClick={verify} disabled={verifying}>
          {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {verifying ? t('system_verifying') : t('system_verify')}
        </Button>
      </div>
    </SettingsGroup>
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
