'use client'

import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import React, { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { InfoTooltip } from '@/components/ui/info-tooltip'

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
 * "Session utgången" badge + "Förnya session" button surface, even if the
 * upstream /status endpoint hasn't reflected the change yet.
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
  hasData: boolean
  /**
   * True when the local pre-flight checks (VatChecksCard, section 1 of the
   * page) found ERRORs. Blocks validate/submit: SKV only validates internal
   * arithmetic, so a locally broken declaration would pass their checks and
   * still be materially wrong.
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

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const ORG_NUMBER_MISSING_NOTICE: Notice = {
  kind: 'error',
  text: 'Organisationsnummer saknas. Ange det under Inställningar innan du använder Skatteverket-kopplingen.',
}

function isOrgNumberMissing(err: unknown): boolean {
  return err instanceof Error && err.message === 'Organisationsnummer saknas'
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

export function SkatteverketPanel(props: SkatteverketPanelProps) {
  if (!SKV_ENABLED) return null
  return <SkatteverketPanelInner {...props} />
}

function SkatteverketPanelInner({
  periodType,
  year,
  period,
  hasData,
  localBlocked,
}: SkatteverketPanelProps) {
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
  const periodKey = `${periodType}:${year}:${period}`
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
        body: JSON.stringify({ periodType, year, period }),
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
        body: JSON.stringify({ periodType, year, period }),
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

  // Helper to get redovisare from settings
  const getRedovisare = useCallback(async (): Promise<string> => {
    const res = await fetch('/api/settings')
    const { data } = await res.json()
    if (!data?.org_number) throw new Error('Organisationsnummer saknas')
    return formatRedovisare(data.org_number, data.entity_type)
  }, [])

  const getRedovisningsperiod = useCallback((): string => {
    return formatRedovisningsperiod(periodType, year, period)
  }, [periodType, year, period])

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
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: 'Kunde inte låsa utkastet' },
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
        body: JSON.stringify({ periodType, year, period }),
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
            text: result.error || 'Skatteverket hittade valideringsfel i deklarationen.',
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
            text: result.error || 'Kunde inte skicka deklarationen till Skatteverket',
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
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: 'Kunde inte låsa upp utkastet' },
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
        )}&redovisningsperiod=${getRedovisningsperiod()}&periodType=${periodType}&year=${year}&period=${period}`
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (result.data) {
        setSubmitted(result.data)
        setNotice({ kind: 'success', text: 'Deklarationen har lämnats in' })
      } else if (!silent) {
        setNotice({ kind: 'info', text: 'Ingen inlämnad deklaration hittades för denna period' })
      }
    } catch (err) {
      if (isOrgNumberMissing(err)) {
        setNotice(ORG_NUMBER_MISSING_NOTICE)
      } else if (!silent) {
        setNotice({ kind: 'error', text: 'Kunde inte kontrollera inlämningsstatus' })
      }
    } finally {
      setActionLoading(null)
    }
  }, [applyApiError, getRedovisare, getRedovisningsperiod, periodType, year, period])

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
        setNotice({ kind: 'success', text: 'Utkastet har raderats från Eget utrymme' })
      } else {
        const result = await res.json().catch(() => ({}))
        if (!applyApiError(result)) {
          setNotice({ kind: 'error', text: `Kunde inte radera utkast (${res.status})` })
        }
      }
    } catch (err) {
      setNotice(
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: 'Kunde inte radera utkast' },
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
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: 'Kunde inte hämta utkast' },
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
        )}&redovisningsperiod=${getRedovisningsperiod()}&periodType=${periodType}&year=${year}&period=${period}`
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
      }
    } catch (err) {
      setNotice(
        isOrgNumberMissing(err)
          ? ORG_NUMBER_MISSING_NOTICE
          : { kind: 'error', text: 'Kunde inte hämta beslutade uppgifter' },
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

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-24" />
        </CardContent>
      </Card>
    )
  }

  // Paywall: direct API submission is the paid convenience; manual filing at
  // skatteverket.se stays free and is owned by the "Lämna in" card above.
  // Rendered BEFORE the connected check so a company that connected during
  // trial sees the upsell instead of action buttons that would 403.
  if (!hasSkvCapability) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileCheck className="h-4 w-4" />
            Skicka direkt till Skatteverket (valfritt)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Med ett abonnemang kan du ansluta med BankID och skicka deklarationen
            direkt härifrån, samt validera, spara utkast och signera.
          </p>
          <UpgradeNote>
            Direktinlämning till Skatteverket kräver ett abonnemang.
          </UpgradeNote>
        </CardContent>
      </Card>
    )
  }

  // Not connected. The momsdeklaration is already complete and can be filed
  // manually at skatteverket.se with no connection (the "Lämna in" card above
  // owns that path). Connecting is an optional convenience for submitting
  // directly from Accounted, so frame it that way.
  if (!status?.connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileCheck className="h-4 w-4" />
            Skicka direkt till Skatteverket (valfritt)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
            Vill du slippa skriva in siffrorna själv kan du ansluta med BankID och
            skicka deklarationen direkt härifrån, samt validera, spara utkast och
            signera.
          </p>
          <Button onClick={handleConnect} className="gap-2">
            <Link2 className="h-4 w-4" />
            Anslut med BankID
          </Button>
        </CardContent>
      </Card>
    )
  }

  // Connected: show actions
  const hasErrors = kontroller.some(k => k.status === 'ERROR')

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileCheck className="h-4 w-4" />
            Skicka direkt till Skatteverket
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Ansluten
            </Badge>
            {status.expired && (
              <>
                <Badge variant="destructive" className="gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Session utgången
                </Badge>
                <Button variant="outline" onClick={handleConnect} className="gap-2">
                  <Link2 className="h-4 w-4" />
                  Förnya session
                </Button>
              </>
            )}
            {/* Read-only lookups and recovery actions live in the overflow
                menu: the visible surface stays the forward path (validera,
                spara utkast, lås och signera). */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Fler åtgärder">
                  <MoreHorizontal className="h-4 w-4" />
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
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* In-flight status for overflow-menu actions: their menu closes on
            select, so this row is the only visible sign of work. */}
        {actionLoading && ACTION_IN_FLIGHT_LABELS[actionLoading] && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
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
            <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
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
              Inlämnad
            </p>
            {submitted.kvittensnummer && (
              <p className="text-xs text-muted-foreground">
                Kvittensnummer: <span className="font-mono">{submitted.kvittensnummer}</span>
              </p>
            )}
            {submitted.tidpunkt && (
              <p className="text-xs text-muted-foreground">
                Tidpunkt: {new Date(submitted.tidpunkt).toLocaleString('sv-SE')}
              </p>
            )}
          </div>
        )}

        {/* Signing link */}
        {signeringslank && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-sm font-medium">Utkastet är låst och redo att signeras</p>
            <p className="text-xs text-muted-foreground">
              Öppna länken nedan och signera med BankID på Skatteverkets sida. När du
              kommer tillbaka hit kontrolleras inlämningen automatiskt.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild className="gap-2">
                <a href={signeringslank} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Öppna signeringssidan
                </a>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleCheckSubmitted()}
                disabled={actionLoading !== null}
                className="gap-2"
              >
                {actionLoading === 'check' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Kontrollera inlämning
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
            className="gap-2"
          >
            {actionLoading === 'submit' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Skicka till Skatteverket
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Deklarationen kontrolleras, sparas som utkast i{' '}
          <InfoTooltip
            variant="help"
            content="Ditt företags privata yta hos Skatteverket. Utkast som sparas där räknas inte som inlämnade förrän de har signerats med BankID."
          >
            <span>Eget utrymme</span>
          </InfoTooltip>{' '}
          och låses för signering med BankID hos Skatteverket. Inget lämnas in
          förrän du har signerat.
        </p>

        {/* Visible disabled-state explanations: title attributes never show
            on disabled buttons. */}
        {localBlocked && (
          <p className="text-sm text-destructive">
            Åtgärda felen under Kontroll av underlaget högst upp på sidan innan du
            skickar in.
          </p>
        )}
        {hasErrors && !localBlocked && (
          <p className="text-sm text-muted-foreground">
            Valideringsfelen ovan måste åtgärdas innan deklarationen kan lämnas in.
          </p>
        )}
      </CardContent>
      <DestructiveConfirmDialog {...dialogProps} />
    </Card>
  )
}
