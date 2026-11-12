'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { useCapability } from '@/contexts/CompanyContext'
import { isSkvPopupOrigin, type SkvPopupMessage } from '@/lib/skatteverket/popup-origin'
import { useOAuthPopup } from '@/lib/hooks/use-oauth-popup'
import { isSelfHosted } from '@/lib/env/public-flags'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import {
  ArrowTopRightOnSquareIcon,
  BeakerIcon,
  BuildingLibraryIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  EllipsisHorizontalIcon,
  ShieldExclamationIcon,
} from '@/components/icons'
import { cn } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { useBranding } from '@/lib/branding/brand-context'
import { useOmbudAppointWithToasts } from '@/components/skatteverket/ombud-appoint'
import type { OmbudAppointment, OmbudRole, OmbudRoleState } from '@/lib/skatteverket/ombud-appointment'

type Environment = 'test' | 'prod'

type Status =
  | { connected: false; environment?: Environment; disabled?: boolean }
  | {
      connected: true
      expired: boolean
      canRefresh: boolean
      needsReconsent?: boolean
      lastErrorCode?: string | null
      /** Skatteverket's last "no skattekonto yet / not authorized" answer, if any. */
      skattekontoUnavailable?: { reason: 'no_account' | 'not_authorized'; since: string; checkedAt: string } | null
      scope: string
      expiresAt: string
      environment?: Environment
      disabled?: boolean
    }

interface SystemConnectionState {
  available: boolean
  mode?: string
  environment?: string
  ombud_org_number?: string | null
  grant_url?: string
  cert?: { notAfter: string; daysUntilExpiry: number; expiresSoon: boolean } | null
  /** Where the appointment stands (lib/skatteverket/ombud-appointment.ts). */
  appointment?: OmbudAppointment
}

/** Live warning inside a settings group: one warning-tone line, no banner. */
function WarningLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-b border-border px-1 py-3 text-[12.5px] leading-relaxed text-attn">
      {children}
    </p>
  )
}

/** One quiet line inside a settings group, for a state that needs no action. */
function NoteLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-b border-border px-1 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/**
 * Kopplingar → Skatteverket. Two connections that do different jobs, in the
 * order a company needs them:
 *
 *   1. Ombud (when system auth is on): the company appoints the app as its
 *      ombud once, and the skattekonto and the declarations' status are read
 *      in the background with no login. The main step, at the top.
 *   2. BankID: a personal login, needed when someone submits a declaration
 *      (moms, AGI). Below, as the secondary step, its technical rows folded
 *      away under Detaljer.
 *
 * With system auth off (or self-hosted without a certificate) the ombud step
 * is not there at all and the BankID connection is the page, as before.
 */
export function SkatteverketConnectPanel({ title }: { title: string }) {
  const t = useTranslations('settings_skatteverket_connect')
  const { appName } = useBranding()
  const [system, setSystem] = useState<SystemConnectionState | null>(null)

  const loadSystem = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/system-connection')
      if (!res.ok) {
        setSystem({ available: false })
        return
      }
      setSystem((await res.json()) as SystemConnectionState)
    } catch {
      setSystem({ available: false })
    }
  }, [])

  useEffect(() => {
    void loadSystem()
  }, [loadSystem])

  const ombudAvailable = system?.available === true
  // The difference between the two, behind the "?" beside the title (a
  // popover, so it opens on a tap as well as a click).
  const intro = system === null
    ? undefined
    : ombudAvailable
      ? (
          <div className="space-y-2">
            <p>{t.rich('intro_ombud', { appName, b: (chunks) => <b className="font-medium">{chunks}</b> })}</p>
            <p>{t.rich('intro_bankid', { b: (chunks) => <b className="font-medium">{chunks}</b> })}</p>
          </div>
        )
      : t('connect_intro')

  return (
    <>
      <SettingsSectionHeader title={title} intro={intro} />
      {system === null ? (
        <SettingsGroup>
          <SettingsRow label={t('title')} borderless>
            <SettingsRowNote>{t('loading_status')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
      ) : (
        <>
          {ombudAvailable && <OmbudStep state={system} reload={loadSystem} />}
          <SkatteverketPersonalConnectionCard
            secondary={ombudAvailable}
            readsCovered={ombudAvailable && readsRunOnOmbud(system.appointment)}
          />
        </>
      )}
    </>
  )
}

