'use client'

import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import React, { useState, useEffect, useCallback } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileCheck,
  Info,
  Link2,
  Loader2,
  MoreHorizontal,
  Send,
  ShieldAlert,
} from 'lucide-react'
import type { VatPeriodType } from '@/types'
import { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'
import { useCapability, useCompanyOptional } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { formatAmount } from '@/lib/utils'

interface SkatteverketStatus {
  connected: boolean
  expired?: boolean
  canRefresh?: boolean
  scope?: string
  expiresAt?: string
}

/**
 * Codes from /lib/api-client.ts's SkatteverketAuthError that mean "the user
 * needs to reconnect with BankID before this action can succeed". When the API
 * returns one of these codes we flip the local status.expired flag so the
 * expired-session attn line with its "Förnya med BankID" action surfaces,
 * even if the upstream /status endpoint hasn't reflected the change yet.
 */
const AUTH_RECONNECT_CODES = new Set([
  'NOT_CONNECTED',
  'SESSION_EXPIRED',
  'REFRESH_EXHAUSTED',
  'TOKEN_REVOKED',
  'TOKEN_CORRUPTED',
  'MISSING_SCOPE',
])

// Shape per Skatteverket Momsdeklaration v1.0.24 RAML
// (kontrollResultat.resultat[].{kod, status, beskrivning})
interface KontrollResult {
  kod: string
  status: 'ERROR' | 'WARNING'
  beskrivning: string
}

interface SkatteverketPanelProps {
  periodType: VatPeriodType
  year: number
  period: number
  /**
   * Selected räkenskapsår for helårsmoms. The SKV redovisningsperiod for
   * yearly filers is the FY-end month (broken FYs do not end in December),
   * and the `year` prop is not maintained in yearly mode, so both the period
   * id and the fiscal-year end ride along explicitly.
   */
  fiscalPeriodId?: string
  fiscalYearEnd?: { year: number; month: number }
  hasData: boolean
  /**
   * True when the momsdeklaration's filing gate is closed. Blocks
   * validate/submit: SKV only validates internal arithmetic, so a locally
   * broken declaration would pass their checks and still be materially wrong.
   *
   * The panel deliberately owns NO gate logic of its own. The value is
   * `isFilingBlocked(checks)` (`lib/reports/vat-filing-gate.ts`) computed once
   * in VatDeclarationView over the exact same check array that feeds the
   * "Kontroll av underlaget" banner and the stegen counters, so this button
   * can never be enabled while that section claims (or hides) a problem.
   * Never re-derive it here from a narrower source.
   */
  localBlocked: boolean
}

/**
 * One feedback slot: exactly one message at a time, replaced at the end of
 * each action. 'info' is for neutral lookups ("inget utkast hittades"):
 * rendering those as success taught users that green means nothing.
 */
interface Notice {
  kind: 'error' | 'success' | 'info'
  text: string
}

function isOrgNumberMissing(err: unknown): boolean {
  return err instanceof Error && err.message === 'Organisationsnummer saknas'
}

const SKV_ENABLED = ENABLED_EXTENSION_IDS.has('skatteverket')

export function SkatteverketPanel(props: SkatteverketPanelProps) {
  if (!SKV_ENABLED) return null
  return <SkatteverketPanelInner {...props} />
}

function SkatteverketPanelInner({
  periodType,
  year,
  period,
  fiscalPeriodId,
  fiscalYearEnd,
  hasData,
  localBlocked,
}: SkatteverketPanelProps) {
  // In yearly mode the year picker is replaced by the räkenskapsår selector,
  // so the `year` prop is stale (stuck at the current year). Every SKV call
  // must target the FY-end year instead.
  const effectiveYear = periodType === 'yearly' && fiscalYearEnd ? fiscalYearEnd.year : year
  const t = useTranslations('skatteverket_panel')
  const ORG_NUMBER_MISSING_NOTICE: Notice = { kind: 'error', text: t('org_number_missing') }
  /**
   * In-flight labels for actions with no visible button while running (the
   * overflow-menu actions close the menu on select): rendered as a status row
   * so a slow SKV round-trip is never silent.
   */
  const actionInFlightLabel = (action: string): string | null => {
    switch (action) {
      case 'validate': return t('in_flight_validate')
      case 'draft': return t('in_flight_draft')
      case 'lock': return t('in_flight_lock')
      case 'fetchDraft': return t('in_flight_fetch_draft')
      case 'check': return t('in_flight_check')
      case 'fetchDecided': return t('in_flight_fetch_decided')
      case 'unlock': return t('in_flight_unlock')
      case 'delete': return t('in_flight_delete')
      case 'disconnect': return t('in_flight_disconnect')
      default: return null
    }
  }
  const hasSkvCapability = useCapability(CAPABILITY.skatteverket)
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [status, setStatus] = useState<SkatteverketStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [kontroller, setKontroller] = useState<KontrollResult[]>([])
  const [signeringslank, setSigneringslank] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<{
    kvittensnummer?: string
    tidpunkt?: string
  } | null>(null)

  // Per-period SKV state resets when the picker changes (render-phase
  // adjustment): a signing link, kvittens, or kontrollresultat fetched for
  // one period must never render as if it belonged to another. Without this,
  // the visibilitychange auto-check could stamp "Deklarationen har lämnats
  // in" for a different period than the one being signed.
  const periodKey = `${periodType}:${effectiveYear}:${period}:${fiscalPeriodId ?? ''}`
  const [appliedPeriodKey, setAppliedPeriodKey] = useState(periodKey)
  if (appliedPeriodKey !== periodKey) {
    setAppliedPeriodKey(periodKey)
    setKontroller([])
    setSigneringslank(null)
    setSubmitted(null)
    setNotice(null)
  }

  /**
   * Apply an API JSON error result. When the error indicates the SKV session
   * has expired/been revoked/lost scope, immediately reflect that in the
   * local status so the "Förnya session" CTA appears next to the message:
   * the user shouldn't have to wait for /status to catch up.
   * Extension routes return a FLAT { error: string, code } shape, unlike the
   * core routes' nested envelope: do not unify the parsers.
   */
  const applyApiError = useCallback((result: { error?: string; code?: string } | null) => {
    if (!result?.error) return false
    setNotice({ kind: 'error', text: result.error })
    if (result.code && AUTH_RECONNECT_CODES.has(result.code)) {
      setStatus((prev) => prev ? { ...prev, expired: true } : prev)
    }
    return true
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/status')
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
      }
    } catch {
      // Extension might not be enabled
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()

    // Check URL params for OAuth callback results
    const params = new URLSearchParams(window.location.search)
    if (params.get('skv_connected') === 'true') {
      setNotice({ kind: 'success', text: t('connected_notice') })
      fetchStatus()
      // Clean URL
      const url = new URL(window.location.href)
      url.searchParams.delete('skv_connected')
      window.history.replaceState({}, '', url.toString())
    }
    const skvError = params.get('skv_error')
    if (skvError) {
      setNotice({ kind: 'error', text: decodeURIComponent(skvError) })
      const url = new URL(window.location.href)
      url.searchParams.delete('skv_error')
      window.history.replaceState({}, '', url.toString())
    }
  }, [fetchStatus, t])

  const handleConnect = () => {
    // return_to brings the user back to the momsdeklaration after the BankID
    // round-trip; the authorize route's default otherwise lands on the report
    // library. The callback appends skv_connected/skv_error itself.
    window.location.href =
      '/api/extensions/ext/skatteverket/authorize?return_to=' +
      encodeURIComponent('/reports/vat-declaration')
  }

  const handleDisconnect = async () => {
    setActionLoading('disconnect')
    setNotice(null)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/disconnect', {
        method: 'POST',
      })
      if (res.ok) {
        setStatus({ connected: false })
        setNotice(null)
        setKontroller([])
        setSigneringslank(null)
        setSubmitted(null)
      } else {
        const result = await res.json().catch(() => ({}))
        if (!applyApiError(result)) {
          setNotice({ kind: 'error', text: t('disconnect_failed_status', { status: res.status }) })
        }
      }
    } catch {
      setNotice({ kind: 'error', text: t('disconnect_failed') })
    } finally {
      setActionLoading(null)
    }
  }

  const handleValidate = async () => {
    if (localBlocked) {
      setNotice({ kind: 'error', text: t('blocked_before_send') })
      return
    }
    setActionLoading('validate')
    setNotice(null)
    setKontroller([])
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/declaration/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodType, year: effectiveYear, period, fiscalPeriodId }),
      })
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else {
        const controls: KontrollResult[] = result.data?.kontrollResultat?.resultat || []
        setKontroller(controls)
        if (controls.length === 0) {
          // SKV's OK only confirms arithmetic: it does NOT confirm that the
          // declaration is materially correct. We say so explicitly so the
          // user doesn't read this as a green light for actual filing.
          setNotice({
            kind: 'success',
            text: t('validate_ok'),
          })
        } else {
          const errors = controls.filter(k => k.status === 'ERROR')
          if (errors.length > 0) {
            setNotice({ kind: 'error', text: t('validation_errors_found', { count: errors.length }) })
          } else {
            setNotice({
              kind: 'success',
              text: t('validate_ok_with_warnings'),
            })
          }
        }
      }
    } catch {
      setNotice({ kind: 'error', text: t('validate_failed') })
    } finally {
      setActionLoading(null)
    }
  }

  const handleSaveDraft = async () => {
    if (localBlocked) {
      setNotice({ kind: 'error', text: t('blocked_before_draft') })
      return
    }
    setActionLoading('draft')
    setNotice(null)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/declaration/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodType, year: effectiveYear, period, fiscalPeriodId }),
      })
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else {
        const controls: KontrollResult[] = result.data?.kontrollResultat?.resultat || []
        setKontroller(controls)
        const errors = controls.filter(k => k.status === 'ERROR')
        if (errors.length === 0) {
          setNotice({ kind: 'success', text: t('draft_saved') })
        } else {
          setNotice({
            kind: 'error',
            text: t('draft_saved_with_errors', { count: errors.length }),
          })
        }
      }
    } catch {
      setNotice({ kind: 'error', text: t('draft_save_failed') })
    } finally {
      setActionLoading(null)
    }
  }

  // Redovisare from the session-cached settings row (lib/reference-data).
  // entity_type falls back to the company row, as /api/settings did.
  const { settings: companySettings } = useCompanySettings()
  const companyEntityType = useCompanyOptional()?.company?.entity_type ?? null
  const getRedovisare = useCallback(async (): Promise<string> => {
    const orgNumber = companySettings?.org_number
    if (!orgNumber) throw new Error('Organisationsnummer saknas')
    return formatRedovisare(orgNumber, companySettings?.entity_type ?? companyEntityType)
  }, [companySettings, companyEntityType])

  const getRedovisningsperiod = useCallback((): string => {
    return formatRedovisningsperiod(periodType, year, period, fiscalYearEnd)
  }, [periodType, year, period, fiscalYearEnd])

  const handleLock = async () => {
    setActionLoading('lock')
    setNotice(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/lock?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`,
        { method: 'PUT' }
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (result.data?.signeringsLank) {
        setSigneringslank(result.data.signeringsLank)
        setNotice({
          kind: 'success',
          text: t('lock_ok'),
        })
      }
    } catch (err) {
      setNotice(
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: t('lock_failed') },
      )
    } finally {
      setActionLoading(null)
    }
  }

  /**
   * One-click filing: the server chains kontrollera -> utkast -> lås and
   * returns the signing link. Stage-aware failures come back with a `stage`
   * discriminator: `validation` stopped before anything was written at SKV,
   * `lock` with `draft_saved` means the draft survives in Eget utrymme and
   * only the lock step needs a retry (available under Fler åtgärder).
   */
  const handleSubmit = async () => {
    if (localBlocked) {
      setNotice({ kind: 'error', text: t('blocked_before_send') })
      return
    }
    setActionLoading('submit')
    setNotice(null)
    setKontroller([])
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/declaration/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodType, year: effectiveYear, period, fiscalPeriodId }),
      })
      const result = await res.json()

      if (res.ok && result.data?.signeringsLank) {
        const controls: KontrollResult[] = result.data?.kontrollResultat?.resultat || []
        setKontroller(controls)
        setSigneringslank(result.data.signeringsLank)
        setNotice({
          kind: 'success',
          text: t('submit_ok'),
        })
        return
      }

      if (result.stage) {
        const controls: KontrollResult[] = result.kontrollResultat?.resultat || []
        if (controls.length > 0) setKontroller(controls)
        if (result.stage === 'validation') {
          setNotice({
            kind: 'error',
            text: result.error || t('submit_validation_failed'),
          })
        } else if (result.stage === 'lock' && result.draft_saved) {
          setNotice({
            kind: 'error',
            text: t('submit_lock_failed'),
          })
        } else {
          setNotice({
            kind: 'error',
            text: result.error || t('submit_failed'),
          })
        }
        return
      }

      if (!applyApiError(result)) {
        setNotice({
          kind: 'error',
          text: t('submit_failed'),
        })
      }
    } catch {
      setNotice({ kind: 'error', text: t('submit_failed') })
    } finally {
      setActionLoading(null)
    }
  }

  const handleUnlock = async () => {
    setActionLoading('unlock')
    setNotice(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/lock?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`,
        { method: 'DELETE' }
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else {
        setSigneringslank(null)
        setNotice({ kind: 'success', text: t('unlock_ok') })
      }
    } catch (err) {
      setNotice(
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: t('unlock_failed') },
      )
    } finally {
      setActionLoading(null)
    }
  }

  /**
   * `silent` suppresses the "inget hittades" notice: used by the automatic
   * re-check when the tab regains focus after the user signed at SKV, where
   * a recurring "nothing found" message would just be noise.
   */
  const handleCheckSubmitted = useCallback(async (silent = false) => {
    setActionLoading('check')
    setNotice(null)
    try {
      // periodType/year/period let the server complete the period's moms
      // deadline when the filing is confirmed.
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/submitted?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}&periodType=${periodType}&year=${effectiveYear}&period=${period}`
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (result.data) {
        setSubmitted(result.data)
        setNotice({ kind: 'success', text: t('submitted_ok') })
      } else if (!silent) {
        setNotice({ kind: 'info', text: t('submitted_none') })
      }
    } catch (err) {
      if (isOrgNumberMissing(err)) {
        setNotice({ kind: 'error', text: t('org_number_missing') })
      } else if (!silent) {
        setNotice({ kind: 'error', text: t('submitted_check_failed') })
      }
    } finally {
      setActionLoading(null)
    }
  }, [applyApiError, getRedovisare, getRedovisningsperiod, periodType, effectiveYear, period, t])

  // While a signing link is outstanding, re-check submission status when the
  // user returns to this tab: signing happens on Skatteverket's site, so the
  // return trip is the natural moment for the kvittens to appear.
  useEffect(() => {
    if (!signeringslank || submitted) return
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && actionLoading === null) {
        handleCheckSubmitted(true)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [signeringslank, submitted, actionLoading, handleCheckSubmitted])

  const handleDeleteDraft = async () => {
    setActionLoading('delete')
    setNotice(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/draft?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`,
        { method: 'DELETE' }
      )
      if (res.status === 204 || res.ok) {
        setKontroller([])
        setSigneringslank(null)
        setNotice({ kind: 'success', text: t('delete_ok') })
      } else {
        const result = await res.json().catch(() => ({}))
        if (!applyApiError(result)) {
          setNotice({ kind: 'error', text: t('delete_failed_status', { status: res.status }) })
        }
      }
    } catch (err) {
      setNotice(
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: t('delete_failed') },
      )
    } finally {
      setActionLoading(null)
    }
  }

  const handleFetchDraft = async () => {
    setActionLoading('fetchDraft')
    setNotice(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/draft?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (!result.data) {
        setNotice({ kind: 'info', text: t('fetch_draft_none') })
      } else {
        const locked = result.data?.locked ? t('fetch_draft_locked_suffix') : ''
        const summa = result.data?.momsuppgift?.summaMoms
        const summaLabel = summa !== undefined ? `, summaMoms = ${formatAmount(summa)}` : ''
        setNotice({ kind: 'success', text: t('fetch_draft_found', { locked, summa: summaLabel }) })
      }
    } catch (err) {
      setNotice(
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: t('fetch_draft_failed') },
      )
    } finally {
      setActionLoading(null)
    }
  }

  const handleFetchDecided = async () => {
    setActionLoading('fetchDecided')
    setNotice(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/decided?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}&periodType=${periodType}&year=${effectiveYear}&period=${period}`
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (!result.data) {
        setNotice({ kind: 'info', text: t('fetch_decided_none') })
      } else {
        const tid = result.data?.beslutadTidpunkt
        setNotice({
          kind: 'success',
          text: tid
            ? t('fetch_decided_found_on', { date: new Date(tid).toLocaleDateString('sv-SE') })
            : t('fetch_decided_found'),
        })
      }
    } catch (err) {
      setNotice(
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: t('fetch_decided_failed') },
      )
    } finally {
      setActionLoading(null)
    }
  }

  const handleDeleteDraftConfirmed = async () => {
    const ok = await confirm({
      title: t('delete_confirm_title'),
      description: t('delete_confirm_description'),
      confirmLabel: t('delete_confirm_label'),
    })
    if (!ok) return
    await handleDeleteDraft()
  }

  const handleDisconnectConfirmed = async () => {
    const ok = await confirm({
      title: t('disconnect_confirm_title'),
      description: t('disconnect_confirm_description'),
      confirmLabel: t('disconnect_confirm_label'),
    })
    if (!ok) return
    await handleDisconnect()
  }

  if (loading) {
    // The same silhouette as the report above it: a heading and rows, not a
    // block, so the page does not change shape twice while it loads.
    return (
      <section aria-busy>
        <div className="space-y-3">
          <Skeleton className="h-3 w-48" />
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center justify-between border-b border-border py-2">
              <Skeleton className="h-3.5 w-56" />
              <Skeleton className="h-3.5 w-20" />
            </div>
          ))}
        </div>
      </section>
    )
  }

  // Paywall: direct API submission is the paid convenience; manual filing at
  // skatteverket.se stays free and is owned by the "Lämna in" card above.
  // Rendered BEFORE the connected check so a company that connected during
  // trial sees the upsell instead of action buttons that would 403.
  if (!hasSkvCapability) {
    return (
      <section>
        <div className="mb-3">
          <h3 className="flex items-center gap-2 font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <FileCheck className="h-4 w-4" />
            {t('send_direct_optional')}
          </h3>
        </div>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('upgrade_body')}
          </p>
          <UpgradeNote>
            {t('upgrade_note')}
          </UpgradeNote>
        </div>
      </section>
    )
  }

  // Not connected. The momsdeklaration is already complete and can be filed
  // manually at skatteverket.se with no connection (the "Lämna in" card above
  // owns that path). Connecting is an optional convenience for submitting
  // directly from Accounted, so frame it that way.
  if (!status?.connected) {
    return (
      <section>
        <div className="mb-3">
          <h3 className="flex items-center gap-2 font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <FileCheck className="h-4 w-4" />
            {t('send_direct_optional')}
          </h3>
        </div>
        <div className="space-y-4">
          {notice?.kind === 'error' && (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded-lg p-3"
            >
              <AlertCircle className="h-4 w-4 mt-1 shrink-0" />
              <span>{notice.text}</span>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t('connect_body')}
          </p>
          <Button onClick={handleConnect} className="gap-2">
            <Link2 className="h-4 w-4" />
            {t('connect_button')}
          </Button>
        </div>
      </section>
    )
  }

  // Connected: show actions
  const hasErrors = kontroller.some(k => k.status === 'ERROR')

  return (
    <section>
      <div className="mb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <FileCheck className="h-4 w-4" />
            {t('send_direct')}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {/* Connected is the normal state here (the not-connected branch is
                a different section): muted text, never a chip. The expired
                session is the one exception and gets the attn sentence below
                instead of a badge-and-button cluster. */}
            {!status.expired && (
              <span className="text-xs text-muted-foreground">{t('connected')}</span>
            )}
            {/* Read-only lookups and recovery actions live in the overflow
                menu: the visible surface stays the forward path (validera,
                spara utkast, lås och signera). */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('more_actions')}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                {/* The demoted step-by-step actions: the visible surface is
                    the one-click "Skicka till Skatteverket" button; these
                    remain for partial retries (e.g. lock-only after a lock
                    failure) and for users who want to inspect each step. */}
                <DropdownMenuLabel>{t('menu_step_by_step')}</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={!hasData || localBlocked || actionLoading !== null}
                  onSelect={() => handleValidate()}
                >
                  <div>
                    <p>{t('menu_validate')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_validate_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasData || localBlocked || actionLoading !== null}
                  onSelect={() => handleSaveDraft()}
                >
                  <div>
                    <p>{t('menu_save_draft')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_save_draft_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasData || actionLoading !== null}
                  onSelect={() => handleLock()}
                >
                  <div>
                    <p>{t('menu_lock')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_lock_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('menu_status')}</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={actionLoading !== null}
                  onSelect={() => handleFetchDraft()}
                >
                  <div>
                    <p>{t('menu_fetch_draft')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_fetch_draft_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={actionLoading !== null}
                  onSelect={() => handleCheckSubmitted()}
                >
                  <div>
                    <p>{t('check_submission')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_check_submission_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={actionLoading !== null}
                  onSelect={() => handleFetchDecided()}
                >
                  <div>
                    <p>{t('menu_fetch_decided')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_fetch_decided_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('menu_recovery')}</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={actionLoading !== null}
                  onSelect={() => handleUnlock()}
                >
                  <div>
                    <p>{t('menu_unlock')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_unlock_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={actionLoading !== null}
                  onSelect={() => handleDeleteDraftConfirmed()}
                >
                  <div>
                    <p>{t('menu_delete_draft')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_delete_draft_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={actionLoading !== null}
                  onSelect={() => handleDisconnectConfirmed()}
                  className="text-destructive focus:text-destructive"
                >
                  <div>
                    <p>{t('menu_disconnect')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('menu_disconnect_hint')}
                    </p>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {status.expired && (
          <p className="mt-2 text-[12.5px] leading-5 text-attn">
            {t('session_expired')}{' '}
            <button
              type="button"
              onClick={handleConnect}
              className="underline underline-offset-2 hover:opacity-80"
            >
              {t('renew_with_bankid')}
            </button>
          </p>
        )}
      </div>
      <div className="space-y-4">
        {/* In-flight status for overflow-menu actions: their menu closes on
            select, so this row is the only visible sign of work. */}
        {actionLoading && actionInFlightLabel(actionLoading) && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {actionInFlightLabel(actionLoading)}
          </div>
        )}

        {/* Single feedback slot: errors are assertive alerts, success/info are
            polite status messages on the neutral surface. */}
        {notice && (
          notice.kind === 'error' ? (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded-lg p-3"
            >
              <AlertCircle className="h-4 w-4 mt-1 shrink-0" />
              <span>{notice.text}</span>
            </div>
          ) : (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 text-sm rounded-lg border border-border bg-muted/30 p-3"
            >
              {notice.kind === 'success' ? (
                <CheckCircle2 className="h-4 w-4 mt-1 shrink-0 text-success" />
              ) : (
                <Info className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" />
              )}
              <span>{notice.text}</span>
            </div>
          )
        )}

        {/* Validation results from Skatteverket */}
        {kontroller.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('validation_results_heading')}
            </h3>
            {kontroller.map((k, i) => (
              <div
                key={`${k.kod}-${i}`}
                className={`flex items-start gap-2 text-sm rounded-lg p-3 ${
                  k.status === 'ERROR'
                    ? 'bg-destructive/5 text-destructive'
                    : 'border border-border bg-muted/30'
                }`}
              >
                {k.status === 'ERROR' ? (
                  <ShieldAlert className="h-4 w-4 mt-1 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 mt-1 shrink-0 text-warning" />
                )}
                <div>
                  <span className="font-mono text-xs mr-2">{k.kod}</span>
                  {k.beskrivning}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Submitted confirmation */}
        {submitted && (
          <div className="rounded-lg border border-border p-3 space-y-1">
            <p className="text-sm font-medium flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" />
              {t('submitted_label')}
            </p>
            {submitted.kvittensnummer && (
              <p className="text-xs text-muted-foreground">
                {t('receipt_number_label')} <span className="font-mono">{submitted.kvittensnummer}</span>
              </p>
            )}
            {submitted.tidpunkt && (
              <p className="text-xs text-muted-foreground">
                {t('submitted_at', { time: new Date(submitted.tidpunkt).toLocaleString('sv-SE') })}
              </p>
            )}
          </div>
        )}

        {/* Signing link */}
        {signeringslank && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-sm font-medium">{t('signing_ready_title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('signing_ready_body')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild className="gap-2">
                <a href={signeringslank} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t('open_signing_page')}
                </a>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleCheckSubmitted()}
                disabled={actionLoading !== null}
                loading={actionLoading === 'check'}
              >
                {actionLoading !== 'check' && <CheckCircle2 className="mr-2 h-4 w-4" />}
                {t('check_submission')}
              </Button>
            </div>
          </div>
        )}

        {/* Forward lifecycle: one primary action. The individual steps live
            in the overflow menu under "Steg för steg". */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            onClick={handleSubmit}
            disabled={!hasData || localBlocked || actionLoading !== null}
            loading={actionLoading === 'submit'}
          >
            {actionLoading !== 'submit' && <Send className="mr-2 h-4 w-4" />}
            {t('submit_button')}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {t.rich('flow_explainer', {
            tip: (chunks) => (
              <InfoTooltip variant="help" content={t('eget_utrymme_tooltip')}>
                <span>{chunks}</span>
              </InfoTooltip>
            ),
          })}
        </p>

        {/* Visible disabled-state explanations: title attributes never show
            on disabled buttons. */}
        {localBlocked && (
          <p className="text-sm text-destructive">
            {t('blocked_before_submit')}
          </p>
        )}
        {hasErrors && !localBlocked && (
          <p className="text-sm text-muted-foreground">
            {t('validation_errors_block')}
          </p>
        )}
      </div>
      <DestructiveConfirmDialog {...dialogProps} />
    </section>
  )
}
