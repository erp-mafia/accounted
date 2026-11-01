'use client'

import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import React, { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { useCompanySettings } from '@/lib/reference-data/hooks'
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
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  EllipsisHorizontalIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  LinkIcon,
  PaperAirplaneIcon,
  ShieldExclamationIcon,
  SpinnerIcon,
} from '@/components/icons'
import type { VatPeriodType } from '@/types'
import { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'
import { FilingIdentityError } from '@/lib/invariants/org-number'
import { useCapability, useCompanyOptional } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { formatAmount } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'

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
  /**
   * The rest of "Lämna in" (Ladda ner, Markera som inlämnad or the filed
   * line), rendered after the panel's own primary action so the step is one
   * action row. Rendered on its own when the extension is not enabled.
   */
  actions?: React.ReactNode
  /** The step's single "?" (convention 7), last in the row. */
  help?: React.ReactNode
  /**
   * Called when Skatteverket confirms the period as filed (a kvittens or a
   * beslut was found): the server records the filing, and the owner
   * refetches its filing records so the row stops offering "Markera som
   * inlämnad".
   */
  onFilingConfirmed?: () => void
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

const ORG_NUMBER_MISSING_NOTICE: Notice = {
  kind: 'error',
  text: 'Organisationsnummer saknas. Ange det under Inställningar innan du använder Skatteverket-kopplingen.',
}

/** What the panel says when getRedovisare refused, or null for any other failure. */
function redovisareNotice(err: unknown): Notice | null {
  if (err instanceof FilingIdentityError) return { kind: 'error', text: err.message }
  return err instanceof Error && err.message === 'Organisationsnummer saknas' ? ORG_NUMBER_MISSING_NOTICE : null
}

/**
 * In-flight labels for actions with no visible button while running (the
 * overflow-menu actions close the menu on select): rendered as a status row
 * so a slow SKV round-trip is never silent.
 */
const ACTION_IN_FLIGHT_LABELS: Record<string, string> = {
  validate: 'Validerar deklarationen...',
  draft: 'Sparar utkast...',
  lock: 'Låser utkastet...',
  fetchDraft: 'Hämtar utkast...',
  check: 'Kontrollerar inlämning...',
  fetchDecided: 'Hämtar beslut...',
  unlock: 'Låser upp...',
  delete: 'Raderar utkast...',
  disconnect: 'Kopplar bort Skatteverket...',
}

const SKV_ENABLED = ENABLED_EXTENSION_IDS.has('skatteverket')

/** Whether direct filing exists in this build (the skatteverket extension). */
export const SKATTEVERKET_DIRECT_FILING = SKV_ENABLED

/** "Lämna in" as one row: the primary action, then the step's own actions. */
function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

export function SkatteverketPanel(props: SkatteverketPanelProps) {
  if (!SKV_ENABLED) {
    // Core build: no direct filing, but the step's own actions still form
    // the row.
    if (!props.actions && !props.help) return null
    return (
      <ActionRow>
        {props.actions}
        {props.help}
      </ActionRow>
    )
  }
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
  actions,
  help,
  onFilingConfirmed,
}: SkatteverketPanelProps) {
  // In yearly mode the year picker is replaced by the räkenskapsår selector,
  // so the `year` prop is stale (stuck at the current year). Every SKV call
  // must target the FY-end year instead.
  const effectiveYear = periodType === 'yearly' && fiscalYearEnd ? fiscalYearEnd.year : year
  const hasSkvCapability = useCapability(CAPABILITY.skatteverket)
  const tSigning = useTranslations('skv_signing')
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
   * The Skatteverket routes answer a FLAT { error: string, code }, shown
   * verbatim; the dispatcher in front of them refuses with the nested envelope
   * (a viewer's read-only refusal), and `text` is rendered, so an object here
   * takes the whole page down.
   */
  const applyApiError = useCallback((result: { error?: unknown; code?: string } | null) => {
    if (!result?.error) return false
    setNotice({ kind: 'error', text: typeof result.error === 'string' ? result.error : getErrorMessage(result) })
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
      setNotice({ kind: 'success', text: 'Ansluten till Skatteverket' })
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
  }, [fetchStatus])

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
          setNotice({ kind: 'error', text: `Kunde inte koppla bort (${res.status})` })
        }
      }
    } catch {
      setNotice({ kind: 'error', text: 'Kunde inte koppla bort' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleValidate = async () => {
    if (localBlocked) {
      setNotice({
        kind: 'error',
        text:
          'Åtgärda felen under Kontroll av underlaget högst upp på sidan innan ' +
          'du skickar till Skatteverket.',
      })
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
            text:
              'Skatteverket har inga tekniska invändningar mot deklarationen. ' +
              'Kontrollera siffrorna i förhandsgranskningen innan du skickar in.',
          })
        } else {
          const errors = controls.filter(k => k.status === 'ERROR')
          if (errors.length > 0) {
            setNotice({ kind: 'error', text: `${errors.length} valideringsfel hittades` })
          } else {
            setNotice({
              kind: 'success',
              text: 'Skatteverket har inga tekniska invändningar (med varningar)',
            })
          }
        }
      }
    } catch {
      setNotice({ kind: 'error', text: 'Kunde inte validera deklarationen' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleSaveDraft = async () => {
    if (localBlocked) {
      setNotice({
        kind: 'error',
        text:
          'Åtgärda felen under Kontroll av underlaget högst upp på sidan innan ' +
          'du sparar utkastet hos Skatteverket.',
      })
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
          setNotice({ kind: 'success', text: 'Utkast sparat i Eget utrymme hos Skatteverket' })
        } else {
          setNotice({
            kind: 'error',
            text: `Utkastet sparades men har ${errors.length} valideringsfel`,
          })
        }
      }
    } catch {
      setNotice({ kind: 'error', text: 'Kunde inte spara utkast' })
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
          text: 'Utkastet är låst. Öppna signeringslänken för att signera med BankID.',
        })
      }
    } catch (err) {
      setNotice(
        redovisareNotice(err) ?? { kind: 'error', text: 'Kunde inte låsa utkastet' },
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
      setNotice({
        kind: 'error',
        text:
          'Åtgärda felen under Kontroll av underlaget högst upp på sidan innan ' +
          'du skickar till Skatteverket.',
      })
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
          text:
            'Deklarationen är kontrollerad, sparad och låst. Öppna signeringslänken ' +
            'för att signera med BankID.',
        })
        return
      }

      if (result.stage) {
        const controls: KontrollResult[] = result.kontrollResultat?.resultat || []
        if (controls.length > 0) setKontroller(controls)
        if (result.stage === 'validation') {
          setNotice({
            kind: 'error',
            text: getErrorMessage(result, { fallback: 'Skatteverket hittade valideringsfel i deklarationen.' }),
          })
        } else if (result.stage === 'lock' && result.draft_saved) {
          setNotice({
            kind: 'error',
            text:
              'Utkastet är sparat hos Skatteverket men kunde inte låsas för signering. ' +
              'Försök igen med "Lås och signera" under Fler åtgärder.',
          })
        } else {
          setNotice({
            kind: 'error',
            text: getErrorMessage(result, { fallback: 'Kunde inte skicka deklarationen till Skatteverket' }),
          })
        }
        return
      }

      if (!applyApiError(result)) {
        setNotice({
          kind: 'error',
          text: 'Kunde inte skicka deklarationen till Skatteverket',
        })
      }
    } catch {
      setNotice({ kind: 'error', text: 'Kunde inte skicka deklarationen till Skatteverket' })
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
        setNotice({ kind: 'success', text: 'Utkastet har låsts upp' })
      }
    } catch (err) {
      setNotice(
        redovisareNotice(err) ?? { kind: 'error', text: 'Kunde inte låsa upp utkastet' },
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
        setNotice({ kind: 'success', text: 'Deklarationen har lämnats in' })
        onFilingConfirmed?.()
      } else if (!silent) {
        setNotice({ kind: 'info', text: 'Ingen inlämnad deklaration hittades för denna period' })
      }
    } catch (err) {
      const notice = redovisareNotice(err)
      if (notice) {
        setNotice(notice)
      } else if (!silent) {
        setNotice({ kind: 'error', text: 'Kunde inte kontrollera inlämningsstatus' })
      }
    } finally {
      setActionLoading(null)
    }
  }, [applyApiError, getRedovisare, getRedovisningsperiod, periodType, effectiveYear, period, onFilingConfirmed])

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

  // A declaration locked for signing elsewhere (an approved
  // submit_vat_declaration in /pending, or before a reload) waits here with
  // its signing link until the kvittens cron sees it filed (crm#1478). Keyed
  // on the period string: a fresh fiscalYearEnd object must not refetch.
  const storedStatePeriod = getRedovisningsperiod()
  useEffect(() => {
    if (!hasSkvCapability) return
    let ignore = false
    fetch(`/api/extensions/ext/skatteverket/declaration/signing?redovisningsperiod=${storedStatePeriod}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { signeringsLank?: unknown } | null } | null) => {
        const link = json?.data?.signeringsLank
        if (!ignore && typeof link === 'string') setSigneringslank((current) => current ?? link)
      })
      .catch(() => {
        // Best effort: without the stored state the panel shows what it did before.
      })
    return () => {
      ignore = true
    }
  }, [hasSkvCapability, storedStatePeriod])

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
        setNotice({ kind: 'success', text: 'Utkastet har raderats från Eget utrymme' })
      } else {
        const result = await res.json().catch(() => ({}))
        if (!applyApiError(result)) {
          setNotice({ kind: 'error', text: `Kunde inte radera utkast (${res.status})` })
        }
      }
    } catch (err) {
      setNotice(
        redovisareNotice(err) ?? { kind: 'error', text: 'Kunde inte radera utkast' },
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
        setNotice({ kind: 'info', text: 'Inget sparat utkast hittades för perioden' })
      } else {
        const locked = result.data?.locked ? ' (låst)' : ''
        const summa = result.data?.momsuppgift?.summaMoms
        const summaLabel = summa !== undefined ? `, summaMoms = ${formatAmount(summa)}` : ''
        setNotice({ kind: 'success', text: `Sparat utkast hittades${locked}${summaLabel}` })
      }
    } catch (err) {
      setNotice(
        redovisareNotice(err) ?? { kind: 'error', text: 'Kunde inte hämta utkast' },
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
        setNotice({ kind: 'info', text: 'Inget beslut hittades för perioden' })
      } else {
        const tid = result.data?.beslutadTidpunkt
        const tidLabel = tid ? ` (beslutad ${new Date(tid).toLocaleDateString('sv-SE')})` : ''
        setNotice({ kind: 'success', text: `Beslut hittades${tidLabel}` })
        onFilingConfirmed?.()
      }
    } catch (err) {
      setNotice(
        redovisareNotice(err) ?? { kind: 'error', text: 'Kunde inte hämta beslutade uppgifter' },
      )
    } finally {
      setActionLoading(null)
    }
  }

  const handleDeleteDraftConfirmed = async () => {
    const ok = await confirm({
      title: 'Radera utkastet hos Skatteverket?',
      description:
        'Utkastet tas bort från Eget utrymme hos Skatteverket. Detta går inte att ångra.',
      confirmLabel: 'Radera utkast',
    })
    if (!ok) return
    await handleDeleteDraft()
  }

  const handleDisconnectConfirmed = async () => {
    const ok = await confirm({
      title: 'Koppla bort Skatteverket?',
      description:
        'Anslutningen tas bort och du behöver ansluta med BankID igen för att kunna skicka direkt.',
      confirmLabel: 'Koppla bort',
    })
    if (!ok) return
    await handleDisconnect()
  }

  const signingBlock = signeringslank ? (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
      <p className="text-sm font-medium">{tSigning('awaiting_title')}</p>
      <p className="text-xs text-muted-foreground">
        Öppna länken nedan och signera med BankID på Skatteverkets sida. När du
        kommer tillbaka hit kontrolleras inlämningen automatiskt.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild className="gap-2">
          <a href={signeringslank} target="_blank" rel="noopener noreferrer">
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            {tSigning('sign_action')}
          </a>
        </Button>
        <Button
          variant="outline"
          onClick={() => handleCheckSubmitted()}
          disabled={actionLoading !== null}
          loading={actionLoading === 'check'}
        >
          {actionLoading !== 'check' && <CheckCircleIcon className="mr-2 h-4 w-4" />}
          Kontrollera inlämning
        </Button>
      </div>
    </div>
  ) : null

  if (loading) {
    // The primary action's silhouette in the row, so the row does not change
    // shape once the connection status lands.
    return (
      <section aria-busy>
        <ActionRow>
          <Skeleton className="h-8 w-44 rounded-full" />
          {actions}
          {help}
        </ActionRow>
      </section>
    )
  }

  // Paywall: direct API submission is the paid convenience; manual filing at
  // skatteverket.se stays free (Ladda ner in the same row). Rendered BEFORE
  // the connected check so a company that connected during trial sees the
  // upsell instead of action buttons that would 403. The action stays on
  // screen, disabled, with the note saying why (UpgradeNote's contract).
  if (!hasSkvCapability) {
    return (
      <section className="space-y-3">
        <ActionRow>
          <Button size="sm" disabled className="gap-2">
            <PaperAirplaneIcon className="h-4 w-4" />
            Skicka till Skatteverket
          </Button>
          {actions}
          {help}
        </ActionRow>
        <UpgradeNote>
          Direktinlämning till Skatteverket kräver ett abonnemang.
        </UpgradeNote>
      </section>
    )
  }

  // Not connected. The momsdeklaration can be filed manually with no
  // connection (Ladda ner in the same row); connecting is an optional
  // convenience for submitting directly from Accounted. Why and how lives
  // behind the step's "?".
  if (!status?.connected) {
    return (
      <section className="space-y-3">
        <ActionRow>
          <Button size="sm" onClick={handleConnect} className="gap-2">
            <LinkIcon className="h-4 w-4" />
            Anslut med BankID
          </Button>
          {actions}
          {help}
        </ActionRow>
        {/* Signing needs no connection here: it happens at Skatteverket. */}
        {signingBlock}
        {notice?.kind === 'error' && (
          <div
            role="alert"
            className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded-lg p-3"
          >
            <ExclamationCircleIcon className="h-4 w-4 mt-1 shrink-0" />
            <span>{notice.text}</span>
          </div>
        )}
      </section>
    )
  }

  // Connected: show actions
  const hasErrors = kontroller.some(k => k.status === 'ERROR')

  return (
    <section className="space-y-4">
      <div>
        {/* Forward lifecycle: one primary action, then the step's own
            actions. The individual steps, read-only lookups and recovery
            live in the overflow menu; what Skicka does is behind the step's
            "?". Connected is the normal state, so it is not announced; the
            expired session is the exception and gets the attn sentence. */}
        <ActionRow>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!hasData || localBlocked || actionLoading !== null}
            loading={actionLoading === 'submit'}
          >
            {actionLoading !== 'submit' && <PaperAirplaneIcon className="mr-2 h-4 w-4" />}
            Skicka till Skatteverket
          </Button>
          {actions}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Fler åtgärder">
                <EllipsisHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              {/* The demoted step-by-step actions: the visible surface is
                  the one-click "Skicka till Skatteverket" button; these
                  remain for partial retries (e.g. lock-only after a lock
                  failure) and for users who want to inspect each step. */}
              <DropdownMenuLabel>Steg för steg</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!hasData || localBlocked || actionLoading !== null}
                onSelect={() => handleValidate()}
              >
                <div>
                  <p>Validera</p>
                  <p className="text-xs text-muted-foreground">
                    Kontrollera deklarationen hos Skatteverket utan att spara
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!hasData || localBlocked || actionLoading !== null}
                onSelect={() => handleSaveDraft()}
              >
                <div>
                  <p>Spara utkast</p>
                  <p className="text-xs text-muted-foreground">
                    Spara deklarationen som utkast i Eget utrymme
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!hasData || actionLoading !== null}
                onSelect={() => handleLock()}
              >
                <div>
                  <p>Lås och signera</p>
                  <p className="text-xs text-muted-foreground">
                    Lås det sparade utkastet och hämta signeringslänken
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Status hos Skatteverket</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={actionLoading !== null}
                onSelect={() => handleFetchDraft()}
              >
                <div>
                  <p>Hämta utkast</p>
                  <p className="text-xs text-muted-foreground">
                    Hämta sparat utkast från Eget utrymme
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={actionLoading !== null}
                onSelect={() => handleCheckSubmitted()}
              >
                <div>
                  <p>Kontrollera inlämning</p>
                  <p className="text-xs text-muted-foreground">
                    Kontrollera om en signerad deklaration har lämnats in
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={actionLoading !== null}
                onSelect={() => handleFetchDecided()}
              >
                <div>
                  <p>Hämta beslut</p>
                  <p className="text-xs text-muted-foreground">
                    Hämta Skatteverkets beslut för perioden
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Återställning</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={actionLoading !== null}
                onSelect={() => handleUnlock()}
              >
                <div>
                  <p>Lås upp</p>
                  <p className="text-xs text-muted-foreground">
                    Lås upp en låst period så att utkastet kan ändras
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={actionLoading !== null}
                onSelect={() => handleDeleteDraftConfirmed()}
              >
                <div>
                  <p>Radera utkast...</p>
                  <p className="text-xs text-muted-foreground">
                    Radera sparat utkast från Eget utrymme
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
                  <p>Koppla bort Skatteverket...</p>
                  <p className="text-xs text-muted-foreground">
                    Kräver ny BankID-anslutning för direktinlämning
                  </p>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {help}
        </ActionRow>
        {status.expired && (
          <p className="mt-2 text-[12.5px] leading-5 text-attn">
            Sessionen mot Skatteverket har gått ut.{' '}
            <button
              type="button"
              onClick={handleConnect}
              className="underline underline-offset-2 hover:opacity-80"
            >
              Förnya med BankID
            </button>
          </p>
        )}
      </div>
      <div className="space-y-4">
        {/* In-flight status for overflow-menu actions: their menu closes on
            select, so this row is the only visible sign of work. */}
        {actionLoading && ACTION_IN_FLIGHT_LABELS[actionLoading] && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <SpinnerIcon className="h-4 w-4 animate-spin" />
            {ACTION_IN_FLIGHT_LABELS[actionLoading]}
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
              <ExclamationCircleIcon className="h-4 w-4 mt-1 shrink-0" />
              <span>{notice.text}</span>
            </div>
          ) : (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 text-sm rounded-lg border border-border bg-muted/30 p-3"
            >
              {notice.kind === 'success' ? (
                <CheckCircleIcon className="h-4 w-4 mt-1 shrink-0 text-success" />
              ) : (
                <InformationCircleIcon className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" />
              )}
              <span>{notice.text}</span>
            </div>
          )
        )}

        {/* Validation results from Skatteverket */}
        {kontroller.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Skatteverkets valideringsresultat
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
                  <ShieldExclamationIcon className="h-4 w-4 mt-1 shrink-0" />
                ) : (
                  <ExclamationTriangleIcon className="h-4 w-4 mt-1 shrink-0 text-warning" />
                )}
                <div>
                  <span className="font-mono text-xs mr-2">{k.kod}</span>
                  {k.beskrivning}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Submitted confirmation: a normal state, so muted text (convention
            12), never a green box. */}
        {submitted && (
          <p role="status" className="text-[13px] leading-5 text-muted-foreground tabular-nums">
            Inlämnad
            {submitted.tidpunkt && ` ${new Date(submitted.tidpunkt).toLocaleString('sv-SE')}`}
            {submitted.kvittensnummer && (
              <>
                {' · kvittens '}
                <span className="font-mono">{submitted.kvittensnummer}</span>
              </>
            )}
          </p>
        )}

        {/* Signing link */}
        {signingBlock}

        {/* Visible disabled-state explanations: title attributes never show
            on disabled buttons. */}
        {localBlocked && (
          <p className="text-sm text-destructive">
            Åtgärda felen under steg 1, Kontrollera, innan du skickar in.
          </p>
        )}
        {hasErrors && !localBlocked && (
          <p className="text-sm text-muted-foreground">
            Valideringsfelen ovan måste åtgärdas innan deklarationen kan lämnas in.
          </p>
        )}
      </div>
      <DestructiveConfirmDialog {...dialogProps} />
    </section>
  )
}