const NOT_APPOINTED: OmbudAppointment = { state: 'none', predatesOptIn: false }

/** The background reads run on läsombud: with it granted, the BankID login is only for submitting. */
function readsRunOnOmbud(appointment: OmbudAppointment | undefined): boolean {
  return appointment !== undefined && 'roles' in appointment && appointment.roles.lasombud === 'granted'
}

/**
 * The ombud step: one status and one button. The button asks Skatteverket's
 * register first (server-side, in the deep link route): already appointed
 * with both roles reads Klart with no trip to Skatteverket; otherwise
 * Skatteverket's e-service opens with the roles pre-selected and the company
 * signs there. Nothing calls back after signing, so the grant is checked once
 * when the user returns, and the hourly ombud sync finds one Skatteverket
 * registers later (minutes to an hour): until then the status says it is
 * waiting on Skatteverket. Red is kept for a grant that counted and no longer
 * does.
 */
function OmbudStep({ state, reload }: { state: SystemConnectionState; reload: () => Promise<void> }) {
  const t = useTranslations('settings_skatteverket_connect')
  const tOmbud = useTranslations('skatteverket_ombud')
  const { appName } = useBranding()
  const { appoint, linking, checking } = useOmbudAppointWithToasts(() => {
    void reload()
  })

  const appointment = state.appointment ?? NOT_APPOINTED
  const roles = 'roles' in appointment ? appointment.roles : null
  const done = roles !== null && roles.lasombud === 'granted' && roles.moms_ombud === 'granted'
  // Appointed with one role only: say which role is missing, and offer the
  // link again (it pre-selects both).
  const missingRoles: OmbudRole[] =
    appointment.state === 'appointed' && !done && roles
      ? (['lasombud', 'moms_ombud'] as const).filter((role) => roles[role] !== 'granted')
      : []

  const roleLabel = (role: OmbudRole) =>
    role === 'lasombud' ? t('system_behorighet_lasombud') : t('system_behorighet_moms')
  const roleStateLabel = (role: OmbudRoleState) =>
    role === 'withdrawn'
      ? t('system_status_withdrawn')
      : role === 'error'
        ? t('system_status_error')
        : t('system_status_not_included')

  const status = done ? (
    <span className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground">
      <CheckCircleIcon className="h-3.5 w-3.5" />
      {tOmbud('done')}
    </span>
  ) : appointment.state === 'waiting' ? (
    <Badge variant="secondary">{tOmbud('waiting')}</Badge>
  ) : appointment.state === 'withdrawn' ? (
    <Badge variant="destructive">{t('system_status_withdrawn')}</Badge>
  ) : appointment.state === 'appointed' ? (
    <Badge variant="warning">{t('ombud_partial')}</Badge>
  ) : (
    <SettingsRowNote>{tOmbud('none')}</SettingsRowNote>
  )

  const help = (
    <div className="space-y-2">
      <p>{t('system_intro', { appName })}</p>
      <p>{t('ombud_checks_first', { appName })}</p>
      {state.ombud_org_number && (
        <p>
          {t('system_org_label')}: <span className="font-mono tabular-nums">{state.ombud_org_number}</span>
        </p>
      )}
      {/* The way round a deep link Skatteverket turns down ("Felaktig länk"):
          the same appointment made by hand in the e-service (crm#1814). */}
      {state.ombud_org_number && (
        <p>
          {t('system_manual', {
            appName,
            lasombud: t('system_behorighet_lasombud'),
            moms: t('system_behorighet_moms'),
          })}
        </p>
      )}
      {state.grant_url && (
        <p>
          <a
            href={state.grant_url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground"
          >
            {t('system_open_ombud')}
          </a>
        </p>
      )}
    </div>
  )

  const busy = linking || checking

  return (
    <SettingsGroup label={t('system_title')}>
      <SettingsRow label={t('system_status_label')} help={help}>
        {status}
        {!done && (
          <SettingsRowEnd>
            {/* Waiting: the signature may be unfinished, so the same button
                opens the link again, quieter, as on Hem and Kom igång. */}
            <Button
              size="sm"
              variant={appointment.state === 'waiting' ? 'outline' : 'default'}
              onClick={() => void appoint()}
              loading={busy}
              title={t('system_deeplink_hint', { appName })}
            >
              {!busy && <ArrowTopRightOnSquareIcon className="mr-2 h-4 w-4" />}
              {appointment.state === 'waiting' ? tOmbud('reopen') : t('system_deeplink', { appName })}
            </Button>
          </SettingsRowEnd>
        )}
      </SettingsRow>

      {appointment.state === 'waiting' && <NoteLine>{tOmbud('waiting_hint', { appName })}</NoteLine>}
      {appointment.state === 'withdrawn' && <WarningLine>{tOmbud('withdrawn_hint', { appName })}</WarningLine>}
      {roles &&
        missingRoles.map((role) => (
          <NoteLine key={role}>
            {roleLabel(role)}: {roleStateLabel(roles[role])}
          </NoteLine>
        ))}
      {appointment.predatesOptIn && <WarningLine>{t('system_predates_opt_in', { appName })}</WarningLine>}
      {state.cert?.expiresSoon && (
        <WarningLine>
          {t('system_cert_expires_soon', { days: state.cert.daysUntilExpiry, appName })}
        </WarningLine>
      )}
    </SettingsGroup>
  )
}

/**
 * The personal BankID connection. `secondary`: the ombud step sits above, so
 * this is the login for submitting declarations: its own eyebrow and an
 * outline button. `readsCovered`: the ombud already does the background
 * reads, so an expired session is the normal resting state, not a warning;
 * until then an expired session still stops the skattekonto sync and says so.
 */
function SkatteverketPersonalConnectionCard({
  secondary,
  readsCovered,
}: {
  secondary: boolean
  readsCovered: boolean
}) {
  const t = useTranslations('settings_skatteverket_connect')
  // Toast strings shared with TaxSettingsContent's query-param fallback path.
  const tOauth = useTranslations('settings_skatteverket')
  const { toast } = useToast()
  const hasSkatteverket = useCapability(CAPABILITY.skatteverket)
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  // True while an OAuth tab opened from this panel is still alive. Disables
  // the connect button so a second click cannot start a parallel flow: each
  // /authorize call overwrites the stored oauth_state + PKCE verifier, so a
  // parallel flow guarantees a CSRF failure for whichever tab finishes last.
  const [connecting, setConnecting] = useState(false)
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

  // Handle of the OAuth tab opened by startConnect (same pattern as
  // AGIPanel). Only messages from that tab, on the app origin or the pinned
  // SKV OAuth host, reach the handler; the watch in startConnect uses it to
  // detect abandonment. The callback page posts success/error and closes
  // itself, so the settings page never navigates and we just re-fetch the
  // status.
  const popupRef = useOAuthPopup<SkvPopupMessage>((data) => {
    if (data?.type === 'skatteverket-oauth-success') {
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
    } else if (data?.type === 'skatteverket-oauth-error') {
      stopWatchingOauthTab()
      toast({
        title: tOauth('connect_failed_title'),
        description:
          typeof data.reason === 'string' && data.reason
            ? data.reason
            : undefined,
        variant: 'destructive',
      })
    }
  }, isSkvPopupOrigin)

  function startConnect() {
    // Open the BankID OAuth flow in a NEW TAB, not a popup. The old 600x750
    // popup could not fit Skatteverket's consent page: the approve button
    // sat below the fold and users got stranded mid-consent. A tab gets the
    // full viewport (and behaves natively on mobile). The callback page
    // detects `window.opener`, posts back a message and closes itself: the
    // settings page never navigates, so browser history stays clean and
    // closing the settings afterwards cannot walk Back into the consumed
    // OAuth chain (the "redirected to Skatteverket again" bug).
    const returnTo = encodeURIComponent('/settings/skatteverket')
    const url = `/api/extensions/ext/skatteverket/authorize?return_to=${returnTo}`
    const tab = window.open(url, '_blank')
    popupRef.current = tab
    if (!tab) {
      // Tab blocked: fall back to the full-page flow. The callback then
      // lands on /settings/skatteverket?skv_connected=true, handled by
      // SkatteverketSettingsContent's query-param effect.
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

  // The consent-page instructions ("godkänn alla behörigheter", the
  // ska/skahmst explainer) live behind the row's "?"; what the connection is
  // for sits behind the section title's. They only matter when the user can
  // actually reach the consent page: hidden while the feature is
  // entitlement-gated.
  const connectHelp = hasSkatteverket ? (
    <div className="space-y-2">
      <p>{t('connect_approve_all')}</p>
      <p>
        {t.rich('skahmst_note', {
          code: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </p>
    </div>
  ) : undefined

  const groupLabel = secondary ? t('bankid_title') : undefined
  // Secondary: what BankID is for sits under its name, where the label
  // column has room, so the "?" moves into the label beside the name.
  const rowLabel = secondary ? (
    <span className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        <BuildingLibraryIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {t('bankid_label')}
        {connectHelp ? <HelpPopover className="shrink-0">{connectHelp}</HelpPopover> : null}
      </span>
      <span className="text-[12.5px] text-muted-foreground">{t('bankid_line')}</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-2">
      <BuildingLibraryIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {t('title')}
    </span>
  )
  const rowHelp = secondary ? undefined : connectHelp
  const connectTitle = !hasSkatteverket
    ? isSelfHosted()
      ? t('connect_requires_connector_key')
      : t('connect_requires_subscription')
    : undefined

  if (loading) {
    return (
      <SettingsGroup label={groupLabel}>
        <SettingsRow label={rowLabel} help={rowHelp} borderless>
          <SettingsRowNote>{t('loading_status')}</SettingsRowNote>
        </SettingsRow>
      </SettingsGroup>
    )
  }

  if (!status?.connected) {
    return (
      <SettingsGroup label={groupLabel}>
        {status?.disabled && <WarningLine>{t('disabled_message')}</WarningLine>}
        <SettingsRow label={rowLabel} help={rowHelp} borderless={!hasSkatteverket}>
          <EnvironmentBadge environment={status?.environment} disabled={status?.disabled} quietProd={secondary} />
          <SettingsRowEnd>
            <Button
              size="sm"
              variant={secondary ? 'outline' : 'default'}
              onClick={startConnect}
              disabled={status?.disabled || !hasSkatteverket || connecting}
              title={connectTitle}
            >
              <ArrowTopRightOnSquareIcon className="mr-2 h-4 w-4" />
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
  const skattekontoReason = status.skattekontoUnavailable?.reason ?? null
  // `ska` gates the interactive skattekonto API (saldo + transaktioner); a
  // grant without it cannot sync, so the reconnect is offered even while the
  // token is otherwise healthy.
  const offerReconnect =
    status.expired ||
    status.needsReconsent ||
    !status.canRefresh ||
    !scopes.includes('ska') ||
    !scopes.includes('agd') ||
    skattekontoReason === 'not_authorized'
  const expiresAtDate = new Date(status.expiresAt)
  const expiresInMinutes = Math.round(
    (expiresAtDate.getTime() - Date.now()) / 60_000,
  )

  return (
    <SettingsGroup label={groupLabel}>
      {/* "Automatic syncing is paused" is untrue while the ombud does the
          reads; a missing scope still blocks a submission. */}
      {status.needsReconsent && (!readsCovered || status.lastErrorCode === 'MISSING_SCOPE') && (
        <WarningLine>
          {/* MISSING_SCOPE right after a connect means the user skipped a
              behörighet on SKV's consent page; tell them exactly that
              instead of the generic "session expired" prompt. */}
          {status.lastErrorCode === 'MISSING_SCOPE'
            ? t('missing_scope_message')
            : t('needs_reconsent_message')}
        </WarningLine>
      )}

      <SettingsRow label={rowLabel} help={rowHelp}>
        {status.expired ? (
          // With the ombud doing the background reads, an expired login is
          // where the BankID session normally rests: the next submission
          // asks for a new one.
          readsCovered ? (
            <SettingsRowNote>{t('expired')}</SettingsRowNote>
          ) : (
            <Badge variant="warning">{t('expired')}</Badge>
          )
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircleIcon className="h-3.5 w-3.5" />
            {t('connected')}
          </span>
        )}
        <EnvironmentBadge environment={status.environment} disabled={status.disabled} quietProd={secondary} />
        <SettingsRowEnd>
          {offerReconnect && (
            <Button
              size="sm"
              variant={secondary ? 'outline' : 'default'}
              onClick={startConnect}
              disabled={status.disabled || !hasSkatteverket || connecting}
              title={connectTitle}
            >
              <ArrowTopRightOnSquareIcon className="mr-2 h-4 w-4" />
              {connecting ? t('connect_waiting') : t('reconnect')}
            </Button>
          )}
          {/* One button per row: beside the reconnect, Koppla från waits behind "...". */}
          {offerReconnect ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label={t('more_actions')} disabled={disconnecting || connecting}>
                  <EllipsisHorizontalIcon className="h-[15px] w-[15px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void disconnect()}>{t('disconnect')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="outline" size="sm" onClick={disconnect} loading={disconnecting} disabled={connecting}>
              {!disconnecting && <ShieldExclamationIcon className="mr-2 h-4 w-4" />}
              {t('disconnect')}
            </Button>
          )}
        </SettingsRowEnd>
      </SettingsRow>

      {/* `ska` is the scope the interactive skattekonto API enforces;
          skahmst (bulk E-transport service) does not substitute for it.
          Missing scopes are actionable state: keep them visible, outside
          Detaljer. */}
      {!scopes.includes('ska') && <WarningLine>{t('missing_skattekonto')}</WarningLine>}
      {/* Skatteverket's own answer on the last skattekonto read: a person
          without authorization is something the user can act on. */}
      {skattekontoReason === 'not_authorized' && <WarningLine>{t('skattekonto_not_authorized')}</WarningLine>}
      {!scopes.includes('agd') && <WarningLine>{t('missing_agd')}</WarningLine>}
      {status.disabled && <WarningLine>{t('disabled_filings_message')}</WarningLine>}

      {/* The token's own facts: useful when something is off, noise otherwise. */}
      <button
        type="button"
        onClick={() => setDetailsOpen((open) => !open)}
        aria-expanded={detailsOpen}
        aria-controls={detailsId}
        className="flex w-full items-center gap-2 px-1 py-3 text-left text-[12.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ChevronDownIcon
          className={cn('h-3.5 w-3.5 transition-transform duration-150', detailsOpen && 'rotate-180')}
          aria-hidden="true"
        />
        {t('details')}
      </button>
      <div id={detailsId}>
        <SettingsReveal open={detailsOpen} indent={false}>
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

          <SettingsRow label={t('permissions_label')} borderless={skattekontoReason !== 'no_account'}>
            <div className="flex flex-wrap gap-2">
              {scopes.map(s => (
                <Badge key={s} variant="outline">
                  {SCOPE_LABELS[s] ?? s}
                </Badge>
              ))}
            </div>
          </SettingsRow>

          {/* No skattekonto yet is a state to explain, not a fault. */}
          {skattekontoReason === 'no_account' && (
            <SettingsRow label={t('scope_skattekonto')} borderless>
              <SettingsRowNote>{t('skattekonto_no_account')}</SettingsRowNote>
            </SettingsRow>
          )}
        </SettingsReveal>
      </div>
    </SettingsGroup>
  )
}

/** `quietProd`: production is the normal state, so only test or disabled says anything. */
function EnvironmentBadge({
  environment,
  disabled,
  quietProd = false,
}: {
  environment?: Environment
  disabled?: boolean
  quietProd?: boolean
}) {
  const t = useTranslations('settings_skatteverket_connect')
  if (disabled) {
    return (
      <Badge variant="destructive">
        <ShieldExclamationIcon className="mr-1 h-3 w-3" />
        {t('env_disabled')}
      </Badge>
    )
  }
  if (environment === 'test') {
    return (
      <Badge variant="warning">
        <BeakerIcon className="mr-1 h-3 w-3" />
        {t('env_test')}
      </Badge>
    )
  }
  if (environment === 'prod' && !quietProd) {
    return (
      <span className="text-xs text-muted-foreground">{t('env_prod')}</span>
    )
  }
  return null
}
